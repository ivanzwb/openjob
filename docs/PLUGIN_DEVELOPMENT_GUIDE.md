# OpenJob 插件开发指南

> 读者：想要为 OpenJob 新增一个岗位包或代码插件的开发者。
> 上位设计（为什么这样设计、系统边界）：[通用面试 Agent 插件化架构](./GENERAL_INTERVIEW_AGENT_ARCHITECTURE.md)。
> 本文只讲「怎么做」：目录结构、每个插入点怎么写、怎么校验、怎么打包分发。

---

## 1. 两种插件形态

| | 岗位包（role-pack） | 代码插件（plugin） |
|---|---|---|
| 回答的问题 | 这类岗位怎么被面试 | 提供一块宿主没有的功能/UI |
| 内容 | 声明数据（能力/题型/量规/Prompt 片段/检索策略/简历模块/能力声明），可选代码入口 | `main.ts` 入口 + `ui/` Webview 资源 |
| 典型例子 | `plugins/softwareEngineering` | `examples/portfolio-board` |
| 安装后 | 用户选岗即用 | 需用户确认权限清单后启用 |
| 移动端 | 随同步数据自动可用 | WebView 运行时激活同一份代码 |

一个岗位包可以同时是代码插件：manifest 声明 `main` 后，包内的 `main.ts`（编译为 main.js）与 `ui/` 资产随包分发（如 software-engineering 的「源码」页）。

---

## 2. 岗位包目录结构

```text
plugins/<your-pack>/
  package.json            # workspace 包声明（@openjob/plugin-<id>）
  index.ts                # defineRolePack 装配入口，不含业务内容
  ids.ts                  # 包 id / 版本 / 各类 ID 常量
  matchers.ts             # RoleMatcher：JD 归族规则
  competencies.ts         # 能力模板（权重和必须为 1）
  formats.ts              # InterviewFormat + InterviewStage
  rubrics/                # 一份量规一个文件 + anchors 辅助
  tasks.ts                # 任务模板
  capabilities.ts         # 插入点 E：内嵌能力声明
  resume-modules.ts       # 插入点 D：简历模块
  search-policy.ts        # 插入点 C：检索策略
  prompts/                # 插入点 B：Prompt 片段（frontmatter + markdown）
  navigation.ts           # 插入点 A：导航入口（没有就别建文件，index 里传 []）
  main.ts                 # 可选：代码入口（TS 编写，打包期编译为 main.js 入信封）
  ui/                     # 可选：代码入口的 Webview 资源

  contract.test.ts        # 契约测试（必写）
  golden.test.ts          # 黄金测试（必写）
```

用到的 ID（能力、题型、量规）统一放 `ids.ts`，格式/量规/任务文件相互引用时从那里拿，避免字符串散落。

### index.ts 模板

```ts
import type { RolePack } from '@core/plugins/types';
import { defineRolePack, packRoot } from '../../scripts/pack-authoring';
import { YOUR_PACK_ID, YOUR_PACK_VERSION } from './ids';
import { yourMatchers } from './matchers';
import { competencyTemplates } from './competencies';
import { interviewFormats, interviewStages } from './formats';
import { yourRubrics } from './rubrics';
import { taskTemplates } from './tasks';
import { capabilities } from './capabilities';
import { resumeModules } from './resume-modules';
import { sourcePolicy } from './search-policy';

export { YOUR_PACK_ID, YOUR_PACK_VERSION } from './ids';

export const yourRolePack: RolePack = defineRolePack({
  root: packRoot(import.meta.url),
  manifest: {
    id: YOUR_PACK_ID,
    version: YOUR_PACK_VERSION,
    type: 'role-pack',
    displayName: '数据分析',
    description: '一句话说清这个包提供什么。',
    compatibility: { core: '^1.0.0', schema: 23 },
    // 权限必须等于 capabilities 里各贡献 permission 的并集，否则装配直接报错
    permissions: ['artifact:read'],
    dependencies: [],
  },
  roleMatchers: yourMatchers,
  competencyTemplates,
  interviewStages,
  interviewFormats,
  rubrics: yourRubrics,
  taskTemplates,
  promptFragments: [],      // prompts/ 目录会被自动扫描
  navigation: [],           // 或从 ./navigation 导入
  resumeModules,
  capabilities,
  sourcePolicy,
});
```

