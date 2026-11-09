// 原生回复策略的回归测试：与 beelite_sparkle.mm 共用 bl_policy.h。由 test/native-policy.test.ts 编译运行。
#include <stdio.h>
#include "../src/bl_policy.h"

static int failures = 0;
static int checks = 0;

#define EXPECT(cond, msg)                         \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      failures++;                                 \
      fprintf(stderr, "FAIL: %s\n", msg);         \
    }                                             \
  } while (0)

int main(void) {
  // 授权会话：未下载 / 已下载 -> 立即 Install（开始下载、解压，随后进入“准备安装”被持有）
  EXPECT(bl_update_found_action(true, false, BL_STAGE_NOT_DOWNLOADED) == BL_REPLY_INSTALL, "授权+未下载应 Install");
  EXPECT(bl_update_found_action(true, false, BL_STAGE_DOWNLOADED) == BL_REPLY_INSTALL, "授权+已下载应 Install");
  // 授权会话：Installing 阶段回复 Install 会立即退出重启，必须持有，等待排空
  EXPECT(bl_update_found_action(true, false, BL_STAGE_INSTALLING) == BL_HOLD, "授权+Installing 必须持有回复");
  // 未授权：不下载；Installing 必须 Skip（Dismiss 会在退出时安装）
  EXPECT(bl_update_found_action(false, false, BL_STAGE_NOT_DOWNLOADED) == BL_REPLY_DISMISS, "未授权+未下载应 Dismiss");
  EXPECT(bl_update_found_action(false, false, BL_STAGE_DOWNLOADED) == BL_REPLY_DISMISS, "未授权+已下载应 Dismiss");
  EXPECT(bl_update_found_action(false, false, BL_STAGE_INSTALLING) == BL_REPLY_SKIP, "未授权+Installing 应 Skip");
  // 仅信息更新：永不安装
  EXPECT(bl_update_found_action(true, true, BL_STAGE_NOT_DOWNLOADED) == BL_REPLY_DISMISS, "仅信息更新不安装");
  EXPECT(bl_update_found_action(true, true, BL_STAGE_INSTALLING) == BL_REPLY_SKIP, "仅信息更新在 Installing 阶段应 Skip");
  // 任何情况下都不会立即 Install 一个 Installing 阶段的更新
  for (int a = 0; a <= 1; a++)
    for (int i = 0; i <= 1; i++) EXPECT(bl_update_found_action(a, i, BL_STAGE_INSTALLING) != BL_REPLY_INSTALL, "Installing 阶段不得立即 Install");

  // 授权只对用户确认的构建有效：服务器给出另一个构建时不下载、不持有，未下载/已下载只 Dismiss（不跳过版本）
  EXPECT(bl_authorized_for(true, true) == true, "授权且构建一致才算授权");
  EXPECT(bl_authorized_for(true, false) == false, "授权但构建不同不算授权");
  EXPECT(bl_authorized_for(false, true) == false, "未授权");
  EXPECT(bl_update_found_action(bl_authorized_for(true, false), false, BL_STAGE_NOT_DOWNLOADED) == BL_REPLY_DISMISS, "构建不同+未下载应 Dismiss，不下载");
  EXPECT(bl_update_found_action(bl_authorized_for(true, false), false, BL_STAGE_DOWNLOADED) == BL_REPLY_DISMISS, "构建不同+已下载应 Dismiss，不安装");
  EXPECT(bl_update_found_action(bl_authorized_for(true, false), false, BL_STAGE_INSTALLING) == BL_REPLY_SKIP, "构建不同+Installing 应取消安装");
  for (int s = 0; s <= 2; s++) {
    bl_action a = bl_update_found_action(bl_authorized_for(true, false), false, (bl_stage)s);
    EXPECT(a != BL_REPLY_INSTALL && a != BL_HOLD, "构建不同时任何阶段都不得 Install 或持有回复");
  }
  EXPECT(bl_update_found_action(bl_authorized_for(true, true), false, BL_STAGE_NOT_DOWNLOADED) == BL_REPLY_INSTALL, "构建一致+未下载应 Install");

  // 准备安装：授权持有；未授权 Skip
  EXPECT(bl_ready_action(true) == BL_HOLD, "授权的准备安装应持有");
  EXPECT(bl_ready_action(false) == BL_REPLY_SKIP, "未授权的准备安装应 Skip");

  // 取消：优先取消持有的安装回复，其次下载，再次检查；都没有（解压中）时不生效
  EXPECT(bl_cancel_action(true, true, true) == BL_CANCEL_PENDING_REPLY, "有持有回复时取消它");
  EXPECT(bl_cancel_action(false, true, true) == BL_CANCEL_DOWNLOAD, "下载中取消下载");
  EXPECT(bl_cancel_action(false, false, true) == BL_CANCEL_CHECK, "检查中取消检查");
  EXPECT(bl_cancel_action(false, false, false) == BL_CANCEL_NONE, "解压中无取消手段");

  // 只检查（probe 意图）永远不在授权范围：即使残留了授权标记且构建一致，也只 Dismiss / Skip，任何阶段都不 Install、不持有
  for (int a = 0; a <= 1; a++)
    for (int m = 0; m <= 1; m++) EXPECT(bl_session_authorized(BL_INTENT_PROBE, a, m) == false, "probe 意图不授权");
  EXPECT(bl_session_authorized(BL_INTENT_NONE, true, true) == false, "没有本方会话时不授权");
  EXPECT(bl_session_authorized(BL_INTENT_UPDATE, true, true) == true, "update 意图、已授权且构建一致才授权");
  EXPECT(bl_session_authorized(BL_INTENT_UPDATE, true, false) == false, "update 意图但构建不同不授权");
  EXPECT(bl_session_authorized(BL_INTENT_UPDATE, false, true) == false, "update 意图但授权已作废");
  for (int a = 0; a <= 1; a++)
    for (int i = 0; i <= 1; i++)
      for (int s = 0; s <= 2; s++) {
        bl_action act = bl_update_found_action(bl_session_authorized(BL_INTENT_PROBE, a, true), i, (bl_stage)s);
        EXPECT(act != BL_REPLY_INSTALL && act != BL_HOLD, "probe 意图任何阶段都不得 Install 或持有回复");
      }
  EXPECT(bl_update_found_action(bl_session_authorized(BL_INTENT_PROBE, false, false), false, BL_STAGE_NOT_DOWNLOADED) == BL_REPLY_DISMISS, "probe+未下载应 Dismiss");
  EXPECT(bl_update_found_action(bl_session_authorized(BL_INTENT_PROBE, false, false), false, BL_STAGE_DOWNLOADED) == BL_REPLY_DISMISS, "probe+已下载应 Dismiss");
  EXPECT(bl_update_found_action(bl_session_authorized(BL_INTENT_PROBE, false, false), false, BL_STAGE_INSTALLING) == BL_REPLY_SKIP, "probe+Installing 应 Skip（Dismiss 会在退出时安装）");
  EXPECT(bl_ready_action(bl_session_authorized(BL_INTENT_PROBE, true, true)) == BL_REPLY_SKIP, "probe 意图的准备安装应 Skip");
  // 授权更新会话的 Installing 阶段仍然持有回复
  EXPECT(bl_update_found_action(bl_session_authorized(BL_INTENT_UPDATE, true, true), false, BL_STAGE_INSTALLING) == BL_HOLD, "update 意图+Installing 仍持有回复");

  // 更新会话的取消只作用于 update 意图，不会取消只检查会话
  EXPECT(bl_update_cancel_action(BL_INTENT_PROBE, false, false, true) == BL_CANCEL_NONE, "cancel 不作用于 probe 会话");
  EXPECT(bl_update_cancel_action(BL_INTENT_NONE, true, true, true) == BL_CANCEL_NONE, "没有本方会话时 cancel 不生效");
  EXPECT(bl_update_cancel_action(BL_INTENT_UPDATE, false, false, true) == BL_CANCEL_CHECK, "update 意图检查中取消检查");
  EXPECT(bl_update_cancel_action(BL_INTENT_UPDATE, false, false, false) == BL_CANCEL_NONE, "update 意图解压中无取消手段");

  // 只检查会话的取消：编号与意图都匹配才生效；取消块未到达（或已失效）时记下请求
  EXPECT(bl_probe_cancel_action(BL_INTENT_PROBE, true, true) == BL_PROBE_CANCEL_NOW, "匹配且有取消块：立即调用");
  EXPECT(bl_probe_cancel_action(BL_INTENT_PROBE, true, false) == BL_PROBE_CANCEL_DEFER, "匹配但取消块未到：记下请求");
  EXPECT(bl_probe_cancel_action(BL_INTENT_PROBE, false, true) == BL_PROBE_CANCEL_NONE, "编号不匹配：不影响当前会话");
  EXPECT(bl_probe_cancel_action(BL_INTENT_UPDATE, true, true) == BL_PROBE_CANCEL_NONE, "不取消授权更新会话");
  EXPECT(bl_probe_cancel_action(BL_INTENT_NONE, true, false) == BL_PROBE_CANCEL_NONE, "会话已结束：none");

  // 会话编号：正整数、严格递增、不超过 2^53 - 1
  EXPECT(bl_session_id_ok(1, 0) == true, "第一个会话编号 1");
  EXPECT(bl_session_id_ok(0, 0) == false, "0 不是有效编号");
  EXPECT(bl_session_id_ok(5, 5) == false, "不能重复使用编号");
  EXPECT(bl_session_id_ok(4, 5) == false, "不能回退编号");
  EXPECT(bl_session_id_ok(BL_SESSION_MAX, 1) == true, "上限可用");
  EXPECT(bl_session_id_ok(BL_SESSION_MAX + 1, 1) == false, "超过 JS 可精确表示的范围");

  printf("policy checks: %d, failures: %d\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
