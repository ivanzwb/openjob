# OpenJob 插件开发指南

> 读者：想要为 OpenJob 新增一个岗位包或代码插件的开发者。
> 上位设计（为什么这样设计、系统边界）：[通用面试 Agent 插件化架构](./GENERAL_INTERVIEW_AGENT_ARCHITECTURE.md)。
> 本文只讲「怎么做」：第 1 节先给平台、原语与官方包的全貌，§2 起讲目录结构、每个插入点怎么写、
> 怎么校验、怎么打包分发。

---

## 1. 平台、原语与官方岗位包

### 1.1 基础 Agent 能做什么

基础 Agent 是稳定内核，只处理跨岗位共有的问题，装不装岗位包都能跑：

- **输入与事实**：导入并解析简历、JD 与面试日期；管理作品、案例、证书、演示材料；建立候选人证据库
  （来源、可信度、原文定位）。JD 要求与公司信息不会被当成候选人经历。
- **岗位建模**：识别岗位族、职能、级别、行业与地区，选定主岗位包，按 JD 调整默认能力权重，生成本次
  Campaign 的面试蓝图。
- **诊断与计划**：把岗位能力与候选人证据交叉分析，按面试概率、证据强度、掌握差距与剩余时间排序，
  生成每日训练计划并按练习结果动态调整。
- **训练与反馈**：统一管理题目、作答、追问、评分与复练；支持文本、语音与插件提供的专用交互；评分
  回写能力掌握度；高价值答案沉淀为故事与话术；面试后摄入真实问题修正能力图谱。
- **通用面试能力基线**（随基础包发布，不参与岗位包依赖解析）：自我介绍、简历经历深挖、STAR/CAR
  故事、求职动机、优势与短板、冲突/失败/推动/学习等行为题、公司与岗位匹配、反问面试官。
- **两端与平台**：桌面与移动客户端、局域网同步（加密 + 冲突合并）、自动更新与回滚、备份与保留策略、
  本地模型的离线链路。

岗位包补的是「这类岗位怎么被面试」：能力有哪些、题怎么出、怎么评分、优先信哪些信息源、需不需要源码
或表格这类专用工具、导航里出现哪些页签、简历页出现哪些模块。

### 1.2 包能用的通用原语

包跑在沙箱里，不直接碰文件系统、子进程、数据库与网络，一切能力经 `openjob.*` 的通用原语。命名空间
一览就是一张地图：

- `ctx.storage`（包私有 KV，两端共用一份）、`ctx.campaign`（只读本 Campaign 的运行配置）、
  `ctx.views` / `ctx.commands` / `ctx.events` / `ctx.bridge`（注册页面 / 命令、订阅宿主事件、声明桥方法）——无权限门槛；
- `ctx.data`（本包声明的数据集合，跨端同步）、`ctx.workspace`（含 `workspace.symbols` /
  `workspace.fetch`）、`ctx.artifact`、`ctx.llm` / `ctx.agent`、`ctx.evidence`、`ctx.library`——按需声明，
  未声明的命名空间在包里是 `undefined`。

每个命名空间的逐个方法、参数与上限见 §4 的 `ctx.*` 一览；题型、材料与任务视图的声明见 §3.F，
数据集合的声明与用法见 §4 的「包声明的数据集合与材料」。

**包内的 Webview 页面走同一批原语**，只是换成桥方法名：入口代码里的 `ctx.workspace.glob(pattern)`，
页面里是 `call('workspace.glob', { pattern })`。页面能调的方法 = 包声明 ∩ 本机原语表 ∩ 权限网关放行——
入口代码里逐条 `ctx.bridge.declare('workspace.glob')` 声明，未声明的方法页面够不到；每个原语自带权限项，
放行由权限网关逐次判（端侧一次、主进程一次）。声明本身不带权限，也不能把权限转给别的包。

### 1.3 两种插件形态

| | 岗位包（role-pack） | 代码插件（plugin） |
|---|---|---|
| 回答的问题 | 这类岗位怎么被面试 | 在通用原语之上实现一块基础包不该有的功能 / UI |
| 内容 | 声明数据（能力 / 题型 / 量规 / 任务模板 / Prompt 片段 / 检索策略 / 简历模块 / 数据集合），可选 `desktop/` + `mobile/` 两份代码实现 | `desktop/main.ts` 与 `mobile/main.ts` 各端入口 + `ui/` Webview 资源 |
| 典型例子 | `plugins/softwareEngineering`（同时是代码插件） | `examples/portfolio-board` |
| 安装后 | 用户选岗即用 | 装上即激活（安装时展示权限清单，无单独的「启用」步骤） |
| 移动端 | 声明数据随同步可用；代码入口在 WebView 运行时里激活移动端那份 | WebView 运行时激活移动端那份代码 |

