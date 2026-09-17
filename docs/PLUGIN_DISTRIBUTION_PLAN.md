# 基础包 + 外置插件：设计与分阶段任务

v1.0 把内核插件化了，但三个岗位包（及其内嵌的能力声明）仍然编译进应用一起发布。本文定义
下一步：**默认打出来的是基础包，插件单独 release、单独安装，基础包里能浏览并选择安装**。

## 1. 现状与差距

下表是本文写作时的差距盘点（已按 §9 落地，保留作记录）；其中「能力插件」一行已被 §3 推翻——
能力声明可以录成 JSON 重放，不必加载外部代码。

| 事实 | 位置 | 对外置插件的影响 |
|------|------|------------------|
| 已安装清单 ≡ 内置清单 | `desktop/src/main/plugins/runtime.ts` `listInstalledPlugins()` | 没有「已安装」这个独立概念 |
| 注册表只在模块加载时被内置数组填充 | `core/src/plugins/builtin/index.ts` | 没有从磁盘动态注册的入口 |
| `userData` 下没有插件目录 | `desktop/src/main/paths.ts` `getAppPaths()` | 装到哪里都还没定 |
| 能力插件必须提供可执行 `register()` | `core/src/plugins/contracts.ts`；resolver 在解析时真的调用它 | **无法做成纯 JSON**，外置就等于加载外部代码 |
| 权限契约由内置数组推导 | `desktop/src/main/plugins/permissionGateway.ts` `BUILT_IN_PERMISSION_CONTRACTS` | 未登记的 id 一律 `permission-undeclared`，外置插件直接被拒 |
| 隔离的第二层是**扫描仓库内插件源码** | `desktop/src/main/plugins/capabilityIsolation.test.ts` | 外部产物没有源码树可扫，这层保障失效 |
| 练习路径缺包直接抛错 | `desktop/src/main/practice/rolePack.ts` `findRolePack` → `PracticeError` | 外置之后「缺包」是常态，不能抛 |
| 手机端没有 resolver | `desktop/src/main/sync/rpc.contract.test.ts` 明确禁止 | 手机端无法自己解析依赖，只能消费下发结果 |
| 手机端能力视图默认填桌面内置清单 | `desktop/src/main/plugins/runtime.ts` | 两端安装集合一旦不同就会误报 |

岗位包（`RolePack`）的**数据部分**是纯数据——匹配器、能力项、阶段、题型、量规、任务模板、
提示词片段、源码策略、内嵌能力声明。带 `main` 的包才携带代码（§3 的两类包）。这个差别
决定了两类包走两条不同的加载路径。

## 2. 包格式

一个插件包在盘上是一个目录，分发时打成一个 **`.ojb`** 文件：**gzip 压缩的 JSON 信封**（不是
zip，理由见 §3），解压后是 `{ files: { <包内文件名>: <内容> } }`。签名盖在解压后的文件集合上，
信封里的键在写盘之前先过白名单。

```text
<id>@<version>/
  manifest.json      # 现有 PluginManifest，已保证可 JSON 往返
  pack.json          # 仅岗位包：全部数据
  contributions.json # 仅独立能力包（已不再分发，格式保留）：注册声明（见 §3）
  openjob.sig        # Ed25519 签名，内嵌签名者公钥，覆盖上面所有文件的规范化摘要
```

分发文件名是 `<id>@<version>.ojb`，`index.json` 里的 `bytes` 与 `sha256` 按**压缩后**的字节算
（下载端拿到的就是这些字节）。

文件名是**白名单**，出现第四个名字就拒装。黑名单挡不住没想到的扩展名，而「包里多一个
文件」是夹带可执行载荷的唯一入口。

## 3. 隔离：装载路径上不执行包代码

先分清两类包，它们共享同一套准入，但「包里有什么」不同：

- **数据包**（`role-pack` / `capability` / `industry-pack`）：包里只有声明，没有可执行的东西。
  本节下面讲的**重放**就是为这一类成立的。
- **代码包**（`plugin`，见 §7.9 与 ARCH §7.9）：包自带按端平铺的 `desktop/` 与 `mobile/`
  （各含 `main.js` 与 `ui/`），但装载路径同样
  不执行它——宿主只把它当字符串读出来（`plugin:getEntrySource`），激活发生在**渲染层沙箱**里，
  页面在 `sandbox="allow-scripts"` 的 Webview 里。

