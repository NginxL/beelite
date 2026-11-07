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

  // 准备安装：授权持有；未授权 Skip
  EXPECT(bl_ready_action(true) == BL_HOLD, "授权的准备安装应持有");
  EXPECT(bl_ready_action(false) == BL_REPLY_SKIP, "未授权的准备安装应 Skip");

  // 取消：优先取消持有的安装回复，其次下载，再次检查；都没有（解压中）时不生效
  EXPECT(bl_cancel_action(true, true, true) == BL_CANCEL_PENDING_REPLY, "有持有回复时取消它");
  EXPECT(bl_cancel_action(false, true, true) == BL_CANCEL_DOWNLOAD, "下载中取消下载");
  EXPECT(bl_cancel_action(false, false, true) == BL_CANCEL_CHECK, "检查中取消检查");
  EXPECT(bl_cancel_action(false, false, false) == BL_CANCEL_NONE, "解压中无取消手段");

  printf("policy checks: %d, failures: %d\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