一个岗位包可以同时是代码插件：manifest 声明 `main` / `mobile` 后，包内 `desktop/` 与 `mobile/` 两份实现（各自的 `main.ts` 编译为 `main.js`）与 `ui/` 资产随包分发（如 software-engineering 的「源码」页）。

**实现归属**：基础包只提供与岗位无关的基础设施和**通用原语**（工作区、artifact、LLM、证据、存储）；
**岗位簇的功能实现、领域概念、专属表、专属通道、专属文案都放进包**，不要去改基础包。包的行为由包
自己的入口代码承担（§4），它跑在沙箱里，只能经 `openjob.*` 的原语触碰宿主资源。

### 1.4 官方岗位包

| 包 | 提供什么 | 包内页面 |
|----|---------|---------|
| `software-engineering` | 技术知识问答、编码与算法、系统设计、项目技术深挖；技术准确性与设计权衡量规；`se.tech-stack` 与 `se.drillable-tech-topics` 简历模块；官方文档优先的检索策略。内嵌能力 `source-repository`：仓库拉取、符号提取、代码检索与问答，`codeAgent` 角色由本包声明；数据集合 `repositories` / `code-refs` / `repository-files` / `qa-history` / `repository-indexes` | 桌面与手机各一份实现：「源码」页（`desktop/ui/repositories.html` + `mobile/ui/repositories.html`） |
| `product-manager` | 产品 Sense、用户问题定义、指标与数据分析、优先级、产品案例、路线图、跨团队推动；产品决策与复盘量规；`pm.business-metrics` 与 `pm.product-outcomes` 简历模块；行业报告优先的检索策略。内嵌能力 `analytics-case`：表格数据集解析与数据案例评分侧重；数据集合 `cases`；可选依赖 `portfolio-review`（尚未实现，缺席时降级为 disabled） | 桌面与手机各一份实现：「案例训练」页（`desktop/ui/practice.html` + `mobile/ui/practice.html`） |
| `sales-customer-success` | 客户发现、价值表达、异议处理、方案陈述、谈判、Pipeline 推进；应变、倾听与推进量规；内嵌能力 `role-play`：客户对话对练，需要 `llm:complete` 与 `microphone:read`（人设与开场白等素材在本包页面里，宿主不再持有）；数据集合 `role-play-sessions` | 桌面与手机各一份实现：「客户对话模拟」页（`desktop/ui/role-play.html` + `mobile/ui/role-play.html`） |

三个包住在 `plugins/` 下（`@plugins` 别名，只有打包脚本与测试会 import），随 release 以 `.ojb`
分发；装、卸、升级与目录来源见 §6。

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
  examForms.ts            # 题型声明（也可直接写在 index.ts 里）
  rubrics/                # 一份量规一个文件 + anchors 辅助
  tasks.ts                # 任务模板（taskKind / materialKind / materialCollection / view）
  capabilities.ts         # 插入点 E：内嵌能力声明
  resume-modules.ts       # 插入点 D：简历模块
  search-policy.ts        # 插入点 C：检索策略
  prompts/                # 插入点 B：Prompt 片段（frontmatter + markdown）
  navigation.ts           # 插入点 A：导航入口（没有就别建文件，index 里传 []）
  desktop/                # 可选：桌面端代码实现
    main.ts               #   TS 编写，打包期编译为 desktop/main.js 入信封
    ui/                   #   该端的 Webview 资源
  mobile/                 # 可选：移动端代码实现（同构，布局适配触摸屏）
    main.ts               #   打包期编译为 mobile/main.js
    ui/                   #   该端的 Webview 资源

  contract.test.ts        # 契约测试（必写）
  golden.test.ts          # 黄金测试（必写）