`defineRolePack` 会就地做完整契约校验（权重求和、交叉引用、Prompt 片段安全检查、能力声明一致性、代码资产隔离扫描），错误带字段路径直接抛出——不用等运行期 resolver 才发现写错了。

---

## 3. 六个插入点

### A. 导航入口 `navigation[]`

```ts
import type { NavigationEntry } from '@core/plugins/types';

export const navigation: NavigationEntry[] = [
  {
    id: 'se.source-repository',
    label: '源码',
    pageId: 'source-repository',        // 宿主页面注册表里没有实现就不渲染
    requiredCapabilityId: 'source-repository',   // 引用本包内嵌的能力 id
    degradedHint: '克隆与索引需在桌面端完成。',
  },
];
```

入口渲染在主导航的固定能力页签槽位（「模拟面试」之后）。可见性 = 任一 Campaign 启用了 `requiredCapabilityId`。如果你需要的是自定义 UI 而不是宿主页面，走代码入口（§6 的 `ctx.views.registerPage`），两者进同一个槽位。

### B. 角色 Prompts `prompts/`

一个 markdown 文件就是一条片段，frontmatter 声明归属：

```markdown
---
slot: scoring
formatId: da.case
---
## 数据案例评分侧重
- 看指标口径是否说得清，用了黑话但讲不出定义的不给高分。
```

规则：

- `slot` 六选一：`diagnosis` / `explanation` / `questionGeneration` / `scoring` / `answerCoaching` / `debrief`。前三个和最后一个按阶段生效；`questionGeneration` / `scoring` / `answerCoaching` 按题型生效，**必须**写 `formatId`；
- 同 slot 同 formatId 只能有一条（装配时查重）；`formatId` 必须是本包 `interviewFormats` 里已有的 id；
- 片段用 `##` 及以下层级，`#` 一级标题属于 Core 骨架；禁止角色重置、绕过证据策略、权限提升类表述（静态检查会拦）；
- 没写片段的 slot 用 Core 默认，不强制全写。

### C. 检索策略 `sourcePolicy`

```ts
export const sourcePolicy: SourcePolicy = {
  preferredDomains: ['kdnuggets.com', 'mode.com'],
  credibilityOverrides: { 'mode.com': 4 },
  freshnessDays: { companyIntel: 7, interviewReports: 3, domainKnowledge: 730 },
};
```

只对该岗位的检索生效；用户在设置页手动改过的值永远优先。

### D. 简历模块 `resume-modules.ts`

```ts
export const resumeModules: ResumeModuleDefinition[] = [
  {
    id: 'da.analysis-samples',
    label: '分析案例',
    kind: 'list',                       // list | structured | text
    schemaVersion: 1,
    evidenceKinds: ['achievement'],
    instruction: '抽出候选人做过的完整分析案例：业务问题、用了什么数据、结论。',
  },
];
```

没有旧字段可派生就写 `instruction`（解析时进入附加抽取）；能从 `skills` / `projects.drillableTopics` 派生的写 `deriveFrom`，两者必选其一（可派生的不要带指令）。

### E. 内嵌能力 `capabilities.ts`

```ts
import type { CapabilityDeclaration } from '@core/plugins/types';

export const capabilities: CapabilityDeclaration[] = [
  {
    id: 'analytics-case',
    artifactParsers: [
      { artifactType: 'tabular-dataset', schemaVersion: 1, permission: 'artifact:read' },
    ],
  },
];
```

- `tools` / `interactions` / `artifactParsers` / `scenarios` 都是**声明数据**，随包分发；执行实现长在宿主里，按 id/name 绑定；
- `manifest.permissions` 必须等于所有贡献的 permission 加 `permissions` 字段的并集（宿主注册表推导，装配时强制）；
- 声明了宿主没有实现的工具，激活时该工具被跳过，岗位包本身不受影响。

