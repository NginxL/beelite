// 客户端更新的回复策略（纯 C，无 Sparkle 依赖），由原生桥与 native/test/policy_test.c 共用。
//
// 依据官方 Sparkle 2.9.6 SPUUserDriver.h：
// - showUpdateFound 在 Installing 阶段回复 Install 会立即退出并重启（快速安装），不会再回调“准备安装”；
//   因此授权会话在 Installing 阶段也必须先持有回复，等主进程排空写操作后才回复 Install。
// - 未授权时：NotDownloaded / Downloaded 回复 Dismiss（不下载、不安装）；Installing 回复 Skip（取消安装），
//   不能用 Dismiss，否则应用退出时仍会安装。
// - showReadyToInstallAndRelaunch：授权时持有回复；未授权时回复 Skip（取消本次安装，不永久跳过版本）。
// - 授权只对用户确认的构建号有效（bl_authorized_for）：授权会话中服务器给出另一个构建时按未授权处理——
//   未下载 / 已下载回复 Dismiss（不下载、不跳过）；Installing 阶段回复 Skip 取消安装。
//   Sparkle 的用户发起检查会先清除跳过记录（SPUUIBasedUpdateDriver.m _clearSkippedUpdatesIfUserInitiated），用户再次点击更新时不受影响。
#ifndef BL_POLICY_H
#define BL_POLICY_H

#include <stdbool.h>

typedef enum { BL_STAGE_NOT_DOWNLOADED = 0, BL_STAGE_DOWNLOADED = 1, BL_STAGE_INSTALLING = 2 } bl_stage;

typedef enum {
  BL_REPLY_INSTALL = 0, /* 立即回复 Install（开始或继续下载与解压） */
  BL_REPLY_DISMISS = 1, /* 立即回复 Dismiss */
  BL_REPLY_SKIP = 2,    /* 立即回复 Skip */
  BL_HOLD = 3           /* 持有回复，等待主进程排空写操作后再安装或取消 */
} bl_action;

static inline bl_action bl_update_found_action(bool authorized, bool information_only, bl_stage stage) {
  if (stage == BL_STAGE_INSTALLING) {
    if (authorized && !information_only) return BL_HOLD;
    return BL_REPLY_SKIP;
  }
  if (authorized && !information_only) return BL_REPLY_INSTALL;
  return BL_REPLY_DISMISS;
}

/** 授权会话中发现的条目是否在授权范围内：必须是用户确认的同一个构建 */
static inline bool bl_authorized_for(bool authorized, bool build_matches) {
  return authorized && build_matches;
}

static inline bl_action bl_ready_action(bool authorized) {
  return authorized ? BL_HOLD : BL_REPLY_SKIP;
}

typedef enum {
  BL_CANCEL_NONE = 0,          /* 当前没有可取消的操作：不改变任何状态 */
  BL_CANCEL_PENDING_REPLY = 1, /* 对持有的安装回复回复 Skip */
  BL_CANCEL_DOWNLOAD = 2,      /* 调用下载取消块 */
  BL_CANCEL_CHECK = 3          /* 调用用户检查取消块 */
} bl_cancel;

/** 取消只在确有可调用的取消手段时生效；解压阶段没有取消手段，返回 NONE 且不清除授权 */
static inline bl_cancel bl_cancel_action(bool has_pending_reply, bool has_download_cancel, bool has_check_cancel) {
  if (has_pending_reply) return BL_CANCEL_PENDING_REPLY;
  if (has_download_cancel) return BL_CANCEL_DOWNLOAD;
  if (has_check_cancel) return BL_CANCEL_CHECK;
  return BL_CANCEL_NONE;
}

#endif