```

用到的 ID（能力、题型、量规）统一放 `ids.ts`，格式/量规/任务文件相互引用时从那里拿，避免字符串散落。

### 一个包，两端两份实现

包自带代码时，`desktop/` 与 `mobile/` 各成一份实现：各自的 `main.ts` 打包期编译成 `desktop/main.js`
与 `mobile/main.js`，各自的 `ui/` 放该端的 Webview 资源。签名、隔离扫描与执行都针对编译产物，
「签的 = 扫的 = 跑的」。两端共用同一套桥协议，差异只在**本机有哪些原语**：桌面有的原语手机上如实
拒绝，所以手机端页面按「读得到、不假装能执行」来写。三个官方包就是这样落的：

| 包 | `desktop/` | `mobile/` | 桌面做得到 | 手机做得到 |
|----|-----------|-----------|-----------|-----------|
| `software-engineering` | `main.ts` + `ui/repositories.html` | 同结构 | 拉取 / 更新仓库、概览、建索引、问源码、存话术、打代码标记 | 读 `repositories` 与同步来的索引、只读浏览配对桌面的检出、问源码（代理到桌面）、存话术、只读列出桌面写入的标记 |
| `product-manager` | `main.ts` + `ui/practice.html` | 同结构 | 选表格、出题、评分、推荐答案 | 只读 `cases` 集合（历史案例） |
| `sales-customer-success` | `main.ts` + `ui/role-play.html` | 同结构 | 客户对话对练、意图标注 | 只读 `role-play-sessions` 集合（对练记录） |

两端的 `main.ts`（以软件工程包为例）只做两件事：注册本包的页面、逐条声明桥方法（声明只决定「能不能到网关」，放行仍由权限网关逐次判）：

```ts
// desktop/main.ts —— 桌面端的全部请求面都在这一串声明里
const BRIDGE_METHODS = [
  'workspace.fetch', 'workspace.delete', 'workspace.glob', 'workspace.list', 'workspace.read',
  'workspace.grep', 'workspace.symbols', 'llm.complete',
  'data.list', 'data.get', 'data.put', 'data.delete', 'agent.ask',
  'library.saveSnippet', 'library.listSnippets',
  'library.annotate', 'library.listAnnotations', 'library.deleteAnnotation',
] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({ id: 'source-repository', title: '源码', webviewPath: 'ui/repositories.html' });
  const declared = BRIDGE_METHODS.map((method) => ctx.bridge.declare(method));
  return () => declared.forEach((handle) => handle.dispose());
}
```

```ts
// mobile/main.ts —— 同一个页面 id，只声明本端真的做得到的原语
const BRIDGE_METHODS = [
  'data.list', 'workspace.list', 'workspace.read', 'agent.ask',
  'library.saveSnippet', 'library.listSnippets', 'library.listAnnotations',
] as const;

export function activate(ctx: PluginRuntimeContext): () => void {
  ctx.views.registerPage({ id: 'source-repository', title: '源码', webviewPath: 'ui/repositories.html' });
  const declared = BRIDGE_METHODS.map((method) => ctx.bridge.declare(method));
  return () => declared.forEach((handle) => handle.dispose());
}
```

### index.ts 模板

```ts
import type { RolePack } from '@core/plugins/types';
import { defineRolePack, packRoot } from '../../scripts/pack-authoring';
import { YOUR_PACK_ID, YOUR_PACK_VERSION } from './ids';
import { yourMatchers } from './matchers';
import { competencyTemplates } from './competencies';
import { interviewFormats, interviewStages } from './formats';
import { yourExamForms } from './examForms';
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
    // 可选：本包自带的代码实现（两端各一份）。声明后必须提供 desktop/main.js 与 mobile/main.js
    main: 'desktop/main.js',
    mobile: 'mobile/main.js',
    api: '^1.0',
    // 本包自己的数据集合：宿主建通用承载表，内容对宿主不透明（用法见 §4）
    dataCollections: [{ name: 'cases', schemaVersion: 1 }],
    dependencies: [],
  },
  roleMatchers: yourMatchers,
  competencyTemplates,
  interviewStages,
  interviewFormats,
  examForms: yourExamForms,     // 本包声明的题型（§3.F）
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

- `tools` / `interactions` / `artifactParsers` / `scenarios` 都是**声明数据**，随包分发——声明里没有实现，也不允许夹带实现；
- **实现归包**：能力怎么干活写在本包自己的入口代码里（§4），通过 `openjob.*` 的通用原语触碰宿主资源（工作区、artifact、LLM、证据、存储）；基础包不认识这个能力在做什么，只按声明的 id 与权限放行；
- `manifest.permissions` 必须等于所有贡献的 permission 加 `permissions` 字段的并集（按已安装包的 manifest 推导，装配时强制）；
- 声明了基础包还没有对应原语或权限的贡献，激活时该能力降级为 disabled，岗位包本身不受影响。