### F. 领域模型

能力模板、题型、量规、任务模板、RoleMatcher 是插件系统的地基，写法对照现有三个包即可。要点：

- 能力 `defaultWeight` 总和为 1；量规维度 `weight` 总和为 1；每个等级必须有可观察行为锚点；
- `taskTemplates` 里带 `capabilityId` 的模板会成为排程贡献（源码任务就是 `se.read-code`）；
- RoleMatcher 用岗位标题正则 + JD 职责信号归族，不以公司名判断；excludeSignals 防跨岗位污染。

---

## 4. 代码插件（main.ts）

### Manifest

```json
{
  "id": "portfolio-board",
  "version": "1.0.0",
  "type": "plugin",
  "displayName": "作品集看板",
  "description": "……",
  "compatibility": { "core": "^1.0.0", "schema": 23 },
  "permissions": ["evidence:read-confirmed"],
  "main": "main.js",   # 信封产物名固定；作者写 main.ts，打包期编译
  "api": "^1.0"
}
```

独立代码插件 `type` 用 `"plugin"`；权限清单会在用户启用时逐条展示。

### 入口（TypeScript）

```ts
// main.ts —— 推荐用 TypeScript 编写；打包期由 esbuild 编译为 CJS 的 main.js 入信封。
// import type 会被擦除：运行时只依赖 require('openjob')，对宿主模块零依赖。
import type { PluginRuntimeContext } from '@core/plugins/pluginRuntime/host';

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({
    id: 'board',
    title: '作品集看板',
    webviewPath: 'ui/index.html',   // 必须在 ui/ 下
  });
  ctx.commands.register('portfolio.refresh', async () => { /* ... */ });
  ctx.events.on('campaign:attached', (payload) => { /* payload.campaignId */ });
  return function deactivate() { /* 撤掉自己的副作用 */ };
}
```

要点：

- 入口文件写 `main.ts`（推荐）或 `main.js`；**信封里的产物统一是 main.js**——签名、隔离扫描、两端执行的同一份编译产物，「签的 = 扫的 = 跑的」；
- `import type` 在编译时擦除，宿主模块不会进入插件产物；普通的 `import`/`require` 会在运行时被 require shim 拒绝；
- `ui/` 下的脚本目前保持纯 JavaScript（随 HTML 内联执行，无编译步骤）。

### ctx API 一览

| 命名空间 | 需要的权限 | 说明 |
|---|---|---|
| `ctx.views` | — | `registerPage({ id, title, webviewPath })`，页面进主导航能力页签槽位 |
| `ctx.commands` | — | `register(id, handler)`，完整 id 为 `<pluginId>:<id>` |
| `ctx.events` | — | 订阅白名单事件：`campaign:attached` / `campaign:capability-changed` / `practice:completed` |
| `ctx.campaign` | — | `getDescriptor(campaignId)` 只读运行配置 |
| `ctx.storage` | — | 插件私有 KV：`get / set / delete`（键数与值长有限制） |
| `ctx.llm` | `llm:complete` | `complete({ system, user, role? })` 受控 JSON 补全，同宿主网关与审计 |
| `ctx.agent` | `llm:complete` | `ask({ question, allowTools?, repoId?, campaignId? })` 开启流式问答；增量经 `stream:delta` / `stream:done` / `stream:error` 事件到达（按 `streamId` 过滤） |
| `ctx.evidence` | `evidence:read-confirmed` | `listConfirmed(campaignId)` 只读已确认证据 |

未声明的权限对应命名空间**不存在**（不是报错，是 `ctx.llm === undefined`）。

### Webview UI（ui/）

- 单页 HTML 起步即可；`ui/` 下可以拆分 js/css，页面里的**同包相对引用**（`<script src="app.js">`、`<link rel="stylesheet" href="style.css">`）渲染时自动内联；
- 外部 URL 原样保留——沙箱 iframe 无网络权限，自然加载失败；
- 页面与宿主通信走受控桥（桌面为 iframe postMessage，移动端为 WebView postMessage），只有白名单方法可用；
- 参考完整例子：`examples/portfolio-board/`。

