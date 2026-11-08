// 更新说明读取的回归测试：用 vendor 中官方 Sparkle 2.9.6 的 SUAppcast 解析发布脚本生成的 appcast，
// 再经原生桥共用的 BLNotesOf（bl_notes.h）读取，按行输出 JSON。由 test/native-notes.test.ts 编译运行。
// 用法：appcast_notes_test <签名状态 0=Skipped 1=Succeeded 2=Failed> <appcast.xml>...
#import <Foundation/Foundation.h>
#import <Sparkle/Sparkle.h>
#import "SPUAppcastItemStateResolver.h"
#include "../src/bl_notes.h"

// SUAppcast 的初始化方法在官方 SUAppcast+Private.h 中声明（未随框架分发头文件），是普通的 Objective-C 方法
@interface SUAppcast (BeeLiteTest)
- (nullable instancetype)initWithXMLData:(NSData *)xmlData relativeToURL:(nullable NSURL *)relativeURL stateResolver:(SPUAppcastItemStateResolver *)stateResolver signingValidationStatus:(SPUAppcastSigningValidationStatus)signingValidationStatus error:(NSError * __autoreleasing *)error;
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "usage: appcast_notes_test <status> <appcast.xml>...\n");
      return 2;
    }
    SPUAppcastSigningValidationStatus status = (SPUAppcastSigningValidationStatus)atoi(argv[1]);
    SUStandardVersionComparator *cmp = [SUStandardVersionComparator defaultComparator];
    SPUAppcastItemStateResolver *resolver = [[SPUAppcastItemStateResolver alloc] initWithHostVersion:@"0.1.3" applicationVersionComparator:cmp standardVersionComparator:cmp];
    for (int i = 2; i < argc; i++) {
      NSData *data = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[i]]];
      NSError *error = nil;
      SUAppcast *appcast = [[SUAppcast alloc] initWithXMLData:data relativeToURL:nil stateResolver:resolver signingValidationStatus:status error:&error];
      SUAppcastItem *item = appcast.items.firstObject;
      if (item == nil) {
        fprintf(stderr, "parse failed: %s\n", error.localizedDescription.UTF8String ?: "no item");
        return 1;
      }
      NSMutableDictionary *out = [BLItemEvent(@"valid-update", item, nil) mutableCopy];
      out[@"itemDescriptionFormat"] = item.itemDescriptionFormat ?: [NSNull null];
      out[@"hasReleaseNotesURL"] = @(item.releaseNotesURL != nil);
      NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
      fwrite(json.bytes, 1, json.length, stdout);
      fputc('\n', stdout);
    }
  }
  return 0;
}