### F. 领域模型

能力模板、题型、量规、任务模板、RoleMatcher 是插件系统的地基，写法对照现有三个包即可。

**题型 `examForms`**：本包声明的题型词汇。`id` 会写进 `knowledge_node.exam_forms`，练习、历史与界面都
按它取值——宿主只当不透明字符串，不认识任何一个取值。

```ts
import type { ExamFormDefinition } from '@core/plugins/types';

export const yourExamForms: ExamFormDefinition[] = [
  {
    id: 'da.case',                              // 题型 id，包内唯一
    label: '数据案例',                           // 展示名（练习页题型下拉、历史行标注）
    formatId: 'da.case',                        // 落到本包哪个 InterviewFormatDefinition
    diagnosisHint: '数据案例：口径、推断与结论',   // 诊断时给模型的一句说明
  },
];
```

**任务模板 `taskTemplates`**：`taskKind` 是包自己声明的字符串（宿主的 `learn` / `drill` / `review` /
`fallbackScript` 是宿主自己的种类）。带 `capabilityId` 的模板会成为排程贡献；需要一份外部材料时成对声明
`materialKind` + `materialCollection`；任务页用 `view.pageId` 指向本包的页面。

```ts
{
  id: 'da.read-data',
  label: '结合数据理解口径',
  taskKind: 'readData',
  defaultMinutes: 25,
  capabilityId: 'analytics-case',
  materialKind: 'dataset',            // 任务需要一份材料
  materialCollection: 'datasets',     // 材料放在本包哪个数据集合（必须在 manifest.dataCollections 里声明）
  view: { pageId: 'case-practice' },  // 任务页由本包页面承担；缺省回落宿主的考点视图
}
```

要点：

- 能力 `defaultWeight` 总和为 1；量规维度 `weight` 总和为 1；每个等级必须有可观察行为锚点；
- `examForms[].formatId`、`taskTemplates[].supportedFormats`、`materialCollection` 都在装配时做交叉校验；
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
  "main": "desktop/main.js",     # 桌面入口；作者写 desktop/main.ts，打包期编译
  "mobile": "mobile/main.js",    # 移动入口；不声明 = 该端不出现页签
  "api": "^1.0"
}
```

独立代码插件 `type` 用 `"plugin"`；权限清单会在安装时逐条展示。

### 入口（TypeScript）

```ts
// desktop/main.ts —— 推荐用 TypeScript 编写；打包期由 esbuild 编译为 CJS 的 main.js 入信封。
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

- 入口文件写 `main.ts`（推荐）或 `main.js`，分别放在 `desktop/` 与 `mobile/` 下；**信封里的产物是 `desktop/main.js` 与 `mobile/main.js`**——签名、隔离扫描、两端执行的都是各自那份编译产物，「签的 = 扫的 = 跑的」；
- 注册的页面要在 `manifest.pages` 里同步声明一份（`pages: [{ id: 'board', title: '作品集看板' }]`，id 与 `registerPage` 一致）。页面是激活时才注册的，宿主在那之前拿不到 id 与标题；手机端的页面入口（「更多」里那一项）就是按这份声明渲染并按 `<pluginId>:<pageId>` 打开的，不声明就只剩包名可用、也点不进指定页面；
- `import type` 在编译时擦除，宿主模块不会进入插件产物；普通的 `import`/`require` 会在运行时被 require shim 拒绝；
- `ui/` 下的 `.ts` 在打包期由 esbuild 编译为 CJS（与入口同一条规则：签的 = 扫的 = 跑的），页面直接加载编译产物。

### ctx API 一览

