// 蜂简客户端更新原生桥：官方 Sparkle 2.9.6 公开 API + Node-API（C 接口）。
//
// 只提供六个固定操作：init / probe / beginUpdate / installNow / cancel / cancelProbe。
// - 每个原生会话由 JS 给出严格递增的正整数编号（session）与意图（probe 只检查 / update 授权更新）；
//   本会话内的所有事件在原生回调发生时就带上当时的 session 与 intent，周期结束（cycle-finished）上报后清除。
//   不是本方发起的周期（例如后台检查）的事件 session 为 0，JS 一律忽略。
// - probe(session)：只检查。使用用户发起检查（checkForUpdates）而不是 checkForUpdateInformation，
//   因为只有前者在拉取 appcast 之前提供取消块；本会话始终未授权，发现更新时不下载、不安装（回复策略见 bl_policy.h）。
// - cancelProbe(session)：只作用于编号匹配、仍在进行的只检查会话；取消块尚未到达时记下请求，到达时立即调用。
//   返回值只表示请求是否已发出，周期是否真正结束仍以该会话的 cycle-finished 为准。
// - beginUpdate(expectedBuild, session)：本次会话授权（g_authorized）后发起用户检查；授权只对用户确认的构建号 g_expectedBuild 有效。
//   只有授权内且构建一致，driver 才对“发现更新”回复 Install（即开始下载）；服务器给出另一个构建时不下载，上报 build-changed。
// - 版本、构建号与更新说明总是从同一个 SUAppcastItem 一起上报（bl_notes.h）；说明只取签名校验成功的纯文本 description，
//   且不让 Sparkle 下载外部 release notes（shouldDownloadReleaseNotesForUpdate 返回 NO）。
// - 下载、EdDSA 验签、解压完成后（或会话发现更新已处于 Installing 阶段时），driver 持有安装回复，不自行安装；
//   由 JS 排空写操作后调用 installNow。回复策略见 bl_policy.h。
// - cancel：只作用于授权更新会话，且只在确有取消手段时生效（持有的安装回复以 Skip 取消、下载取消块、用户检查取消块）；解压阶段无法取消。
// - 诊断日志：os_log（子系统为应用的 bundle id，类别 client-update），只记会话编号、意图、事件类型、耗时、
//   事件入队与送达结果、NSError 的 domain 与 code；不记 URL、请求头、更新说明或错误描述文字，不记下载进度的每一次刷新。
// 所有 Sparkle 调用都在主线程；事件经线程安全函数回到 JS，环境清理时释放并停止派发。
#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#include <math.h>
#include <node_api.h>
#include <os/log.h>
#include "bl_notes.h"
#include "bl_policy.h"

static napi_threadsafe_function g_tsfn = NULL;
static BOOL g_closing = NO;
static BOOL g_authorized = NO;
/** 本次授权对应的构建号（SUAppcastItem.versionString） */
static NSString *g_expectedBuild = nil;
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
/** 本方发起、尚未结束的原生会话：编号（0 表示没有）、意图与开始时间 */
static uint64_t g_session = 0;
static bl_intent g_intent = BL_INTENT_NONE;
static CFAbsoluteTime g_sessionStart = 0;
/** 上一次接受的会话编号；新编号必须严格大于它 */
static uint64_t g_lastSession = 0;
/** 已请求取消、等待用户检查取消块到达的只检查会话 */
static uint64_t g_cancelRequested = 0;
/** 事件序号：只用于在日志中对应“入队”与“送达” */
static uint64_t g_eventSeq = 0;
static os_log_t g_log = NULL;

#define BL_LOG (g_log != NULL ? g_log : OS_LOG_DEFAULT)

static const char *IntentName(bl_intent intent) {
  switch (intent) {
    case BL_INTENT_PROBE: return "probe";
    case BL_INTENT_UPDATE: return "update";
    default: return "none";
  }
}

static double ElapsedMs(void) {
  return g_session != 0 ? (CFAbsoluteTimeGetCurrent() - g_sessionStart) * 1000.0 : 0;
}

// ---------- 事件派发 ----------

/** 一条待送达 JS 的事件；quiet 的事件（进度刷新）送达成功时不写日志 */
typedef struct {
  uint64_t seq;
  bool quiet;
  char json[];
} BLPacket;

static void CallJs(napi_env env, napi_value jsCallback, void *context, void *data) {
  BLPacket *packet = (BLPacket *)data;
  if (packet == NULL) return;
  if (env != NULL && jsCallback != NULL) {
    napi_value arg;
    napi_status st = napi_create_string_utf8(env, packet->json, NAPI_AUTO_LENGTH, &arg);
    if (st == napi_ok) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      st = napi_call_function(env, undefined, jsCallback, 1, &arg, NULL);
    }
    if (!packet->quiet || st != napi_ok) os_log(BL_LOG, "deliver seq=%llu status=%d", packet->seq, (int)st);
  } else {
    os_log(BL_LOG, "drop seq=%llu reason=closing", packet->seq);
  }
  free(packet);
}

