# 维护者：签名与发布

本文面向发布艾泽魔方 · AzerCube 的维护者，普通用户不需要阅读。

0.1.7 起用户可见的品牌由「蜂简 BeeLite」改为「艾泽魔方 · AzerCube」，只改显示名：`productName`、`CFBundleName`、可执行文件、`BeeLite.app`、安装包前缀 `BeeLite-`、appId `app.beelite.addons`、签名账户、feed 地址、公钥与仓库都保持不变：保留这些值以延续既有的配置路径与更新信任链。生产包的 `CFBundleDisplayName` 为 `艾泽魔方`、`NSHumanReadableCopyright` 为 `Copyright © 2026 AzerCube`，appcast 标题由 `scripts/release-lib.mjs` 的 `appcastTitles` 生成。

## 客户端更新的信任链

- 应用内置 Sparkle 2.9.6（官方发布包，构建时按 SHA256 校验，未修改）和一个只调用 Sparkle 公开接口的原生模块。
- 更新信息固定从 `https://github.com/NginxL/beelite/releases/latest/download/appcast.xml` 获取，安装包也放在同一个 Release 中。
- 应用的 `Info.plist` 内置 EdDSA 公钥（`SUPublicEDKey`），并开启：
  - `SURequireSignedFeed`：appcast 本身必须签名；
  - `SUVerifyUpdateBeforeExtraction`：解压前先校验安装包签名（Sparkle 要求开启签名 feed 时同时开启）；
  - `SUSignedFeedFailureExpirationInterval = 0`：feed 签名校验失败时始终拒绝，不进入宽限模式。
- 应用只有 ad-hoc 代码签名，新旧版本的代码签名身份不同，无法用"新旧代码签名一致"来认可更新，所以 **EdDSA 签名是更新的信任根**：私钥就是信任根。但它不是唯一的检查。按 Sparkle 2.9.6 `SUUpdateValidator.m`（约第 174–200 行及 `passesBasicUpdatePolicy`），Sparkle 还会检查基本更新策略（例如旧版带有 EdDSA 公钥时新版也必须带有、旧版有代码签名时新版也必须有），并校验新应用自身的代码签名完整有效。签名有效但代码签名损坏的包同样会被拒绝。

这些设置由 `npm run dist` 末尾的 `scripts/verify-app.mjs production` 检查；生产包中出现测试身份、测试 feed 或测试公钥时会失败。它同时核对上面保持不变的内部身份（`CFBundleName`、`CFBundleExecutable`、应用文件名）以及显示名与版权。生产环境如需关闭其中任何一项，需要重新评审。

### 更新说明

- 每个版本的用户说明只有一个来源：仓库中的 `release-notes/<版本>.txt`（UTF-8 纯文本，不超过 4000 个字符，不能有控制字符）。它同时用于 appcast 和 GitHub Release 的说明。
- 生产模式的 `npm run release:appcast` 强制要求与安装包版本号同名的 `release-notes/<版本>.txt` 存在且非空，否则失败；生产模式拒绝 `--notes`，不能用其他文件覆盖。e2e 模式才接受 `--notes <文件>`，不提供时不写说明。
- `release-appcast.mjs` 把它写成 appcast 条目中的 `<description sparkle:format="plain-text">…</description>`（正文 XML 转义），然后才对 feed 签名，所以说明受 feed 签名保护。属性名必须是 `sparkle:format`（官方 Sparkle 2.9.6 `SUConstants.m` 的 `SUAppcastAttributeFormat`）；写成其他名字时 Sparkle 会按 HTML 处理，客户端不会显示。
- 不要在 appcast 中加入 `sparkle:releaseNotesLink` 或 `sparkle:fullReleaseNotesLink`。0.1.3 起的原生模块对 `shouldDownloadReleaseNotesForUpdate` 返回 NO，不请求外部说明；只在 feed 签名校验成功、格式为 `plain-text` 时把说明交给界面，界面按纯文本显示。
- 兼容性：0.1.1 / 0.1.2 的客户端忽略 `<description>`，照常更新，但不会弹出说明；用户先升级到 0.1.3 之后，从下一个版本起才会看到说明。旧版本不会因为 feed 中有说明而获得新的界面。

## 签名密钥

- 生产签名密钥保存在维护者 Mac 的 login Keychain 中：generic password，服务 `https://sparkle-project.org`，账户 `app.beelite.addons`。由 Sparkle 官方 `generate_keys --account app.beelite.addons` 生成；已存在时该命令只会显示公钥，不会覆盖。
- 当前公钥：`1QVzcH29FNZEGtdtqFiWCYM5a51IpLd6CsanZIcXXTI=`（与 `package.json` 中的 `SUPublicEDKey` 一致）。
- 私钥不得进入 Git、Issue、日志、CI 变量或命令行参数。签名只用 `sign_update --account app.beelite.addons`，由工具直接从 Keychain 读取。
- **备份**：私钥丢失后，已安装的用户将无法再收到自动更新，只能手动重装。建议维护者自行导出一份离线备份：用官方工具 `generate_keys --account app.beelite.addons -x <文件>` 导出到加密存储（例如加密磁盘映像或密码管理器的安全附件），导出后立即删除明文文件。不要把导出文件放在项目目录、同步盘或任何未加密位置。
- Sparkle 官方工具位于 `native/vendor/bin/`（由 `npm run native` 从校验过的官方发布包解出）。