| 命名空间 | 需要的权限 | 说明 |
|---|---|---|
| `ctx.views` | — | `registerPage({ id, title, webviewPath })`，页面进主导航能力页签槽位 |
| `ctx.commands` | — | `register(id, handler)`，完整 id 为 `<pluginId>:<id>` |
| `ctx.events` | — | 订阅白名单事件：`campaign:attached` / `campaign:capability-changed` / `practice:completed` / `annotation:open` |
| `ctx.campaign` | — | `getDescriptor(campaignId)` 只读运行配置 |
| `ctx.storage` | — | 插件私有 KV：`get / set / delete`（键数与值长有限制） |
| `ctx.data` | — | 本包声明的数据集合：`get / put / delete / list / count`，值一律字符串，内容对宿主不透明；一次调用只允许本包 `manifest.dataCollections` 里声明过的集合，手机端对配对桌面只读（见下节） |
| `ctx.workspace` | `filesystem:workspace` | **通用原语**：本包工作区内的读 / 写 / 删 / 遍历 / glob / grep / 文本快照 / 批量符号提取；`fetch(url, { dir? })` 从远端拉取公开的 https 仓库到本包目录（**另需 `network:fetch`**；不带凭据、不指向内网、深度 1、有体积上限）。路径越出本包目录即拒 |
| `ctx.artifact` | `artifact:read` | **通用原语**：读用户显式选择的文件（表格 / 文档） |
| `ctx.llm` | `llm:complete` | `complete({ system, user, role? })` 受控 JSON 补全，同宿主网关与审计 |
| `ctx.agent` | `llm:complete` | `ask({ question, allowTools?, campaignId? })` 开启流式问答；增量经 `stream:delta` / `stream:done` / `stream:error` 事件到达（按 `streamId` 过滤）。**领域上下文由包自己组合**（本能力 + 自己的数据），宿主不为某个领域单开参数或通道 |
| `ctx.evidence` | `evidence:read-confirmed` | `listConfirmed(campaignId)` 只读已确认证据 |
| `ctx.library` | `library:write` | 用户的话术库与宿主标记汇总：`saveSnippet` / `listSnippets`（来源类型由包自己起）、`annotate` / `listAnnotations` / `deleteAnnotation` |
| `ctx.bridge` | — | `declare(method)`：把本包的桥方法登记给宿主，页面才够得到（声明 ≠ 有权限） |

未声明的权限对应命名空间**不存在**（不是报错，是 `ctx.llm === undefined`）。

### 包声明的数据集合与材料

需要跨端保存的数据（仓库登记、案例、对练会话……）走 `manifest.dataCollections` + `ctx.data`，不用自己
建表：

```json
// manifest.json
"dataCollections": [{ "name": "cases", "schemaVersion": 1 }]
```

```ts
// 入口代码或页面里
await ctx.data.put('cases', caseId, JSON.stringify(entry));   // 值一律字符串，包自己序列化与反序列化
const rows = await ctx.data.list('cases', { prefix: 'case:', limit: 200 });
const count = await ctx.data.count('cases');
```

规则：

- **声明即授权**：调用只对「本包 `manifest.dataCollections` 里声明过」的集合放行，而且只看得到本包自己
  的行；宿主不认识集合名，只按 `(pluginId, collection, key)` 归档与取用，内容对它不透明；
- 承载表 `plugin_data` 参与既有同步：桌面写入，手机读得到；手机端对配对桌面只读（`put` / `delete`
  在手机端如实拒绝）；
- 键 / 值有长度上限，`list` 的前缀按字面匹配（`%` / `_` 不当通配符），结果按 `limit` 截断、可按前缀翻页。

**材料约定**：任务模板成对声明 `materialKind` + `materialCollection` 时，排程从该集合里挑一份材料挂到
任务上。集合里的行是包自己序列化的 JSON 字符串，宿主只读三个字段——`id`（必需）、`label`（缺省用
`id`）、`ready`（布尔，缺省 false）；其余内容归包所有。有多份可用材料（`ready === true`）时按
`(label, id)` 取第一份，两端因此排到同一份：

```json
{ "id": "repo-1", "label": "github.com/org/app", "ready": true, "url": "https://github.com/org/app.git" }
```

三个官方包的落点：软件工程把仓库登记写进 `repositories` 集合（`se.read-code` 任务按 `code-repository`
取材料），产品经理的案例写进 `cases`，销售的客户对话写进 `role-play-sessions`；各自的任务页由
`view.pageId` 指向本包页面（§2 的两端两份实现表）。

### Webview UI（ui/）

- 单页 HTML 起步即可；`ui/` 下可以拆分 js/css，页面里的**同包相对引用**（`<script src="app.js">`、`<link rel="stylesheet" href="style.css">`）渲染时自动内联；
- 外部 URL 原样保留——沙箱 iframe 无网络权限，自然加载失败；
- 页面与宿主通信走受控桥（桌面为 iframe postMessage，移动端为 WebView postMessage），只有**本包声明的**桥方法可用（宿主按声明与前缀命名空间放行）；
- 参考完整例子：`examples/portfolio-board/`。

