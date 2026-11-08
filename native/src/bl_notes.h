// 从已验证的 appcast 条目读取纯文本更新说明（Objective-C，只用 Sparkle 2.9.6 公开属性）。
// 由原生桥与 native/test/appcast_notes_test.m 共用。
//
// 依据官方 SUAppcast.m / SUAppcastItem.m：<description sparkle:format="plain-text">…</description> 解析为
// itemDescription 与 itemDescriptionFormat（"plain-text"）；未写 sparkle:format 或写错属性名时格式为 "html"；
// feed 签名校验失败时 itemDescription 为 nil。这里只接受 签名校验成功 + plain-text + 非空 的说明，其余一律不提供正文。
#ifndef BL_NOTES_H
#define BL_NOTES_H

#import <Foundation/Foundation.h>
#import <Sparkle/Sparkle.h>

/** 更新说明的最大长度（UTF-16 字符），与 JS 侧和发布脚本一致 */
#define BL_NOTES_MAX 4000

/** 返回 notesState（ok / missing / unsupported / unverified），ok 时附带 notes 与 notesTruncated */
static inline NSDictionary *BLNotesOf(SUAppcastItem *item) {
  if (item.signingValidationStatus != SPUAppcastSigningValidationStatusSucceeded) return @{@"notesState" : @"unverified"};
  NSString *text = item.itemDescription;
  if (text == nil || [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length == 0) {
    return @{@"notesState" : @"missing"};
  }
  if (![item.itemDescriptionFormat isEqualToString:@"plain-text"]) return @{@"notesState" : @"unsupported"};
  BOOL truncated = NO;
  if (text.length > BL_NOTES_MAX) {
    // 不在组合字符或代理对中间截断
    NSRange r = [text rangeOfComposedCharacterSequenceAtIndex:BL_NOTES_MAX];
    text = [text substringToIndex:r.location];
    truncated = YES;
  }
  return @{@"notesState" : @"ok", @"notes" : text, @"notesTruncated" : @(truncated)};
}

/** 条目事件：类型、构建号、显示版本与说明来自同一个条目 */
static inline NSDictionary *BLItemEvent(NSString *type, SUAppcastItem *item, NSDictionary *extra) {
  NSMutableDictionary *p = [@{@"type" : type, @"version" : item.versionString ?: @"", @"displayVersion" : item.displayVersionString ?: @""} mutableCopy];
  [p addEntriesFromDictionary:BLNotesOf(item)];
  if (extra != nil) [p addEntriesFromDictionary:extra];
  return p;
}

#endif