## 发布步骤

1. 更新 `package.json` 与 `package-lock.json` 中的版本号（Sparkle 按版本号比较新旧，必须递增），并新建 `release-notes/<版本>.txt` 写好面向用户的更新说明（`npm test` 会检查当前版本的说明文件存在且合法）。
2. 运行测试与打包：

   ```sh
   npm ci
   npm run typecheck
   npm test
   npm run dist          # 打包并校验 release/mac-arm64/BeeLite.app
   ```

3. 生成并签名 appcast（只在本地生成文件，不上传）：

   ```sh
   npm run release:appcast -- --zip release/BeeLite-<版本>-arm64-mac.zip
   ```

   脚本会解压安装包并执行产物校验；按安装包的版本号读取 `release-notes/<版本>.txt`（缺失或为空时失败，生产模式不接受 `--notes`）；用 `generate_keys --account app.beelite.addons -p` 只读查询签名账户的公钥，与安装包内置的 `SUPublicEDKey` 不一致时直接失败（避免发布客户端会拒绝的更新）；用 Keychain 中的私钥签名安装包并立即校验该签名；生成 `release/appcast.xml`（包含版本号、最低 macOS 13.0.0、arm64 要求和下载地址 `https://github.com/NginxL/beelite/releases/download/v<版本>/<文件名>`；生产模式不接受指向其他地址的 `--download-url`），在条目中写入纯文本说明后对 appcast 签名并立即校验，写出 `release/SHA256SUMS`，并把同一份说明另存为 `release/RELEASE_NOTES.txt`。

4. 先把源码与文档提交并推送，在 GitHub 上新建 tag 为 `v<版本>`、目标为该次提交完整 SHA 的 **draft** Release，说明使用同一份文本（例如 `gh release create v<版本> --draft --target <完整 SHA> --notes-file release/RELEASE_NOTES.txt …`），上传 `BeeLite-<版本>-arm64-mac.zip`、`appcast.xml` 和 `SHA256SUMS`（不要上传 `latest-mac.yml`、blockmap 或 `RELEASE_NOTES.txt`）。
5. 从 draft 的资产地址下载回这三个文件，核对 SHA256 后再发布 Release，并确认它是 latest。发布后 `releases/latest/download/appcast.xml` 会立即指向新版本：用匿名请求下载它，再用 `sign_update --account app.beelite.addons --verify appcast.xml` 确认 feed 签名有效，并核对其中的版本号、下载地址、文件长度，以及 `<description sparkle:format="plain-text">` 的内容与 `release-notes/<版本>.txt` 一致。
6. 撤回或纠正有问题的版本：
   - Sparkle 只会提供比已安装版本更新的版本，**不会降级**。已经更新到问题版本的用户，不会因为 latest 改动而回到旧版本。要修复他们，只能发布一个版本号更高、带有效签名 appcast 的修复版本。
   - 只想阻止尚未更新的用户收到问题版本时，可以把 latest 改回上一个**同样附带有效签名 appcast** 的 Release。
   - 0.1.0 的 Release 没有 appcast。如果把它设为 latest，`releases/latest/download/appcast.xml` 会返回 404，客户端只会报检查失败，所以 0.1.0 不能作为回退目标。
   - 0.1.2 发布后，如需撤回，可以把 latest 改回 0.1.1（它带有效签名的 appcast）：这只会让还在 0.1.1 的用户不再收到 0.1.2；已经更新到 0.1.2 的用户不会被降级，仍只能通过发布更高版本来纠正。

## 发布前的端到端验收

`npm run e2e:build` 会构建两个隔离的测试版本（productName `BeeLite E2E`、appId `app.beelite.addons.e2e`、显示名 `AzerCube E2E`，使用每次新建的测试签名账户和 `http://127.0.0.1:47831/appcast.xml`），并生成正常（带测试说明 `test/fixtures/e2e-release-notes.txt`）、无说明与负向用例的 feed 目录；每次运行目录中的 `identity.json` 记录了测试账户和删除命令，验收步骤见 [E2E.md](E2E.md)。测试包的 userData 与 Sparkle 偏好都按测试身份隔离，不会读写正式版本的数据；但这些位置是固定的，多次运行共用，清理时只能删除本次运行创建的内容（见 E2E.md）。

`node scripts/e2e-feed-server.mjs <feed 目录> --port 47831 [--rate <字节/秒>]` 提供本地 feed。验收结束后按 `identity.json` 删除本次测试密钥。
