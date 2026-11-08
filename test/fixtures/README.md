# 测试 fixture 说明

本目录的 JSON 是**离线契约 fixture**，供 `test/provider.test.ts` 校验解析逻辑使用；它们**不是实时数据**，也不会触发任何网络请求。

- 结构来源：以 NewBeeBox 公开匿名接口的实测响应为基础，按 `src/core/provider.ts` 实际读取的字段精简，并替换为合成内容。
- 保留内容：返回包裹层（`code` / `data` / `time`）、`data.list` / `data.result` 层级、字段名与字段类型（例如搜索结果 `id` 为字符串、详情 `id` 为数字）、测试用插件/文件编号及其关联（31505 ↔ 文件 673432）、flavor 与游戏版本、`file_folders`、`subscribe_plan_level` / `is_content_access` 等权限字段、分页用的 3 条搜索结果与 `total`。
- 合成内容：作者显示名为 `测试作者A`，描述为简短合成文本，图片和下载地址只保留白名单域名，路径统一在 `/fixture/` 下（测试不会下载这些地址）。
- 已删除：作者账户 ID、头像、注册时间、社交/群链接、评分、分享链接，以及远端配置中解析器用不到的条目（CDN 列表、来源白名单、服务器映射、图标等）。
- `api-config.json` 只保留 flavor 9（无限，`1.60.1`）和 flavor 2（正式服，用于不兼容版本与 code -4 用例），以及少量分类。

`e2e-release-notes.txt` 是客户端更新 E2E 测试包使用的纯文本更新说明（`scripts/build-e2e.mjs` 以 `--notes` 传给发布脚本），内容是合成的，包含应原样显示的 `<b>`、`<script>`、`&`，不是任何真实版本的说明。

与实网 smoke（`npm run smoke`）不同：smoke 访问真实接口，检查线上响应是否仍符合这里的契约；更新 fixture 时只按需调整结构，不要把完整实网响应原样存进来。