/** 派发事件，带上指定的会话编号与意图（在原生回调发生时取得） */
static void EmitTagged(NSDictionary *body, uint64_t session, bl_intent intent, BOOL quiet) {
  if (g_closing || g_tsfn == NULL) return;
  NSMutableDictionary *payload = [body mutableCopy];
  payload[@"session"] = @(session);
  payload[@"intent"] = @(IntentName(intent));
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (data == nil) return;
  BLPacket *packet = (BLPacket *)malloc(sizeof(BLPacket) + data.length + 1);
  if (packet == NULL) return;
  packet->seq = ++g_eventSeq;
  packet->quiet = quiet;
  memcpy(packet->json, data.bytes, data.length);
  packet->json[data.length] = '\0';
  NSString *type = [body[@"type"] isKindOfClass:[NSString class]] ? body[@"type"] : @"?";
  napi_status st = napi_call_threadsafe_function(g_tsfn, packet, napi_tsfn_nonblocking);
  if (st != napi_ok) {
    os_log_error(BL_LOG, "enqueue failed seq=%llu type=%{public}@ session=%llu status=%d", packet->seq, type, session, (int)st);
    free(packet);
    return;
  }
  if (!quiet) os_log(BL_LOG, "emit seq=%llu type=%{public}@ session=%llu intent=%{public}s elapsed_ms=%.0f", packet->seq, type, session, IntentName(intent), ElapsedMs());
}

/** 派发属于当前会话的事件 */
static void Emit(NSDictionary *body) {
  EmitTagged(body, g_session, g_intent, NO);
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
  g_expectedBuild = nil;
  g_readyReply = nil;
  g_downloadCancel = nil;
  g_checkCancel = nil;
}

static void BeginSession(uint64_t session, bl_intent intent) {
  g_lastSession = session;
  g_session = session;
  g_intent = intent;
  g_sessionStart = CFAbsoluteTimeGetCurrent();
  g_cancelRequested = 0;
}

static void EndSession(void) {
  g_session = 0;
  g_intent = BL_INTENT_NONE;
  g_cancelRequested = 0;
}

// ---------- 委托 ----------

@interface BeeLiteUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@end

@implementation BeeLiteUpdaterDelegate
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
  Emit(BLItemEvent(@"valid-update", item, nil));
}
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)updateItem {
  // 只使用 appcast 内联、随 feed 签名的纯文本说明；不请求任何外部 release notes 链接
  return NO;
}
- (void)updater:(SPUUpdater *)updater didFinishLoadingAppcast:(SUAppcast *)appcast {
  // appcast 已加载：用户检查取消块此后不再起作用。只检查会话随后会很快得到结果并结束，之后的取消请求只记下
  if (g_intent == BL_INTENT_PROBE) g_checkCancel = nil;
  // 只用于诊断（JS 不据此改变状态）；Emit 同时写入带耗时的日志
  Emit(@{@"type" : @"appcast-loaded"});
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
  Emit(@{@"type" : @"no-update"});
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)updateCheck error:(nullable NSError *)error {
  // 本方发起的会话都是用户发起检查；其他类型的周期不属于任何本方会话
  BOOL ours = updateCheck == SPUUpdateCheckUpdates;
  uint64_t session = ours ? g_session : 0;
  bl_intent intent = ours ? g_intent : BL_INTENT_NONE;
  NSMutableDictionary *p = [@{@"type" : @"cycle-finished", @"check" : CheckName(updateCheck)} mutableCopy];
  if (error != nil) {
    p[@"errorCode"] = @(error.code);
    p[@"error"] = ErrorMessage(error);
  }
  os_log(BL_LOG, "cycle-finished session=%llu intent=%{public}s check=%{public}@ domain=%{public}@ code=%ld elapsed_ms=%.0f", session, IntentName(intent),
         CheckName(updateCheck), error != nil ? error.domain : @"-", error != nil ? (long)error.code : 0L, ElapsedMs());
  if (ours) {
    ClearSession();
    EndSession();
  }
  EmitTagged(p, session, intent, NO);
}
@end

// ---------- 用户界面驱动（不显示任何 Sparkle 窗口，状态交给 Electron 界面） ----------

@interface BeeLiteUserDriver : NSObject <SPUUserDriver>
@end