### 启用与停用

- 所有包装上即激活：安装时展示权限清单，装载后宿主立即调用入口的 `activate(ctx)`，每次启动与安装清单变化时自动重新激活；
- 没有单独的「启用 / 停用」状态与按钮——要停用就卸载（卸载先调 deactivate 再撤贡献，页签即时消失）。

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
pnpm pack:plugins                       # 打全部包 → dist-plugins/（<id>@<version>.ojb + index.json）
pnpm pack:plugins --only my-pack        # 只打一个包（独立发版）
pnpm verify:plugins                     # 打包并验签（CI 同款）
```

- 产物是 `.ojb`：**gzip 压缩的 JSON 信封**（Ed25519 签名盖在解压后的文件集合上），私钥走 `OPENJOB_PLUGIN_PRIVATE_KEY` 环境变量；
- 用户从 release 附件安装，桌面端验签 → 格式校验 → 隔离扫描 → 落盘。**不接受裸 JSON 或目录**：文件对话框只认 `.ojb`，文件头不是 gzip 的直接拒；
- 移动端不装包：随同步链路拿到包数据与编译后的代码资产，在 WebView 运行时里激活同一份产物。

发出去之后用户在设置页里就能看到：列表从**自动更新的同一个源**读（GitHub 走 `releases`
列表，自建目录走 `index.json`），所以把包挂上 release 就够了，不用改应用。一台设备只装
一个插件包，包之间互斥——想换一个岗位，得先在设置里卸载前一个。

---

## 7. 规则清单

必须：

- 所有 id 小写稳定、包内唯一；能力/题型/量规引用一律用 id；
- 片段、指令、声明全部是数据——没有可执行逻辑；行为写进包自己的入口代码（§4）；
- **岗位簇的实现在包里**：不往基础包加岗位专属的实现、表、通道、文案或按岗位分派的代码；
- 新岗位包不修改 Planner、Practice Engine、数据库层、Core Prompt Policy。

禁止：

- 代码插件运行时 `require` 除 `openjob` 外的任何模块；TS 里非 `import type` 的宿主模块导入同样会被 require shim 拒绝；
- 在片段里用一级标题、重置角色、绕过证据策略；
- 为某一端复制或改写岗位包的**声明内容**（一包定义、两端消费）；代码入口允许两端各自一份实现（§2）；
- 岗位包的 manifest 权限超出内嵌贡献的并集（少声明会漏授权，多声明直接拒装）。

---

## 8. 常见问题

**Q：片段写了没生效？** 检查 frontmatter 的 `slot` 拼写、`formatId` 是否是本包题型 id；`pnpm pack:validate` 的片段清单会列出每条片段的实际归属。

**Q：能力装了但任务没排？** 排程贡献从包 taskTemplates 派生：确认任务模板写了 `capabilityId`（就是本包内嵌声明的 id），且 descriptor 里该能力 enabled、本机清单里有它派生的能力条目。

**Q：页面在主导航上看不到？** 代码插件先确认已启用（设置页）；再看 `ctx.views.registerPage` 是否在 `activate` 同步调用（异步注册的页面在下次激活时才出现）。

**Q：想加一个新的 Prompt 阶段/Slot？** 这是 Core 契约变更（组合顺序 + 契约校验），不是插件能做的——到仓库提 issue。

**Q：想加一个新功能或新页面？** 页面走 `ctx.views.registerPage` + `ui/`（§4）；功能写进包自己的入口代码，用 `openjob.*` 的通用原语实现。**不要往基础包塞岗位专属的实现**——基础包只放与岗位无关的基础设施与通用原语。确实缺原语（比如要访问一种宿主还没提供的资源）就来提 issue：那是平台扩展，不是包作者能绕过的边界。

**Q：任务排出来了，但材料没挂上？** 带材料的任务模板要成对声明 `materialKind` + `materialCollection`，而且那个集合要在 `manifest.dataCollections` 里声明；排程只挑集合里 `ready === true` 的行。集合里没有可用材料时这个任务不排，而不是排一条空任务。

**Q：岗位簇的实现应该放哪儿？** 放进包里：功能实现、页面 UI、专属数据集合都随包分发，基础包只提供与岗位无关的基础设施和通用原语。包侧实现与通用原语的分工见 `PLUGIN_DISTRIBUTION_PLAN.md` §11。