所以 P03 那条保障的准确措辞是「**装载路径上不存在代码执行入口**」，不是「包里没有代码」。

原计划是「沙箱宿主 + 权限代理 + 贡献固化」，实现 P01 时发现前提是错的。

`CapabilityRegistry` 的三个注册方法（`registerTool` / `registerArtifactParser` /
`registerInteractionType`）接受的全是可序列化结构，工具的**真实实现留在宿主里**——
`builtin/sourceRepository/index.ts` 自己的注释就写着「declaration only」，实现在
`desktop/src/main/repo/tools.ts`。也就是说插件从来只贡献声明，`register()` 唯一的作用是把这些
声明推给 registry。

那么把「推的动作」录成 `contributions.json` 随包发布，装载时重放一遍（`package/replay.ts`），
与执行插件自己的 `register()` **完全等价**，且不需要执行任何外部代码。于是：

- 不需要 `utilityProcess`，不需要 `node:vm`，不需要跨进程 RPC；
- resolver 保持同步，因为它读的仍然是纯数据；
- 隔离保障**完整保留**，不是退到「运行时被拦住」——数据包里根本没有可执行的东西。

代价换了个地方，必须说清楚：**数据包只能声明宿主已经提供的东西**，它扩展的是配置面（岗位、
题型、量规、提示词、各类声明），不是宿主行为。要加**新的行为与 UI**，走代码通道：包自带入口
代码，在沙箱里编排宿主的**通用原语**（工作区、artifact、LLM、证据、存储）实现自己的功能，
页面用包自己的 Webview。

于是基础包与岗位包的分界是「**与岗位无关的基础设施 vs 岗位簇的实现**」：基础包不实现任何岗位簇
的功能，岗位簇的实现随包分发。这条分界的现状盘点与搬迁计划见 §11（尚未完成，正在迁移中）。

## 4. 信任链

`node:crypto` 原生支持 Ed25519，零新依赖。第一方发布公钥内置在基础包里；签名覆盖包内
文件的规范化摘要，校验失败拒绝安装。非第一方签名的包要用户显式确认「来源不受信任」，
确认结果记在本机（不同步）。

## 5. 安装清单

`userData/plugins/<id>@<version>/`，文件系统即事实源，启动时扫描进内存清单。
装了什么是**设备本地**属性，和 `repo_file.local_path`、搜索缓存同类，**不进同步**。
Campaign 里 pin 的仍然是 `id@version`，缺包时沿用现有 `plugin-not-installed` /
`pinned-version-unavailable` 降级为 view-only。

**一台设备只装一个插件包**（`installPluginBundle` 的 `one-plugin-limit` 把关）。换插件
要先卸载现在这个。同一个 id 的其它版本不受这条限制：那是升级或回退，旧版本留着，
pin 在旧版本上的战役才跑得动；顺手删掉它等于把那些战役变成只读。限制只挡「再装一个」，
不挡存量机器上已经装着的多个包——那些照常装载、照常解析。

## 5.1 能装什么：从更新源读清单

设置页的「可安装插件」列表不内置目录，读的是**自动更新的同一个源**（`core/src/updateFeed.ts`
的 `resolveFeedDir`：更新源填了就用它，留空走官方 GitHub Release）。各写各的话，用户把
更新源指到镜像之后会出现「应用从镜像更新、插件却去 GitHub 拉」这种一头堵死的组合。

两条读取路径，对应两条发布路径：

| 更新源 | 读到什么 | 覆盖的发布方式 |
|--------|----------|----------------|
| GitHub | `GET /repos/<owner>/<repo>/releases?per_page=100`，把各 release 附件里的 `<id>@<version>.ojb` 合起来，同 id 取最高版本 | 应用发版顺路带上的包，以及 `plugins/<id>@<version>` tag 单独发的包 |
| 自建/通用目录 | `<目录>/index.json`（`pack-plugins.mjs` 产出） | 自建分发的镜像目录 |

GitHub 接口不通（限额、镜像没代理 `api.github.com`）时退回读 `index.json`：一条路断了
不该让界面空白。镜像前缀在两条路径上都原样保留——只改后半段的话，镜像用户会被指回墙外的
地址。

