# v1.0 升级与回滚

面向 v1.0 发布的操作手册：从 Phase 0/1 的旧版本升上来会发生什么、出问题怎么退回去、
两端版本不一致时同步为什么会被拦。

实现位置在文中一并给出，便于排查时直接对照代码。

---

## 1. 升级会改动什么

v1.0 引入三个岗位包（软件工程、产品经理、销售/客户成功）与三个能力插件
（`source-repository`、`role-play`、`analytics-case`）。对存量数据的影响只有两类：

| 类别 | 内容 | 是否改动旧数据 |
|---|---|---|
| 新增表 | `role_profile`、`campaign_plugin_binding`、`campaign_runtime_descriptor`、`migration_checkpoint`、`candidate_evidence`、`practice_attempt`、`story` 等 | 否 |
| 新增列 | `campaign.role_profile_id` | 否（旧列一字不动） |
| 回填 | 旧 Campaign 补一份「软件工程」岗位画像与运行描述符 | 只写新表与新列 |

旧 Campaign 的既有列在升级后是 **byte 级不变** 的，这一条由
`src/main/db/phase0Compat.test.ts` 用 `captureContents` 逐字对比守住。

### 1.1 迁移是怎么被挑中的

**桌面端**（Drizzle）：水位取 `__drizzle_migrations` 里已应用记录的 `created_at`
最大值，只跑 `meta/_journal.json` 里 `when` 更大的那些。因此 journal 中一条
`when` 比前面小的迁移，会在所有「已经升过头」的库上被**永久跳过**，且不报错。
`0013_prompt_run` 真的这么丢过一次，补建靠的是 `0019_prompt_run_repair`。

**手机端**：`_migrations` 表记 `idx`，`runMigrations` 按 `bundle.ts` 里
`MIGRATIONS` 的下标顺序补齐未跑的。`bundle.ts` 由 `.sql` 文件生成
（`npm run db:bundle`），少打包一条不是「晚一点跑」，而是那条永远不跑、后面
每一条的下标都错位。

两端清单的完整性由 `src/main/db/migrations.test.ts` 守住：journal 与 `.sql`
双向一一对应、`when` 严格递增、`idx` 连续、`bundle.ts` 与 `.sql` 逐字对应。

### 1.2 回填的幂等与断点

`backfillLegacyCampaignPluginRuntime`（`src/main/db/backfill/pluginRuntime.ts`）
在单个事务里写 profile、binding、descriptor，最后落一条 `migration_checkpoint`。

- 已有 checkpoint 时第二次执行不做任何写入（幂等）；
- checkpoint 之前失败则整笔回滚，下次启动重试；
- 回填出的 `configSnapshotHash` 与运行时新写入的算法一致，两者可比。

### 1.3 升级前后各做一次检查

升级前：

1. 在桌面端「设置 → 数据备份」手动建一份快照（见 §3.1），确认列表里能看到它；
2. 记下当前版本号，回滚时需要装回同一个版本。

升级后：

1. 打开一个旧 Campaign，确认计划、考点树、任务与历史结果都在；
2. 确认它的岗位显示为「软件工程」且标记为未经用户确认（回填只做推断，不代替用户选择）；
3. 与手机端同步一次，确认没有版本拦截提示。

---

## 2. 两端版本不一致时的同步

打包版本下，同步要求两端**完整版本号逐字相同**（含 `-beta.1` 这类后缀），
不是只比大版本：带迁移的发布经常只抬补丁号，beta 与正式版也可能落在不同 schema。

- 判定：`isSyncCompatible`（`src/shared/version.ts`）
- 闸门：`checkPeerVersion`（`src/main/sync/versionGate.ts`），不通过时返回
  HTTP 409 与 `SYNC_VERSION_MISMATCH`，**在动数据之前**就中断这一轮
- 开发态（未打包）直接放行：仓库里 `package.json` 与 `mobile/app.json` 的版本号
  平时本来就不同步，照发布态规则拦会让本地调试链路一起断掉

所以升级必须**两端一起做**。只升一端的后果不是数据写坏，而是同步一直被拒——
这是有意选的：宁可多拦一次，也不让不同构建互写。

---

## 3. 回滚

### 3.1 数据快照

