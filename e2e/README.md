# 端到端测试（E2E）

在**真实的 Electron 应用**上按用户看得见的动作走完整链路：真窗口、真数据库、真进程。
用例清单与覆盖矩阵见 [docs/E2E_TEST_PLAN.md](../docs/E2E_TEST_PLAN.md)。

```bash
pnpm test:e2e                 # 全部
pnpm test:e2e cases/practice  # 单个文件
```

与 `pnpm test` 分开是刻意的：这一套要起图形进程，跑一次几十秒，不该拖慢每次提交都要跑的那批单测。

## 它怎么跑起来的

```
e2e/
  harness/
    app.ts       启停隔离实例 + CDP 驱动（主页面与插件页两个 target）
    stub.ts      冒充模型 Provider 与检索 Provider 的本地桩（含请求日志与失败注入）
    env.ts       每例一份 userData：config / secrets / 插件 / 额外文件
    db.ts        直读副本的 SQLite 做断言
    seed.ts      走应用自己的 IPC 建岗位 / 简历 / 备考 / 画像
    legacy.ts    造 0.6.x 旧库与半迁移库
    fixtures 在仓库里：夹具库用 desktop/src/main/db 下的现有 SQL
  cases/         用例（编号与方案文档一致）
  .runs/         跑起来的副本，gitignore 了，失败时留着复盘
```

**隔离**：每例一份 `userData`，用 `--user-data-dir` 指过去。单实例锁按 userData 隔离，所以
用例之间、以及用例与你自己正在跑的应用之间都不会打架。副本全部落在 `e2e/.runs/`，
不碰 `%APPDATA%` 下的真实数据。跑完（或断言失败时）可以直接翻那份目录。

**AI 路径是确定性的**：把副本 `config.json` 里的 provider baseUrl 与检索 endpoint 指向
`stub.ts`——应用的调用路径一行都不用改。桩按 prompt 里声明的 JSON 字段名分派返回体
（`"scenarioMd"` / `"dimensions"` / `"repoMap"`…），所以片段改字不会让它失效。

**三条断言面**：界面（DOM 文本与控件状态）、落库（直读副本的库）、桩日志（AI / 检索请求的
次数与内容）。L2 以上的用例至少两条同时成立才算过。

## 写用例时的两条约定

1. **状态类断言走 IPC**（`app.page.invoke(channel, payload)`）——那是渲染层与应用之间真正的
   契约，与用户点界面走的是同一条路；比点 DOM 稳得多。
2. **展示类断言才点界面**，并且要限定在**当前激活的面板**里（`harness/ui.ts` 的 `ACTIVE`）：
   应用把所有页签留在 DOM 里、只用 `hidden` 隐藏，不限定就会命中别的页签里的同名元素。
   插件页在沙箱 iframe（`about:srcdoc`）里，要用 `app.waitForFrame()` 单独连一个 target。

## 已知限制

| 项 | 原因 | 现在的做法 |
|---|---|---|
| 链接仓库（`workspace.fetch`） | 宿主要求**公网 https**，本地裸仓库与 `file://` 一律拒绝（SSRF 防线） | 只自动化拒绝路径（E152/ERR-03 一类）；真实 clone 需外网，留手工 |
| Tavily 检索 | `https://api.tavily.com` 是硬编码的，没有可配的 endpoint | 检索桩只盖博查；路由到 Tavily 的用例不自动化 |
| `plugin:install` | 走原生文件对话框，渲染层传不了路径 | E2E 覆盖扫描路径（被篡改的包被判「被拒」并可删）；安装入口由 `desktop/src/main/plugins/install.test.ts` 覆盖 |
| `diagnosis:ingestReport` | 模型返回结构的桩还没复刻 | 用例 `it.skip` 并写明原因，补桩后打开 |
| 备考页的界面呈现 | 应用启动时就挂载了，外部 IPC 写入不 bump 渲染层数据版本，列表停在挂载时的空态 | 同上，走界面新建再打开即可绕过 |
