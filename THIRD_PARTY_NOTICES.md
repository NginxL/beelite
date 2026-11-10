# 第三方组件声明

艾泽魔方 · AzerCube（应用文件 BeeLite.app）的发布包包含或依赖以下第三方组件，它们分别受各自许可证约束。

| 组件 | 版本 | 用途 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| Sparkle | 2.9.6 | 客户端更新的下载、签名校验与安装 | MIT（含其附带第三方代码的声明） | <https://github.com/sparkle-project/Sparkle>，官方发布包 `Sparkle-for-Swift-Package-Manager.zip`，SHA256 `8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606` |
| Electron | 45.2.3 | 应用运行时 | MIT（含 Chromium 等组件的许可证） | <https://github.com/electron/electron> |
| yauzl | 3.4.0 | 读取插件压缩包 | MIT | <https://github.com/thejoshwolfe/yauzl> |

- Sparkle 的完整许可证随应用分发，位于 `BeeLite.app/Contents/Resources/ThirdPartyLicenses/Sparkle-LICENSE.txt`。艾泽魔方使用未经修改的官方 Sparkle.framework。
- Electron 与 Chromium 的许可证随应用分发，位于 `BeeLite.app/Contents/Resources/` 下的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。
- 构建工具（TypeScript、electron-builder、node-gyp 等）只在开发与打包时使用，不随应用分发。