@implementation BeeLiteUserDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  // 不开启 Sparkle 自带的定时检查；检查时机由应用自己控制
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  g_checkCancel = [cancellation copy];
  os_log(BL_LOG, "check-started session=%llu intent=%{public}s elapsed_ms=%.0f", g_session, IntentName(g_intent), ElapsedMs());
  if (g_intent == BL_INTENT_PROBE && g_session != 0 && g_cancelRequested == g_session) {
    // 取消请求早于取消块到达：现在执行
    g_cancelRequested = 0;
    void (^cancel)(void) = g_checkCancel;
    g_checkCancel = nil;
    cancel();
    os_log(BL_LOG, "probe cancel invoked (deferred) session=%llu", g_session);
  }
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)appcastItem state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  g_checkCancel = nil;
  BOOL matches = g_expectedBuild != nil && [g_expectedBuild isEqualToString:(appcastItem.versionString ?: @"")];
  BOOL changed = g_intent == BL_INTENT_UPDATE && g_authorized && !matches;
  bl_stage stage = StageOf(state);
  // 只检查会话永远不在授权范围：未下载 / 已下载 Dismiss，Installing 阶段 Skip
  bl_action action = bl_update_found_action(bl_session_authorized(g_intent, g_authorized, matches), appcastItem.informationOnlyUpdate, stage);
  BOOL allowed = action == BL_REPLY_INSTALL || action == BL_HOLD;
  os_log(BL_LOG, "update-found session=%llu intent=%{public}s stage=%d action=%d", g_session, IntentName(g_intent), (int)stage, (int)action);
  if (changed) {
    // 用户确认的是另一个构建：本次不下载、不安装；授权作废，由用户看过新构建的说明后重新点击
    g_authorized = NO;
    g_expectedBuild = nil;
    Emit(BLItemEvent(@"build-changed", appcastItem, nil));
  }
  Emit(BLItemEvent(@"update-found", appcastItem, @{@"authorized" : @(allowed)}));
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
  os_log(BL_LOG, "updater-error session=%llu domain=%{public}@ code=%ld", g_session, error.domain ?: @"-", (long)error.code);
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
  EmitTagged(@{@"type" : @"download-progress", @"received" : @(g_received), @"total" : @(g_expected)}, g_session, g_intent, YES);
}
- (void)showDownloadDidStartExtractingUpdate {
  g_downloadCancel = nil;
  Emit(@{@"type" : @"extracting"});
}
- (void)showExtractionReceivedProgress:(double)progress {
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (now - g_lastProgress < 0.2 && progress < 1.0) return;
  g_lastProgress = now;
  EmitTagged(@{@"type" : @"extracting", @"percent" : @(MIN(100.0, MAX(0.0, progress * 100.0)))}, g_session, g_intent, YES);
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  bl_action action = bl_ready_action(g_intent == BL_INTENT_UPDATE && g_authorized);
  os_log(BL_LOG, "ready-to-install session=%llu intent=%{public}s action=%d", g_session, IntentName(g_intent), (int)action);
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

static napi_value Str(napi_env env, const char *s) {
  napi_value r;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &r);
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
  if (g_log == NULL) {
    NSString *bundleId = NSBundle.mainBundle.bundleIdentifier;
    g_log = os_log_create(bundleId.length > 0 ? bundleId.UTF8String : "app.beelite.addons", "client-update");
  }
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
      os_log_error(BL_LOG, "start failed domain=%{public}@ code=%ld", error.domain ?: @"-", (long)error.code);
      g_updater = nil;
      return Result(env, false, msg);
    }
    g_updater.automaticallyChecksForUpdates = NO;
    g_updater.automaticallyDownloadsUpdates = NO;
  } @catch (NSException *e) {
    g_updater = nil;
    return Result(env, false, e.reason ?: @"初始化异常");
  }
  os_log(BL_LOG, "init ok");
  return Result(env, true, nil);
}

static bool Ready(void) {
  return [NSThread isMainThread] && g_updater != nil && !g_closing;
}

/** 读取会话编号参数：正整数，不超过 2^53 - 1 */
static bool SessionArg(napi_env env, napi_value v, uint64_t *out) {
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_number) return false;
  double d = 0;
  if (napi_get_value_double(env, v, &d) != napi_ok) return false;
  if (!(d >= 1 && d <= (double)BL_SESSION_MAX) || floor(d) != d) return false;
  *out = (uint64_t)d;
  return true;
}

