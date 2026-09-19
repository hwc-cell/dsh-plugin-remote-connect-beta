# Contributing

[English](CONTRIBUTING.md) | [中文说明见 README](README.zh.md)

## 开发环境

- Node.js ≥ 18（CI 跑 20 与 22）
- macOS 或 Linux；`Bash` 需要能跑 `bash -n`
- `npm install` 后即可跑测试（React 仅作为 devDependency，用于客户端半的 SSR 断言）

```bash
npm install
npm test        # 契约 / 渲染 / 生成物 / 本地化断言
npm run gate    # 私有值门禁：自有域名、服务器 IP、本机路径、真实公钥
npm run e2e     # 端到端：起一个隔离的真实 DSH 实例并把本仓库当插件装进去（需要本机有 DSH 安装）
npm run preview # 真浏览器预览客户端半：http://127.0.0.1:8899/
```

`npm run e2e` **只在本地跑**：它需要一份真实的 DSH 安装（默认 `/Applications/DSH Desktop.app`，可用 `APP=` 覆盖）。CI 不跑它，因为 runner 上没有 DSH。

## 代码约定

- **零运行时依赖**是硬约束：宿主半只用 Node 内置模块与 Cordis 上下文，客户端半只 `require` 运行时 seed 模块（`react`）与可选的 `@deepseek-ai/dsh-client-ui-primitives`。**不要**引入 `@deepseek-ai/schemastery` —— 插件装在各用户的 profile 目录下，那里解析不到 harness 自己的 node_modules，静态 import 会直接让插件装载失败。配置校验用零依赖的 Standard Schema（见 `lib/index.js` 的 `Config`）。
- **生成物必须过解析器**：`lib/core/assets/*.tpl` 渲染出的脚本会被 `bash -n` 校验（测试里已固化）。改模板后必须跑 `npm test`。
- **不要往生成脚本里插未校验的输入**：域名/用户名/路径都会被拼进 bash。新加参数时同步在 `lib/core/serversetup.js` 的校验里加规则，并补测试。
- **文案归属**：面板自己的界面文案在 `lib/client.js` 的 zh/en 字典里（组件只通过 `t()` 取词，不写字面量）；**宿主生成**的文案（前置检查结果、隧道状态、接口错误、CLI）在 `lib/core/messages.js` 的同一目录里。宿主半只发 `code` + `params`，由调用方按语言渲染——面板请求带 `?locale=`，CLI 用 `--lang`/环境变量。两份字典/目录的键集一致性与占位符一致性都有测试兜底。
- **新增后端时**：与语言无关的 argv 构造、输出解析、报错分类放进独立模块（参考 `lib/core/tailscale.js`），并写成纯函数；`lib/core/tunnel.js` 只负责生命周期与状态机。失败路径不要自动无限重试（配置类失败重试也不会好）。
- **注册即副作用**：host 半的每一次注册都通过 `ctx.effect()` 持有 disposer，保证卸载时端口与隧道被回收（测试会验证端口真的释放）。
- **文档成对更新**：`README.md`/`README.zh.md`、`docs/self-host.md`/`docs/self-host.zh.md` 各是一对，改一边就改另一边。事实只写一处，其余用链接；`docs/market-submission.md` 是给自己 fork 后上架用的（不进读者路径）。新增面向读者的文档时，记得同步 `package.json` 的 `files` 与 CI 的发布包检查——README 里链到的文件必须在包里，否则 npm 页面上是死链。
- **提交前**：`npm test && npm run gate`。

## 发布前检查清单（fork 后第一次发布必须做）

- [ ] `package.json` 的 `name` 换成你自己的 scope（`@you/dsh-plugin-remote-connect-beta`），或确认无 scope 名未被占用
- [ ] 补 `repository` / `homepage` / `bugs` / `author` 字段（本仓库刻意留空，避免把占位地址发上 npm）
- [ ] `LICENSE` 的版权行换成你的名字或组织
- [ ] `SECURITY.md` 里换成你的漏洞披露渠道
- [ ] 更新 `CHANGELOG.md` 与 `version`
- [ ] `npm run gate && npm test` 全绿
- [ ] `npm pack --dry-run --json` 确认发布包包含 `bin/` 与 `lib/core/assets/`
- [ ] `npm publish --provenance --access public`（在 GitHub Actions 里发可获得溯源）
- [ ] 打 tag 并做 GitHub Release；如做 Homebrew tap，用 `packaging/homebrew/dsh-remote.rb` 模板填 sha256
- [ ] 上架材料见 `docs/market-submission.md`

## 不接受的改动

- 任何形式的"托管 / 中转服务"（本项目明确不提供，见 README 与 SECURITY）
- 让 Harness 监听 `0.0.0.0` 的选项
- 关闭或弱化访问密钥门的选项（`serve --public` 无密钥必须拒绝启动）
- 把 `?k=` 或口令写进日志、错误信息、遥测的改动
