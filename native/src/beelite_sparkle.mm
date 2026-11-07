// 蜂简客户端更新原生桥：官方 Sparkle 2.9.6 公开 API + Node-API（C 接口）。
//
// 只提供五个固定操作：init / probe / beginUpdate / installNow / cancel。
// - probe：checkForUpdateInformation，只探测，不下载。
// - beginUpdate：本次会话授权（g_authorized）后发起用户检查；只有授权内，driver 才对“发现更新”回复 Install（即开始下载）。
// - 下载、EdDSA 验签、解压完成后（或会话发现更新已处于 Installing 阶段时），driver 持有安装回复，不自行安装；
//   由 JS 排空写操作后调用 installNow。回复策略见 bl_policy.h。
// - cancel：只在确有取消手段时生效（持有的安装回复以 Skip 取消、下载取消块、用户检查取消块）；解压阶段无法取消。
// 所有 Sparkle 调用都在主线程；事件经线程安全函数回到 JS，环境清理时释放并停止派发。
#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>
#include "bl_policy.h"

static napi_threadsafe_function g_tsfn = NULL;
static BOOL g_closing = NO;
static BOOL g_authorized = NO;
static SPUUpdater *g_updater = nil;
static id g_driver = nil;
static id g_delegate = nil;
/** 持有的安装回复：来自“准备安装”，或来自 Installing 阶段的“发现更新”；只调用一次 */
static void (^g_readyReply)(SPUUserUpdateChoice) = nil;
static void (^g_downloadCancel)(void) = nil;
static void (^g_checkCancel)(void) = nil;
static uint64_t g_expected = 0;
static uint64_t g_received = 0;
static CFAbsoluteTime g_lastProgress = 0;

// ---------- 事件派发 ----------

static void CallJs(napi_env env, napi_value jsCallback, void *context, void *data) {
  char *json = (char *)data;
  if (env != NULL && jsCallback != NULL && json != NULL) {
    napi_value arg;
    if (napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &arg) == napi_ok) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      napi_call_function(env, undefined, jsCallback, 1, &arg, NULL);
    }
  }
  free(json);
}

static void Emit(NSDictionary *payload) {
  if (g_closing || g_tsfn == NULL) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (data == nil) return;
  char *json = (char *)malloc(data.length + 1);
  if (json == NULL) return;
  memcpy(json, data.bytes, data.length);
  json[data.length] = '\0';
  if (napi_call_threadsafe_function(g_tsfn, json, napi_tsfn_nonblocking) != napi_ok) free(json);
}

static NSString *ErrorMessage(NSError *error) {
  if (error == nil) return @"未知错误";
  return error.localizedDescription.length > 0 ? error.localizedDescription : [NSString stringWithFormat:@"%@ %ld", error.domain, (long)error.code];
}

static NSString *CheckName(SPUUpdateCheck check) {
  switch (check) {
    case SPUUpdateCheckUpdates: return @"user";
    case SPUUpdateCheckUpdatesInBackground: return @"background";
    case SPUUpdateCheckUpdateInformation: return @"probe";
  }
  return @"user";
}

static SPUUserUpdateChoice ChoiceFor(bl_action action) {
  switch (action) {
    case BL_REPLY_INSTALL: return SPUUserUpdateChoiceInstall;
    case BL_REPLY_SKIP: return SPUUserUpdateChoiceSkip;
    default: return SPUUserUpdateChoiceDismiss;
  }
}

static bl_stage StageOf(SPUUserUpdateState *state) {
  switch (state.stage) {
    case SPUUserUpdateStageDownloaded: return BL_STAGE_DOWNLOADED;
    case SPUUserUpdateStageInstalling: return BL_STAGE_INSTALLING;
    default: return BL_STAGE_NOT_DOWNLOADED;
  }
}

static void ClearSession(void) {
  g_authorized = NO;
  g_readyReply = nil;
  g_downloadCancel = nil;
  g_checkCancel = nil;
}

// ---------- 委托 ----------

@interface BeeLiteUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@end