实现在 `src/main/sync/backup.ts`，用 SQLite 的 `VACUUM INTO` 生成整库副本：

| 场景 | 入口 | 说明 |
|---|---|---|
| 手动 | 设置页 → 数据备份 | `createBackup(reason)` |
| 同步前自动 | 每轮同步开始时 | `createPresyncBackup()`，按保留策略避免每次都建 |
| 恢复前自动 | 执行恢复时 | `restoreBackup` 会先把当前现场存成 `prerestore` |

恢复用 `restoreBackup(file)`：先留 `prerestore` 快照，关闭数据库连接，再用备份
覆盖当前库。旧快照由 `pruneBackups()` 按 `selectStaleBackups` 的策略清理，
避免占满磁盘。

### 3.2 回滚步骤

SQLite 迁移**不可逆**：仓库里没有 down 迁移，回滚靠的是恢复升级前的快照，
而不是把 schema 往回改。

1. 两端都退出应用；
2. 桌面端装回升级前的版本；
3. 用升级前那份快照执行恢复（设置页 → 数据备份 → 恢复）；
4. 手机端同样装回旧版本。手机端没有整库快照入口，若手机库已经升级过，
   清除应用数据后从桌面端重新同步；
5. 两端版本一致后再同步一次，确认能连上。

**注意**：用新版本产生的数据去恢复到旧版本是不行的——旧版本的迁移水位比库低，
Drizzle 不会「降级」，只会在缺表缺列上直接失败。回滚必须用升级前的快照。

### 3.3 只是某个能力插件出问题

不需要回滚整个版本。能力插件的启用状态记在 Campaign 的运行描述符里，把对应
能力关掉即可：

- 关掉后旧 revision 的 binding 只是 `active_execution = 0`，**不删除**，历史结果
  仍然可解释（`setCampaignRoleProfile` 的写入路径保证这一点）；
- 能力被禁用时客户端视图降级为只读，已有产出继续可看，不再生成新任务
  （`buildClientCapabilityView` 与 `collectPlannerContributions`）；
- 岗位包本身不受影响：三个岗位包的每一种题型在能力插件缺席时都能独立跑完，
  这一条由各自的 golden 测试守住。

---

## 4. 发布前的验收清单

对应实施计划 T20 的验收项，逐条给出实际守在哪里：

| 验收项 | 守在哪 |
|---|---|
| 三个岗位包 golden 通过 | `builtin/{softwareEngineering,productManager,salesCustomerSuccess}/golden.test.ts` |
| 三个能力插件权限隔离 | `src/main/plugins/capabilityIsolation.test.ts` |
| 岗位与能力不串味 | `src/main/v1ReleaseGate.test.ts` 的隔离矩阵 |
| 两端 migration 清单一致 | `src/main/db/migrations.test.ts` |
| 两端 descriptor 一致 | `v1ReleaseGate.test.ts`、`src/shared/plugins/phase1Gate.test.ts` |
| 面后复盘跨端往返 | `mobile/src/sync/debriefRoundtrip.test.ts` |
| 旧 Campaign 可继续使用 | `src/main/db/phase0Compat.test.ts`、`v1ReleaseGate.test.ts` |
| 同步覆盖插件运行时表 | `v1ReleaseGate.test.ts` |

---

## 5. v1.0 未交付、留在 backlog 的能力

以下能力在架构里已有位置，v1.0 **不交付**，且不阻塞发布：

| 能力 | 现状 | 缺席时的行为 |
|---|---|---|
| `portfolio-review` | 未实现 | 产品岗的可选依赖，descriptor 里显示为 disabled（`plugin-not-found`），作品集类题目走纯文本 |
| `presentation-review` | 未实现，且尚无岗位包声明依赖 | 不出现在任何 descriptor 里 |
| `document-corpus` | 未实现 | 同上 |
| XLSX 读入 | `tabular-dataset` 契约已覆盖 `xlsx` 来源，但没有从工作表取网格的提取器 | 数据案例目前只接 CSV；`buildTabularDataset` 是格式无关的，补一个提取器即可接上，两种来源的类型推断完全一致 |

这几项都遵循同一条规则：能力缺席只降级成 disabled，不让岗位解析失败、也不让
任何一种题型不可用。