清单里只有附件名，所以说明与权限是把包取回来读它自己的 `manifest.json` 得来的（包只有
几 KB）。读不到时条目照样列出来，但标记 `described=false`，界面少说两句而不是替它编一段
说明。下载回来的包再核对一次「清单承诺的 id@version == 包里自称的」：签名只能证明
「这个包没被改过」，证明不了「它就是你要的那个包」。

权限在装之前就摆给用户看（与 `index.json` 里带 `permissions` 同一个理由），因为列表里
点一下就是一次安装。

## 6. 基础包岗位中立

基础包不带任何岗位包。首次进入时引导用户浏览并安装岗位包。相关缺陷已在
`a15bbe6` 修掉：新建战役不再被旧数据迁移盖成软件工程岗（详见该提交）。

三个官方岗位包的数据搬到仓库顶层 `plugins/`（和 `mobile/` 平级，用 `@plugins` 别名
引用），只有打包脚本和测试会 import 它；`capabilityIsolation.test.ts` 里的静态关卡盯着
这条边界，防止哪天有人图省事把岗位数据又编回基础包。放在 `src/` 之外是同一条边界的物理
形态：`electron.vite.config.ts` 三个目标都不登记 `@plugins`，所以应用代码一旦 import 它，
构建当场就断——不用等关卡用例。基础包里既没有岗位包也没有能力包：能力随岗位包的内嵌声明
分发，「装一个包」不会连带出现第二个包。

**岗位中立不只是「不带数据」，还包括「不带实现」。**基础包的职责是面试 Agent 的基础设施
（跨岗位闭环 + 不认岗位的机制 + 通用原语），任何一个岗位簇的功能实现、领域概念、专属表、
专属通道、专属文案都不属于它。判定用三条可执行判据：

1. 基础包源码里不出现岗位簇名词（能力 id 字面量、`repo` / `rolePlay` / 案例表格这类域名词）；
2. 基础包源码里不出现岗位专属的通道名、表名、枚举取值；
3. 渲染层的桥方法表不硬编码任何岗位簇方法——包在自己的入口代码里声明桥方法，宿主按声明放行。

这三条同时是搬迁进度表：现状盘点（哪些地方还越界、规模多大）与分阶段计划见 §11。

旧数据的读取不能依赖「用户装了岗位包」。`quiz_attempt` 与 `design_case` 行里存着当年
软件工程包的题型和量规 ID，而一台只装了产品岗的机器照样要能翻历史。这些映射被冻结成
已安装岗位包的内嵌声明（`RolePack.examFormMappings`），历史投影、计划贡献与
`pluginRuntime` 回填都读同一份常量：既让缺包时历史仍然可读，也让老战役的
`configSnapshotHash` 保持不变。

## 7. 手机端

- 岗位包是纯数据，随同步下发到手机，练习路径因此能在手机上正常跑。
- 岗位包内嵌能力的实现在桌面沙箱里（跑的是包自己的入口代码，编排的是一些桌面才有的原语），
  手机侧没有这些原语，所以能力在手机端一律 `view-only`：手机上能读数据面，不能执行。
- `findRolePack` 改成查已安装并优雅降级，不再抛 `PracticeError`。
- 客户端能力视图不再默认填桌面内置清单，必须显式传入本机安装集合。

手机端不安装插件包，这条是设计而不是缺口：它验不了 Ed25519（expo-crypto 只有摘要），
而且能力要靠桌面才有的原语才能执行，装了也跑不起来。它拿岗位包的唯一途径是向
已配对的桌面端要一份数据（`plugin:getRolePack`），那台桌面在安装时已经验过签名，LAN 通道
自身带 HMAC 与版本闸门。所以信任链是「相信自己配对的那台桌面」，不是「相信这份 JSON」，
收下之前仍然按 P01 的包格式校验一遍结构，并核对 id@version 与 descriptor 固定的那一对相符
（`shared/plugins/package/rolePackTransfer.ts`）。取回的数据落在设备本地表 `role_pack_cache`，
不进同步表——它是设备属性。

「外置能力一律 view-only」是 `clientView` 里的一条硬上限，不看包自己声明的 `runtime.mobile`：
那是包作者填的一句话，信了它，手机上就会出现一个按下去什么都不会发生的执行入口，排程还会把
它算成本机能做的事。岗位包不受这条限制，它是纯数据。

## 8. 会被改动的关卡测试

这些测试以「3 个官方岗位包」这个闭集合为前提，外置后需要重写判据：