@implementation BeeLiteUpdaterDelegate
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
  Emit(@{@"type" : @"valid-update", @"version" : item.versionString ?: @"", @"displayVersion" : item.displayVersionString ?: @""});
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
  Emit(@{@"type" : @"no-update"});
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)updateCheck error:(nullable NSError *)error {
  NSMutableDictionary *p = [@{@"type" : @"cycle-finished", @"check" : CheckName(updateCheck)} mutableCopy];
  if (error != nil) {
    p[@"errorCode"] = @(error.code);
    p[@"error"] = ErrorMessage(error);
  }
  if (updateCheck == SPUUpdateCheckUpdates) ClearSession();
  Emit(p);
}
@end

// ---------- 用户界面驱动（不显示任何 Sparkle 窗口，状态交给 Electron 界面） ----------

@interface BeeLiteUserDriver : NSObject <SPUUserDriver>
@end

@implementation BeeLiteUserDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  // 不开启 Sparkle 自带的定时检查；检查时机由应用自己控制且只探测
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  g_checkCancel = [cancellation copy];
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)appcastItem state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  g_checkCancel = nil;
  bl_action action = bl_update_found_action(g_authorized, appcastItem.informationOnlyUpdate, StageOf(state));
  BOOL allowed = action == BL_REPLY_INSTALL || action == BL_HOLD;
  Emit(@{@"type" : @"update-found", @"authorized" : @(allowed), @"version" : appcastItem.versionString ?: @"", @"displayVersion" : appcastItem.displayVersionString ?: @""});
  if (action == BL_HOLD) {
    // 已处于 Installing 阶段：回复 Install 会立即退出重启，必须先交给主进程排空写操作
    g_readyReply = [reply copy];
    Emit(@{@"type" : @"ready"});
    return;
  }
  reply(ChoiceFor(action));
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {
}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  ClearSession();
  Emit(@{@"type" : @"not-found"});
  acknowledgement();
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  ClearSession();
  Emit(@{@"type" : @"error", @"message" : ErrorMessage(error), @"code" : @(error.code)});
  acknowledgement();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  g_downloadCancel = [cancellation copy];
  g_expected = 0;
  g_received = 0;
  g_lastProgress = 0;
  Emit(@{@"type" : @"download-start"});
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)expectedContentLength {
  g_expected = expectedContentLength;
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
  g_received += length;
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (now - g_lastProgress < 0.2 && g_received < g_expected) return;
  g_lastProgress = now;
  Emit(@{@"type" : @"download-progress", @"received" : @(g_received), @"total" : @(g_expected)});
}
- (void)showDownloadDidStartExtractingUpdate {
  g_downloadCancel = nil;
  Emit(@{@"type" : @"extracting"});
}
- (void)showExtractionReceivedProgress:(double)progress {
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (now - g_lastProgress < 0.2 && progress < 1.0) return;
  g_lastProgress = now;
  Emit(@{@"type" : @"extracting", @"percent" : @(MIN(100.0, MAX(0.0, progress * 100.0)))});
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  bl_action action = bl_ready_action(g_authorized);
  if (action != BL_HOLD) {
    // 非本次授权的待安装更新（例如上次会话残留）：取消本次安装，不永久跳过
    reply(ChoiceFor(action));
    return;
  }
  g_readyReply = [reply copy];
  Emit(@{@"type" : @"ready"});
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)applicationTerminated retryTerminatingApplication:(void (^)(void))retryTerminatingApplication {
  Emit(@{@"type" : @"installing"});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
  acknowledgement();
}
- (void)showUpdateInFocus {
}
- (void)dismissUpdateInstallation {
  g_downloadCancel = nil;
  g_checkCancel = nil;
  g_readyReply = nil;
  Emit(@{@"type" : @"dismissed"});
}
@end

// ---------- Node-API ----------

static napi_value Bool(napi_env env, bool v) {
  napi_value r;
  napi_get_boolean(env, v, &r);
  return r;
}

static napi_value Result(napi_env env, bool ok, NSString *error) {
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "ok", Bool(env, ok));
  if (error != nil) {
    napi_value s;
    napi_create_string_utf8(env, error.UTF8String, NAPI_AUTO_LENGTH, &s);
    napi_set_named_property(env, obj, "error", s);
  }
  return obj;
}