/** 读取构建号参数：1–64 个字符，只允许字母、数字与 . _ + - */
static NSString *BuildArg(napi_env env, napi_value v) {
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) return nil;
  char buf[72];
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, buf, sizeof(buf), &len) != napi_ok || len == 0 || len > 64) return nil;
  for (size_t i = 0; i < len; i++) {
    char c = buf[i];
    BOOL ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '_' || c == '+' || c == '-';
    if (!ok) return nil;
  }
  return [[NSString alloc] initWithBytes:buf length:len encoding:NSUTF8StringEncoding];
}

/** 发起用户检查；Sparkle 未真正开始会话（例如正在展示其他提示）时撤销本方会话并返回 false */
static bool StartCheck(uint64_t session, bl_intent intent) {
  BeginSession(session, intent);
  [g_updater checkForUpdates];
  if (g_updater.sessionInProgress) {
    os_log(BL_LOG, "check requested session=%llu intent=%{public}s", session, IntentName(intent));
    return true;
  }
  os_log(BL_LOG, "check not started session=%llu intent=%{public}s", session, IntentName(intent));
  ClearSession();
  EndSession();
  return false;
}

static napi_value Probe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint64_t session = 0;
  bool args = napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 1 && SessionArg(env, argv[0], &session);
  if (!args || !Ready() || !bl_session_id_ok(session, g_lastSession) || !g_updater.canCheckForUpdates || g_updater.sessionInProgress) {
    os_log(BL_LOG, "probe refused session=%llu", session);
    return Bool(env, false);
  }
  ClearSession();
  return Bool(env, StartCheck(session, BL_INTENT_PROBE));
}

static napi_value BeginUpdate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  uint64_t session = 0;
  NSString *build = nil;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 2 && SessionArg(env, argv[1], &session)) build = BuildArg(env, argv[0]);
  if (build == nil || !Ready() || !bl_session_id_ok(session, g_lastSession) || !g_updater.canCheckForUpdates || g_updater.sessionInProgress) {
    os_log(BL_LOG, "beginUpdate refused session=%llu", session);
    return Bool(env, false);
  }
  ClearSession();
  g_authorized = YES;
  g_expectedBuild = build;
  return Bool(env, StartCheck(session, BL_INTENT_UPDATE));
}

static napi_value InstallNow(napi_env env, napi_callback_info info) {
  if (!Ready() || g_intent != BL_INTENT_UPDATE || !g_authorized || g_readyReply == nil) {
    os_log(BL_LOG, "installNow refused session=%llu", g_session);
    return Bool(env, false);
  }
  void (^reply)(SPUUserUpdateChoice) = g_readyReply;
  g_readyReply = nil;
  os_log(BL_LOG, "installNow session=%llu elapsed_ms=%.0f", g_session, ElapsedMs());
  reply(SPUUserUpdateChoiceInstall);
  return Bool(env, true);
}

static napi_value Cancel(napi_env env, napi_callback_info info) {
  if (!Ready()) return Bool(env, false);
  bl_cancel action = bl_update_cancel_action(g_intent, g_readyReply != nil, g_downloadCancel != nil, g_checkCancel != nil);
  os_log(BL_LOG, "cancel session=%llu intent=%{public}s action=%d", g_session, IntentName(g_intent), (int)action);
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

/** 取消只检查会话：返回 "cancelled"（已调用取消块）、"pending"（已记下，取消块到达时调用）或 "none"（没有匹配的会话） */
static napi_value CancelProbe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint64_t session = 0;
  bool args = napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 1 && SessionArg(env, argv[0], &session);
  const char *result = "none";
  if (args && Ready()) {
    bl_probe_cancel action = bl_probe_cancel_action(g_intent, session == g_session, g_checkCancel != nil);
    if (action == BL_PROBE_CANCEL_NOW) {
      void (^cancel)(void) = g_checkCancel;
      g_checkCancel = nil;
      cancel();
      result = "cancelled";
    } else if (action == BL_PROBE_CANCEL_DEFER) {
      g_cancelRequested = session;
      result = "pending";
    }
  }
  os_log(BL_LOG, "cancelProbe session=%llu current=%llu result=%{public}s elapsed_ms=%.0f", session, g_session, result, ElapsedMs());
  return Str(env, result);
}

static napi_value ModuleInit(napi_env env, napi_value exports) {
  struct { const char *name; napi_callback cb; } fns[] = {
      {"init", Init}, {"probe", Probe}, {"beginUpdate", BeginUpdate}, {"installNow", InstallNow}, {"cancel", Cancel}, {"cancelProbe", CancelProbe},
  };
  for (size_t i = 0; i < sizeof(fns) / sizeof(fns[0]); i++) {
    napi_value fn;
    napi_create_function(env, fns[i].name, NAPI_AUTO_LENGTH, fns[i].cb, NULL, &fn);
    napi_set_named_property(env, exports, fns[i].name, fn);
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