`capabilityIsolation.test.ts`、`v1ReleaseGate.test.ts`、`phase0Gate.test.ts`、
`phase1Gate.test.ts`、`clientView.test.ts`、`runtime.test.ts`、
`productManager/golden.test.ts`、`salesCustomerSuccess/golden.test.ts`、
`roleAgnosticUi.test.ts`、`rolePlugins.test.ts`。

搬迁岗位簇实现时（§11）还会新增一条判据关卡：基础包源码里不出现岗位簇名词与专属通道/表/枚举。

## 9. 分阶段任务

| 任务 | 内容 | 验收 |
|------|------|------|
| P01 | 包格式契约 + 数据包/代码包校验器 + Ed25519 签名校验 | 篡改任一文件即拒装；数据包含函数即拒装 |
| P02 | `userData/plugins` 布局、启动扫描、安装清单与内置清单合并 | 已安装清单不再等于内置清单，且设备本地不同步 |
| P03 | ~~沙箱宿主~~ → 把「装载路径上不存在代码执行入口」固定成关卡测试 | 见 §3：数据包无代码可执行，代码包只在渲染层沙箱激活；`externalIsolation.test.ts` 守这条 |
| P04 | 贡献重放与内置路径等价 | 解析不执行插件代码，外置与内置结果逐条一致 |
| P05 | 权限契约改为按已安装 manifest 推导 | 外置插件按自己声明的权限受限，跨插件借权被拒 |
| P06 | 安装/卸载/启用 IPC + 浏览清单拉取 | 装、卸、列表三条路径可用且幂等；清单来源与自动更新同一处（§5.1） |
| P07 | 插件浏览/安装 UI + 首次使用引导 | 空安装态有可用引导，不再假装有岗位；列表里点一下就装，已装一个时其余条目说明要先卸载 |
| P08 | 岗位包移出基础包，`findRolePack` 改查已安装并降级 | 缺包只降级不抛错，历史结果仍可读 |
| P09 | CI 单独发布插件包产物与 `index.json` | tag 推送同时产出基础包与各插件包 |
| P10 | 手机端适配：岗位包数据下发、外置能力一律 view-only | 两端安装集合不同时视图不误报 |

## 10. 取舍与风险

- **能力边界**：见 §3 末段。数据包只能声明宿主已提供的东西；新的行为与 UI 走代码通道 + 通用
  原语。换来的是隔离不降级——包仍然够不到 fs、子进程、数据库与网络，只能用宿主放行的原语。
- **摘要要覆盖文件名**：只签内容的话，把 `pack.json` 改名成 `contributions.json`
  这类结构篡改发现不了。
- **签名必须内嵌公钥**：否则「内容被篡改」和「换了个签名者」都表现为用已知公钥验不过，
  混为一谈的后果是改过的第一方包显示成第三方包，用户点一下「仍然信任」就装进去了。
- **同一主干多个预发布**：包版本沿用 `compareExactSemVer`，已支持 prerelease 段。
- **手机端不做执行**：能力要靠桌面才有的原语才能跑，手机上只有查看，功能差异要在 UI 里说清。

## 11. 岗位簇实现的搬迁（进行中）

§6 的三条判据现在还有不少地方不满足：基础包里仍然留着若干**岗位簇的实现**，那不是基础设施，
是插件化之前就地留下的旧功能。本节是盘点与计划，按阶段推进。

### 11.1 现状盘点（越界清单）