static void Cleanup(void *arg) {
  g_closing = YES;
  if (g_tsfn != NULL) {
    napi_release_threadsafe_function(g_tsfn, napi_tsfn_abort);
    g_tsfn = NULL;
  }
}

static napi_value Init(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Result(env, false, @"必须在主线程初始化");
  if (g_updater != nil) return Result(env, false, @"已经初始化");
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_valuetype t;
  if (argc < 1 || napi_typeof(env, argv[0], &t) != napi_ok || t != napi_function) return Result(env, false, @"缺少事件回调");
  napi_value name;
  napi_create_string_utf8(env, "beelite-sparkle-events", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL, CallJs, &g_tsfn) != napi_ok) {
    return Result(env, false, @"无法创建事件通道");
  }
  // 不让事件通道阻止进程退出
  napi_unref_threadsafe_function(env, g_tsfn);
  napi_add_env_cleanup_hook(env, Cleanup, NULL);

  @try {
    NSBundle *bundle = [NSBundle mainBundle];
    g_driver = [[BeeLiteUserDriver alloc] init];
    g_delegate = [[BeeLiteUpdaterDelegate alloc] init];
    g_updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:g_driver delegate:g_delegate];
    NSError *error = nil;
    if (![g_updater startUpdater:&error]) {
      NSString *msg = ErrorMessage(error);
      g_updater = nil;
      return Result(env, false, msg);
    }
    g_updater.automaticallyChecksForUpdates = NO;
    g_updater.automaticallyDownloadsUpdates = NO;
  } @catch (NSException *e) {
    g_updater = nil;
    return Result(env, false, e.reason ?: @"初始化异常");
  }
  return Result(env, true, nil);
}

static bool Ready(void) {
  return [NSThread isMainThread] && g_updater != nil && !g_closing;
}

static napi_value Probe(napi_env env, napi_callback_info info) {
  if (!Ready() || g_updater.sessionInProgress) return Bool(env, false);
  [g_updater checkForUpdateInformation];
  return Bool(env, true);
}

static napi_value BeginUpdate(napi_env env, napi_callback_info info) {
  if (!Ready() || !g_updater.canCheckForUpdates || g_updater.sessionInProgress) return Bool(env, false);
  ClearSession();
  g_authorized = YES;
  [g_updater checkForUpdates];
  return Bool(env, true);
}

static napi_value InstallNow(napi_env env, napi_callback_info info) {
  if (!Ready() || !g_authorized || g_readyReply == nil) return Bool(env, false);
  void (^reply)(SPUUserUpdateChoice) = g_readyReply;
  g_readyReply = nil;
  reply(SPUUserUpdateChoiceInstall);
  return Bool(env, true);
}

static napi_value Cancel(napi_env env, napi_callback_info info) {
  if (!Ready()) return Bool(env, false);
  bl_cancel action = bl_cancel_action(g_readyReply != nil, g_downloadCancel != nil, g_checkCancel != nil);
  // 没有可调用的取消手段（例如正在解压）时不改变任何状态，授权保持有效
  if (action == BL_CANCEL_NONE) return Bool(env, false);
  g_authorized = NO;
  if (action == BL_CANCEL_PENDING_REPLY) {
    void (^reply)(SPUUserUpdateChoice) = g_readyReply;
    g_readyReply = nil;
    reply(SPUUserUpdateChoiceSkip);
  } else if (action == BL_CANCEL_DOWNLOAD) {
    void (^cancel)(void) = g_downloadCancel;
    g_downloadCancel = nil;
    cancel();
  } else {
    void (^cancel)(void) = g_checkCancel;
    g_checkCancel = nil;
    cancel();
  }
  return Bool(env, true);
}

static napi_value ModuleInit(napi_env env, napi_value exports) {
  struct { const char *name; napi_callback cb; } fns[] = {
      {"init", Init}, {"probe", Probe}, {"beginUpdate", BeginUpdate}, {"installNow", InstallNow}, {"cancel", Cancel},
  };
  for (size_t i = 0; i < sizeof(fns) / sizeof(fns[0]); i++) {
    napi_value fn;
    napi_create_function(env, fns[i].name, NAPI_AUTO_LENGTH, fns[i].cb, NULL, &fn);
    napi_set_named_property(env, exports, fns[i].name, fn);
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
