# 基础包 + 外置插件：设计与分阶段任务

v1.0 把内核插件化了，但三个岗位包和三个能力插件仍然编译进应用一起发布。本文定义
下一步：**默认打出来的是基础包，插件单独 release、单独安装，基础包里能浏览并选择安装**。

## 1. 现状与差距

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

岗位包（`RolePack`）本身是**纯数据**——匹配器、能力项、阶段、题型、量规、任务模板、
提示词片段、源码策略，manifest 还强制 `permissions: []`。能力插件才是代码。这个差别
决定了两类包走两条不同的加载路径。

## 2. 包格式

一个插件包是一个目录（分发时打成 `.zip`）：

```
<id>@<version>/
  manifest.json      # 现有 PluginManifest，已保证可 JSON 往返
  pack.json          # 仅岗位包：全部数据
  contributions.json # 仅能力插件：注册声明（见 §3）
  openjob.sig        # Ed25519 签名，内嵌签名者公钥，覆盖上面所有文件的规范化摘要
```

文件名是**白名单**，出现第四个名字就拒装。黑名单挡不住没想到的扩展名，而「包里多一个
文件」是夹带可执行载荷的唯一入口。

## 3. 隔离：包里没有代码可执行

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
- 隔离保障**完整保留**，不是退到「运行时被拦住」——插件包里根本没有可执行的东西。

代价换了个地方，必须说清楚：外置包只能声明**宿主已经实现的**工具、解析器与交互类型。
它扩展的是配置面（岗位、题型、量规、提示词、各类声明），不是宿主行为。真要加新行为，
仍然得发一版基础包。这个限制正是现有契约的形状，不是本设计新加的。

## 4. 信任链

`node:crypto` 原生支持 Ed25519，零新依赖。第一方发布公钥内置在基础包里；签名覆盖包内
文件的规范化摘要，校验失败拒绝安装。非第一方签名的包要用户显式确认「来源不受信任」，
确认结果记在本机（不同步）。

## 5. 安装清单

`userData/plugins/<id>@<version>/`，文件系统即事实源，启动时扫描进内存清单。
装了什么是**设备本地**属性，和 `repo_file.local_path`、搜索缓存同类，**不进同步**。
Campaign 里 pin 的仍然是 `id@version`，缺包时沿用现有 `plugin-not-installed` /
`pinned-version-unavailable` 降级为 view-only。

## 6. 基础包岗位中立

基础包不带任何岗位包。首次进入时引导用户浏览并安装岗位包。相关缺陷已在
`a15bbe6` 修掉：新建战役不再被旧数据迁移盖成软件工程岗（详见该提交）。

三个官方岗位包的数据搬到仓库顶层 `plugins/`（和 `mobile/` 平级，用 `@plugins` 别名
引用），只有打包脚本和测试会 import 它；`capabilityIsolation.test.ts` 里的静态关卡盯着
这条边界，防止哪天有人图省事把岗位数据又编回基础包。放在 `src/` 之外是同一条边界的物理
形态：`electron.vite.config.ts` 三个目标都不登记 `@plugins`，所以应用代码一旦 import 它，
构建当场就断——不用等关卡用例。`builtin/` 下只剩能力插件，`builtInPluginKeys()` 也因此
只占用能力插件的 id@version——否则官方岗位包连自己的版本号都装不进来。

旧数据的读取不能依赖「用户装了岗位包」。`quiz_attempt` 与 `design_case` 行里存着当年
软件工程包的题型和量规 ID，而一台只装了产品岗的机器照样要能翻历史。这些映射被冻结成
`legacyRoleData.ts` 里的快照，历史投影、计划贡献与 `pluginRuntime` 回填都读同一份常量：
既让缺包时历史仍然可读，也让老战役的 `configSnapshotHash` 保持不变。

## 7. 手机端

- 岗位包是纯数据，随同步下发到手机，练习路径因此能在手机上正常跑。
- 外置能力插件在手机端一律 `view-only`：手机不加载外部代码。
- `findRolePack` 改成查已安装并优雅降级，不再抛 `PracticeError`。
- 客户端能力视图不再默认填桌面内置清单，必须显式传入本机安装集合。