| 岗位簇 | 位置 | 规模（估） |
|--------|------|-----------|
| 软件工程 | `desktop/src/main/repo/*`（clone / 索引 / 符号 / 工具循环 / tree-sitter / git / 快照） | ~1.4k LOC |
| 软件工程 | `core/src/repo/*`（virtualFs / symbolScan / pathSuggest / reanchor / snapshotDiff） | ~0.5k |
| 软件工程 | `desktop/src/main/llm/index.ts` 的 repo 分支 + `llm/repoAnswerPolicy.ts` + `toolPolicy.ts` | ~0.45k |
| 软件工程 | `core/src/prompts/repo.ts` 与 registry 的 `repo.*` | ~0.2k |
| 软件工程 | 数据面：`repo` / `code_ref` / `repo_file` 三表 + `task.repo_id` + `session.kind='repoQa'` + `annotation.target_type='codeRef'` + `speech_snippet.source_type='codeRef'` | 3 表 + 4 处枚举 |
| 软件工程 | 通道：`repo:*` / `codeRef:ensure` / `annotation:listForRepo`（含 `sync/rpc.ts` 与 preload 白名单） | ~15 通道 |
| 软件工程 | 渲染层：`RepoWorkspace` / `ReadCodePanel` / `CodePanel` / `TaskStudyPanel` 的 `readCode` 分派 / `TaskCard` 文案 | ~1.2k |
| 软件工程 | 手机：`ReposScreen` / `RepoQaPanel` / `ReadCodePanel` / `data/repo*` / `llm/agentChat.ts` | ~0.9k |
| 产品经理 | `core/src/case/*`（tabular-dataset 契约与解析、分析校验）、`design_case` 表、`design:*` 通道、`core/src/design/prompts.ts` | ~1.3k |
| 销售客服 | 宿主侧岗位接线（`rolePlaySession` / `interactionRuntime` 的策略部分）、`RolePlayRunner`、`interaction:*RolePlay` 通道 | ~0.5k |
| 跨岗 | planner 只认 `taskKind === 'readCode'`；`enums.ts` 的岗位取值（`readCode` / `repoQa` / `codeRef` / `design` / `EXAM_FORMS` / `REPO_STATUSES`）；`PRE_PLUGIN_DEFAULT_ROLE_PACK_ID`；`TaskCard` / `MoreScreen` / `RootTabs` 文案；`company_intel.tech_stack_md`；桥里硬编码的 `repo.*` | — |

### 11.2 目标形态：包侧实现 + 宿主通用原语

包侧实现跑在渲染层沙箱里（§3），只能编排宿主放行的通用原语：

| 原语 | 权限项 | 语义 |
|------|--------|------|
| 工作区 | `filesystem:workspace`（词汇已存在） | 本包工作区内的读 / 写 / 删 / 遍历 / glob / grep / 文本快照；可从远端 git 拉取到该目录 |
| artifact | `artifact:read`（`artifact:write` 词汇已存在） | 用户显式提供的文件读入（表格 / 文档） |
| 桥自注册 | — | 包声明自己的桥方法，宿主按声明放行（替代渲染层硬编码的 `repo.*`） |
| 数据面 | — | 包声明需要跨端的数据集合，宿主建通用承载表并沿用既有同步；内容对宿主不透明 |

`repository:read` 是岗位味词汇，退掉，改用 `filesystem:workspace`。

### 11.3 阶段

| 阶段 | 内容 | 验收 |
|------|------|------|
| 0 | 落地 §6 的三条判据为关卡（预期先红，红的就是 §11.1 那张表）；文档同步 | **已完成**：关卡 `core/src/hostUi/roleNeutralGate.test.ts` 把 §11.1 越界点冻结成名单，列出全部越界点 |
| 1 | 原语层骨架（工作区 / artifact / 桥自注册）+ 权限接线 + 手机端如实降级 | 原语边界用例（路径越界、未授权、上限）通过；现有测试全绿 |
| 2 | 软件工程试点：实现搬进 SE 包，宿主 `repo` 模块、`llm` 的 repo 分支、`repo:*` 通道、宿主 UI 一并下线；planner 去 `readCode` 特判，任务面板改通用视图槽位 | 装 SE 包后源码能力与插件化之前等价；卸载后基础包无源码痕迹；索引性能基准通过 |
| 3 | 数据面：`repo_file` / `code_ref` 迁出主库，改为包声明的通用数据面与同步 | 跨端同步用例通过；历史数据一次性迁移且可回滚 |
| 4 | 清扫产品经理与销售，以及跨岗的枚举取值、文案与兜底常量 | §6 三条判据全绿 |

**不选的路**：不把包代码放进主进程执行。那要撤销 P03 与 `externalIsolation.test.ts` 的 import
禁令，并作废「插件代码不提供裸能力」这条非目标（ARCH §3.2）——Node 进程内没有技术沙箱，
隔离只能靠签名与用户确认。若将来要走，是一次独立的安全决策，不混在这条搬迁里。

**已知使能缺口**：tree-sitter 现在在宿主侧（`web-tree-sitter` + `repo/treeSitter.ts`），包的沙箱
既 `require` 不到它，静态扫描也禁 `new Function` / `fetch`，所以符号提取得提成语言无关的通用
原语（`workspace.symbols`）才行；索引性能需要先做基准（1k / 1w 文件两档）。
