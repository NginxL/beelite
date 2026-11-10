# 客户端更新端到端验收

用 `npm run e2e:build` 生成一次运行目录（默认在 `../../work/client-update-e2e/run-<编号>/`，可用 `--out` 指定）。下文的相对路径都以该目录为准。测试身份与生产完全隔离：

| 项目 | 值 |
|---|---|
| 应用 | `BeeLite E2E.app`（productName `BeeLite E2E`，appId `app.beelite.addons.e2e`，显示名 CFBundleDisplayName `AzerCube E2E`；正式应用分别是 `BeeLite`、`app.beelite.addons`、`艾泽魔方`） |
| 旧版 / 新版 | `v0.9.1/mac-arm64/BeeLite E2E.app` / `feed/ok/BeeLite-E2E-0.9.2-arm64-mac.zip` |
| 更新说明 | `feed/ok` 的 appcast 带纯文本说明（取自 `test/fixtures/e2e-release-notes.txt`，含 `<b>`、`<script>`、`&` 等应原样显示的字符）；`feed/no-notes` 是同一安装包、签名有效但不带说明的 feed |
| feed | `http://127.0.0.1:47831/appcast.xml`（Electron 默认 ATS 允许 127.0.0.1 的 http） |
| userData | `~/Library/Application Support/BeeLite E2E`（只属于测试包） |
| Sparkle 偏好 | `defaults` 域 `app.beelite.addons.e2e` |
| 测试签名 | 每次运行新建的 Keychain 账户 `beelite-e2e-<编号>`，见 `identity.json` |

可以先离线核对用例：`native/vendor/bin/sign_update --account <测试账户> --verify feed/<用例>/appcast.xml` 对 `ok`、`no-notes` 应成功，对 `tampered-feed`、`unsigned-feed` 应失败。`feed/ok/appcast.xml` 中应有 `<description sparkle:format="plain-text">`，且没有 `releaseNotesLink`。

测试包是完整的应用，会照常对绑定的临时游戏目录做插件更新自动检查（只读，访问真实的 NewBeeBox 接口查询已安装插件的最新文件）；验收客户端更新时可以忽略插件提示，但不要绑定真实游戏目录。

## 准备

0. 在做任何准备之前，记录以下各项是否已经存在，结束清理时据此判断（见“结束清理”）：
   - `~/Library/Application Support/BeeLite E2E`；
   - `~/Library/Caches/app.beelite.addons.e2e`；
   - `defaults read app.beelite.addons.e2e` 是否有输出。
1. 把 `v0.9.1/mac-arm64/BeeLite E2E.app` 复制到一个临时目录（例如本运行目录下的 `install/`）并从那里启动；不要放进 `/Applications`，不要使用真实的 BeeLite.app。
2. 在 `~/Library/Application Support/BeeLite E2E/` 中放一个哨兵文件；绑定一个临时游戏目录（例如 `install/game/_forever_`），装一个小插件，记录 `settings.json` 与插件目录内容。
3. 在项目目录启动 feed：`node scripts/e2e-feed-server.mjs <本目录>/feed/ok --port 47831`（需要慢速下载时加 `--rate 200000`）。

## 观察安装与重启的方式

从应用退出到新版本启动之间，Sparkle 会在后台交换应用目录。这段时间内**不要**以任何方式从外部启动或"附着"到测试应用（例如按路径获取应用的自动化调用、点击 Dock 图标、`open` 命令），也不要立即查询界面。否则 LaunchServices 可能在交换之前，从安装路径启动旧的可执行文件。这样得到的进程是"旧启动器 + 新资源"的混合体：`proc_pidpath` 会返回 ENOENT，tccd 无法识别这个进程，读取受保护目录也可能失败，但这并不代表安装结果有问题。

正确做法：点击后只用轻量的只读命令（`ps`、`proc_pidpath`、读取安装路径下 `Contents/Info.plist` 的版本号）分段轮询，等待两件事：旧进程退出，以及由 Sparkle 重启的新进程出现。新进程稳定前不要持续运行 `lsof`，也不要调用 `getApp`、`getAXState` 之类会附着或启动应用的自动化接口。确认新进程的可执行文件路径存在、`lsof` 中的 txt inode 与安装路径上的文件一致之后，再查询界面。

替换步骤可能明显超过 60 秒（实测出现过数分钟），期间 Sparkle 可能显示安装进度。超时等待应以“旧进程已退出、新进程尚未出现”为依据持续观察，不要因为等待时间长就外部启动应用或结束 Sparkle 的安装进程。

测试游戏目录放在 `~/Documents`、`~/Desktop` 等受 macOS 隐私保护的位置时，测试应用首次访问会触发系统授权询问；放在系统临时目录下可以避免这一点。

## 正向

