# 基础包 + 外置插件：设计与分阶段任务

v1.0 把内核插件化了，但三个岗位包和三个能力插件仍然编译进应用一起发布。本文定义
下一步：**默认打出来的是基础包，插件单独 release、单独安装，基础包里能浏览并选择安装**。

## 1. 现状与差距

| 事实 | 位置 | 对外置插件的影响 |
|------|------|------------------|
| 已安装清单 ≡ 内置清单 | `src/main/plugins/runtime.ts` `listInstalledPlugins()` | 没有「已安装」这个独立概念 |
| 注册表只在模块加载时被内置数组填充 | `src/shared/plugins/builtin/index.ts` | 没有从磁盘动态注册的入口 |
| `userData` 下没有插件目录 | `src/main/paths.ts` `getAppPaths()` | 装到哪里都还没定 |
| 能力插件必须提供可执行 `register()` | `src/shared/plugins/contracts.ts`；resolver 在解析时真的调用它 | **无法做成纯 JSON**，外置就等于加载外部代码 |
| 权限契约由内置数组推导 | `src/main/plugins/permissionGateway.ts` `BUILT_IN_PERMISSION_CONTRACTS` | 未登记的 id 一律 `permission-undeclared`，外置插件直接被拒 |
| 隔离的第二层是**扫描仓库内插件源码** | `src/main/plugins/capabilityIsolation.test.ts` | 外部产物没有源码树可扫，这层保障失效 |
| 练习路径缺包直接抛错 | `src/main/practice/rolePack.ts` `findRolePack` → `PracticeError` | 外置之后「缺包」是常态，不能抛 |
| 手机端没有 resolver | `src/main/sync/rpc.contract.test.ts` 明确禁止 | 手机端无法自己解析依赖，只能消费下发结果 |
| 手机端能力视图默认填桌面内置清单 | `src/main/plugins/runtime.ts` | 两端安装集合一旦不同就会误报 |

岗位包（`RolePack`）本身是**纯数据**——匹配器、能力项、阶段、题型、量规、任务模板、
提示词片段、源码策略，manifest 还强制 `permissions: []`。能力插件才是代码。这个差别
决定了两类包走两条不同的加载路径。

## 2. 包格式

一个插件包是一个目录（分发时打成 `.zip`）：

```
<id>@<version>/
  manifest.json      # 现有 PluginManifest，已保证可 JSON 往返
  pack.json          # 仅岗位包/行业包：全部数据
  plugin.mjs         # 仅能力插件：打包好的单文件 ESM，无外部依赖
  contributions.json # 仅能力插件：安装期固化的贡献描述（见 §3）
  openjob.sig        # Ed25519 签名，覆盖上面所有文件的规范化摘要
```

数据包一行代码都不执行，隔离等级与内置无差别。能力插件才需要 §3 的沙箱。

## 3. 隔离：沙箱宿主 + 权限代理 + 贡献固化

关键约束：resolver 目前是**同步且确定的**，`register()` 在解析时被直接调用。如果注册要跨
进程，解析就得变异步，`setRoleProfile`、排程、客户端视图全都跟着传染。

因此把「声明」和「实现」分开：

- **安装期**：沙箱宿主加载 `plugin.mjs`，执行一次 `register()`，把注册到的工具 id、
  输入输出 schema、artifact 类型、交互类型录成 `contributions.json`（纯数据），连同哈希落盘。
- **解析期**（热路径，保持同步）：resolver 读 `contributions.json`，用一个「重放」函数把
  记录下来的贡献喂给 collector。不执行插件代码，结果依旧确定。
- **执行期**：真正调用工具/解析器时才跨进程 RPC 到沙箱，逐次经过 `permissionGateway`。

沙箱形态：`utilityProcess` 起独立进程，插件代码在 `node:vm` 上下文里跑，全局只暴露
注册代理和受权限约束的宿主调用；不给 `require`、`process`、`fetch`。进程隔离让插件崩溃
或死循环不会带走主进程。

隔离保障的变化要说清楚：静态源码扫描此后**只覆盖内置**（基础包自带的代码），外置插件
靠的是「进程隔离 + 权限代理 + 签名信任链」。这是从「结构上不可能」退到「运行时被拦住」，
是这条路线的真实代价。

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

## 7. 手机端

- 岗位包是纯数据，随同步下发到手机，练习路径因此能在手机上正常跑。
- 外置能力插件在手机端一律 `view-only`：手机不加载外部代码。
- `findRolePack` 改成查已安装并优雅降级，不再抛 `PracticeError`。
- 客户端能力视图不再默认填桌面内置清单，必须显式传入本机安装集合。

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
| P03 | 沙箱宿主（utilityProcess + vm）与权限代理 | 插件拿不到 `require`/`process`/`fetch`；越权调用被网关拒 |
| P04 | 贡献固化：安装期录 `contributions.json`，resolver 保持同步 | 解析不执行插件代码，结果与内置路径逐条一致 |
| P05 | 权限契约改为按已安装 manifest 推导 | 外置插件按自己声明的权限受限，跨插件借权被拒 |
| P06 | 安装/卸载/启用 IPC + 浏览清单拉取 | 装、卸、列表三条路径可用且幂等 |
| P07 | 插件浏览/安装 UI + 首次使用引导 | 空安装态有可用引导，不再假装有岗位 |
| P08 | 岗位包移出基础包，`findRolePack` 改查已安装并降级 | 缺包只降级不抛错，历史结果仍可读 |
| P09 | CI 单独发布插件包产物与 `index.json` | tag 推送同时产出基础包与各插件包 |
| P10 | 手机端适配：岗位包数据下发、外置能力一律 view-only | 两端安装集合不同时视图不误报 |

## 10. 取舍与风险

- **隔离降级**：见 §3 末段，静态扫描不再覆盖外置插件，这是本路线不可回避的代价。
- **versionCode 类问题**：`contributions.json` 与 `plugin.mjs` 必须一起校验哈希，
  否则固化的声明和实际代码会漂移。
- **同一主干多个预发布**：包版本沿用 `compareExactSemVer`，已支持 prerelease 段。
- **手机端不加载代码**：短期内外置能力在手机上只有查看，功能差异要在 UI 里说清。