手机端不安装插件包，这条是设计而不是缺口：它验不了 Ed25519（expo-crypto 只有摘要），
而能力插件的工具实现全在桌面主进程里，装了也没有可执行的东西。它拿岗位包的唯一途径是向
已配对的桌面端要一份数据（`plugin:getRolePack`），那台桌面在安装时已经验过签名，LAN 通道
自身带 HMAC 与版本闸门。所以信任链是「相信自己配对的那台桌面」，不是「相信这份 JSON」，
收下之前仍然按 P01 的包格式校验一遍结构，并核对 id@version 与 descriptor 固定的那一对相符
（`shared/plugins/package/rolePackTransfer.ts`）。取回的数据落在设备本地表 `role_pack_cache`，
不进同步表——和 `repo.local_path` 同类，它是设备属性。

「外置能力一律 view-only」是 `clientView` 里的一条硬上限，不看包自己声明的 `runtime.mobile`：
那是包作者填的一句话，信了它，手机上就会出现一个按下去什么都不会发生的执行入口，排程还会把
它算成本机能做的事。岗位包不受这条限制，它是纯数据。

## 8. 会被改动的关卡测试

这些测试以「内置 3 岗位 + 3 能力」这个闭集合为前提，外置后需要重写判据：

`capabilityIsolation.test.ts`、`v1ReleaseGate.test.ts`、`phase0Gate.test.ts`、
`phase1Gate.test.ts`、`clientView.test.ts`、`runtime.test.ts`、
`analyticsCase/contract.test.ts`、`rolePlay/contract.test.ts`、
`productManager/golden.test.ts`、`salesCustomerSuccess/golden.test.ts`、
`roleAgnosticUi.test.ts`、`rolePlugins.test.ts`。

## 9. 分阶段任务

| 任务 | 内容 | 验收 |
|------|------|------|
| P01 | 包格式契约 + 数据包/代码包校验器 + Ed25519 签名校验 | 篡改任一文件即拒装；数据包含函数即拒装 |
| P02 | `userData/plugins` 布局、启动扫描、安装清单与内置清单合并 | 已安装清单不再等于内置清单，且设备本地不同步 |
| P03 | ~~沙箱宿主~~ → 证明装载路径上不存在代码执行入口 | 见 §3：沙箱被证明不必要，改为把该保障固定成关卡测试 |
| P04 | 贡献重放与内置路径等价 | 解析不执行插件代码，外置与内置结果逐条一致 |
| P05 | 权限契约改为按已安装 manifest 推导 | 外置插件按自己声明的权限受限，跨插件借权被拒 |
| P06 | 安装/卸载/启用 IPC + 浏览清单拉取 | 装、卸、列表三条路径可用且幂等 |
| P07 | 插件浏览/安装 UI + 首次使用引导 | 空安装态有可用引导，不再假装有岗位 |
| P08 | 岗位包移出基础包，`findRolePack` 改查已安装并降级 | 缺包只降级不抛错，历史结果仍可读 |
| P09 | CI 单独发布插件包产物与 `index.json` | tag 推送同时产出基础包与各插件包 |
| P10 | 手机端适配：岗位包数据下发、外置能力一律 view-only | 两端安装集合不同时视图不误报 |

## 10. 取舍与风险

- **能力边界**：见 §3 末段，外置包只能声明宿主已实现的东西。换来的是隔离不降级。
- **摘要要覆盖文件名**：只签内容的话，把 `pack.json` 改名成 `contributions.json`
  这类结构篡改发现不了。
- **签名必须内嵌公钥**：否则「内容被篡改」和「换了个签名者」都表现为用已知公钥验不过，
  混为一谈的后果是改过的第一方包显示成第三方包，用户点一下「仍然信任」就装进去了。
- **同一主干多个预发布**：包版本沿用 `compareExactSemVer`，已支持 prerelease 段。
- **手机端不加载代码**：短期内外置能力在手机上只有查看，功能差异要在 UI 里说清。