### 启用与停用

- 独立代码插件装上后**默认停用**；用户在设置页确认权限清单后才激活，可随时停用（页签即时消失，确认记录保留）；
- 岗位包自带的代码入口（manifest 有 `main` 的 role-pack）随岗位启用，无需单独确认——选岗即视为授权。

### 隔离红线（安装期扫描，命中即拒）

入口与 ui/ 资产里不允许出现：`node:` 内建模块、`child_process`、`process.env`、`better-sqlite3`、`__dirname`/`__filename`、`electron`、`eval` / `new Function`、裸 `fetch`/`XMLHttpRequest`。需要什么能力走 `require('openjob')`。

---

## 5. 校验与测试

```bash
pnpm pack:validate        # 校验全部分发岗位包，逐包打印插入点清单
pnpm pack:validate product-manager   # 只看一个包
pnpm -r typecheck && pnpm test      # 全仓类型 + 测试
```

每个包必须自带两组测试（对照现有包抄结构）：

- **contract.test.ts**：`validateRolePack(pack)` 为空；manifest 关键字段断言（版本、权限并集、依赖可选性）；片段覆盖断言（每个题型都有出题/评分/话术）；
- **golden.test.ts**：RoleMatcher 对典型 JD 的命中/排除；跨岗位污染扫描（片段与组合结果里不得出现工程口吻）；能力缺席时降级路径成立。

新增包要登记进 `scripts/distributed-role-packs.ts` 才会进分发与 CI。

---

## 6. 打包与分发

```bash
pnpm pack:plugins                       # 打全部包 → dist-plugins/（签名信封 + index.json）
pnpm pack:plugins --only my-pack        # 只打一个包（独立发版）
pnpm verify:plugins                     # 打包并验签（CI 同款）
```

- 产物是 gzip JSON 的签名信封（Ed25519），私钥走 `OPENJOB_PLUGIN_PRIVATE_KEY` 环境变量；
- 用户从 release 附件安装，桌面端验签 → 格式校验 → 隔离扫描 → 落盘；
- 移动端不装包：随同步链路拿到包数据与编译后的代码资产，在 WebView 运行时里激活同一份产物。

发出去之后用户在设置页里就能看到：列表从**自动更新的同一个源**读（GitHub 走 `releases`
列表，自建目录走 `index.json`），所以把包挂上 release 就够了，不用改应用。一台设备只装
一个插件包，包之间互斥——想换一个岗位，得先在设置里卸载前一个。

---

## 7. 规则清单

必须：

- 所有 id 小写稳定、包内唯一；能力/题型/量规引用一律用 id；
- 片段、指令、声明全部是数据——没有可执行逻辑；
- 新岗位包不修改 Planner、Practice Engine、数据库层、Core Prompt Policy。

禁止：

- 代码插件运行时 `require` 除 `openjob` 外的任何模块；TS 里非 `import type` 的宿主模块导入同样会被 require shim 拒绝；
- 在片段里用一级标题、重置角色、绕过证据策略；
- 为某一端复制或改写包内容（一包定义、两端消费）；
- manifest 权限超出内嵌贡献的并集（少声明会漏授权，多声明直接拒装）。

---

## 8. 常见问题

**Q：片段写了没生效？** 检查 frontmatter 的 `slot` 拼写、`formatId` 是否是本包题型 id；`pnpm pack:validate` 的片段清单会列出每条片段的实际归属。

**Q：能力装了但任务没排？** 排程贡献从包 taskTemplates 派生：确认任务模板写了 `capabilityId`（就是本包内嵌声明的 id），且 descriptor 里该能力 enabled、本机清单里有它派生的能力条目。

**Q：页面在主导航上看不到？** 代码插件先确认已启用（设置页）；再看 `ctx.views.registerPage` 是否在 `activate` 同步调用（异步注册的页面在下次激活时才出现）。

**Q：想加一个新的 Prompt 阶段/Slot？** 这是 Core 契约变更（组合顺序 + 契约校验），不是插件能做的——到仓库提 issue。