1. 启动旧版。约 5 秒后侧栏应显示“发现新版本 v0.9.2”，并自动弹出更新说明：标题“艾泽魔方 v0.9.2 可用”，显示当前版本 v0.9.1，说明内容与夹具文件一致，`<b>`、`<script>` 原样显示为文字，默认焦点在“稍后”。feed 服务器日志只出现 `appcast.xml`，**不出现 zip 请求**（只探测不下载）。
2. 说明打开时用菜单“窗口 → 重新载入”：界面重新载入后不再自动弹出（说明一显示就已记为提醒过）。点“稍后”：不出现 zip 请求，侧栏仍可“下载并更新”。点应用菜单（菜单栏中应用名那一项）的“检查客户端更新…”再次探测到同一版本时**不再自动弹出**；侧栏“更新说明”可以重新打开同一份说明。
3. 在说明中或侧栏点击“下载并更新”（一次）。依次出现下载百分比、“正在校验并解压…”、“正在安装并重新启动…”，应用自动重启为 0.9.2，中间不需要任何二次确认；替换较慢时可能出现 Sparkle 的安装进度（重启期间按上一节的方式观察）。
4. 重启后：版本显示 0.9.2；哨兵文件、`settings.json`、临时游戏目录与插件不变；点“检查更新”显示“艾泽魔方已是最新版本”（0.1.6 显示“蜂简已是最新版本”，0.1.5 及更早的版本显示“已是最新版本”）。
5. 应用菜单的“检查客户端更新…”同样只探测。
6. 无说明：重新准备旧版，把 feed 指向 `feed/no-notes` 后启动，弹窗中应显示“此版本未提供更新说明。”，其余流程相同。
7. 互斥：在旧版中先打开一个确认框（例如“解除绑定”）再触发检查，说明应等确认框关闭后才弹出，不会叠在确认框上。

## 写操作保护

1. 使用 `--rate` 慢速 feed，旧版中先开始安装一个较大的插件（或打开“选择目录”对话框、或开始“全部更新”），再点“下载并更新”。
2. 下载完成后应显示“等待插件操作完成…”，此时新的插件写操作被拒绝（提示客户端正在更新）；进行中的操作完成后才安装并重启。
3. 检查临时游戏目录中没有残留的 `Interface/.beelite/journal.json`，`staging/` 为空。
4. 有插件操作进行中时按 ⌘Q：应用应等操作完成后再退出。

## 负向（每项结束后旧版都应仍可正常启动、版本不变）

把 feed 服务器指向下列目录之一后，在旧版中点“检查更新 / 下载并更新”：

| 目录 | 预期 |
|---|---|
| `feed/tampered-feed` | 检查失败（feed 签名无效），不下载 |
| `feed/unsigned-feed` | 检查失败（缺少 feed 签名），不下载 |
| `feed/bad-archive` | 下载后校验失败并报错，不安装 |
| `feed/missing-archive` | 下载失败（404）并报错，可重试 |
| 停止 feed 服务器 | 检查失败，显示可重试 |
| feed 服务器接受连接但不返回数据（0.1.6 起） | 30 秒后显示“检查艾泽魔方新版本超时，正在停止本次检查…”，没有按钮；这次检查结束后显示“检查艾泽魔方新版本超时，请稍后重试”和“重试”（0.1.6 的文字是“蜂简”）；feed 恢复后点“重试”在同一进程内完成检查，不出现 zip 请求 |

下载过程中（用 `--rate` 放慢）点“取消”：显示“已取消更新”，旧版不变；在上一次更新会话结束之前，“下载并更新 / 检查更新”暂时不可用，结束后恢复可点。
校验与解压阶段侧栏不显示“取消”按钮。
在“等待插件操作完成…”时点“取消”：不安装、不重启，插件写操作恢复可用。

## 结束清理（只删本次创建的内容）

测试应用的窗口标题与正式应用相同：窗口显示的是页面标题（0.1.7 起为“艾泽魔方 · AzerCube”，0.1.6 为“蜂简 BeeLite”），不能用标题区分。请用以下几点识别：应用文件与进程名是“BeeLite E2E”（正式应用是“BeeLite”）；“关于”面板中的名称是“艾泽魔方 BeeLite E2E”（正式应用是“艾泽魔方 · AzerCube”）；Dock 等处如果显示显示名，测试应用是“AzerCube E2E”（正式应用是“艾泽魔方”）；侧栏底部的版本号是 v0.9.x（正式应用是 0.1.x）；绑定的游戏目录是临时测试目录，而不是真实游戏目录。验收结束时先正常退出测试应用，确认它已不在运行、也没有窗口留在前台，避免把测试窗口误当成正式应用。


只有测试签名账户是每次运行唯一的，可以直接删除：

```sh
security delete-generic-password -s https://sparkle-project.org -a <identity.json 中的 keychainAccount>
```

测试包的 userData、Sparkle 缓存和偏好域都是按测试身份**固定**的，多次运行会共用。只有在“准备”第 0 步记录为“原本不存在”、确认是本次运行创建的情况下，才删除对应的那一项：

```sh
rm -rf "$HOME/Library/Application Support/BeeLite E2E"   # 仅当准备前不存在
rm -rf "$HOME/Library/Caches/app.beelite.addons.e2e"      # 仅当准备前不存在
defaults delete app.beelite.addons.e2e                     # 仅当准备前没有该偏好域
```

如果准备前已经存在，就保留原样，只删除本次运行自己放入的哨兵文件和临时游戏目录。任何情况下都不要删除生产身份 `BeeLite` / `app.beelite.addons` 的数据。

## 无法在本机证明的情况

点击“下载并更新”之后服务器上的版本又变成另一个构建时，原生不下载、改为展示新构建的说明——这需要在探测与点击之间切换到第三个版本的 feed，构建脚本没有生成这个用例，由单元测试与原生策略测试覆盖。

macOS 13 实机、无管理员权限账户的系统授权框、受管设备（MDM）拦截、新版启动后业务异常的自动回滚（Sparkle 不提供）。
