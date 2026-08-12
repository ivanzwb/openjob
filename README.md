# OpenJob

面试备考 Agent — 以一场具体面试为单位，诊断考点、编排计划、逐日推进。

[设计文档](docs/DESIGN.md) · [Apache License 2.0](LICENSE)

## 简介

OpenJob 不是「知识图谱 + 收藏夹」工具集，而是**主动推进备考的 Agent**：输入岗位 JD、简历与面试日期后，系统会交叉分析考点、生成每日任务、用提问检验掌握度，并把各条学习链路汇聚成**面试时能说出口的话**。

**桌面端（Electron）** 负责完整能力：诊断、规划、讲解、考我、模拟面试、仓库克隆与索引、源码 Agent、联网检索。

**手机端（Expo）** 通过局域网与桌面配对同步，可**离线独立使用**——业务数据、配置与 API Key 全量同步后，手机本地直接调用 LLM，不依赖电脑在线。

## 主要能力

| 能力 | 桌面端 | 手机端 |
|------|--------|--------|
| JD × 简历诊断与考点树 | ✅ | ✅（同步后浏览/学习） |
| 目标岗位库 + 简历定向优化与 PDF 导出 | ✅（「简历」页） | 同步表结构（暂无 UI） |
| 每日计划与任务推进 | ✅ | ✅ |
| 知识点讲解 / 考我 / 模拟面试 | ✅ | ✅（本地 LLM） |
| 仓库克隆与 tree-sitter 索引 | ✅ | — |
| 源码快照同步与 Agent 读文件 | 索引后写入 DB | ✅（同步后 `read_file` / `grep`） |
| 联网检索（博查 / Tavily） | ✅ | 按配置 |
| 多端 P2P 同步 | ✅ | ✅ |

## 技术栈

- **桌面**：Electron 43 + electron-vite + React 19 + Tailwind CSS 4
- **手机**：Expo 57 + React Native + expo-sqlite
- **数据**：SQLite + Drizzle ORM，变更日志驱动的端间同步
- **LLM**：OpenAI 兼容 API，多角色 / 多档位配置
- **代码理解**：web-tree-sitter、simple-git、Agent 工具箱

## 环境要求

- **Node.js** 22+
- **pnpm** 10+
- **Git**（仓库克隆功能）
- **Windows 打包**：Visual Studio 2022 构建工具（`better-sqlite3` 重编译）
- **手机开发**：Expo Go 或 Android / iOS 模拟器

国内网络建议设置镜像（构建 Electron 二进制时）：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 快速开始

### 桌面端

```bash
pnpm install
node node_modules/electron/install.js   # 首次若 electron/dist 不存在
pnpm dev
```

首次运行后在 **设置** 中配置 LLM Provider 与 API Key（密钥经系统 safeStorage 加密落盘）。

### 手机端

```bash
cd mobile
npm install
npm run db:bundle    # 从桌面端迁移打包 SQLite schema
npm start
```

在桌面 **设置 → 同步** 生成配对二维码，手机 **同步** 页扫码配对并执行全量同步。

### 常用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 桌面开发模式 |
| `pnpm build` | 桌面生产构建 |
| `pnpm dist` | 打安装包（`dist/OpenJob-Setup-*.exe` 等） |
| `pnpm ci` | 类型检查 + lint + smoke + build |
| `pnpm db:generate` | 生成 Drizzle 迁移 |

## 安装包与发布

- 推送 `v*` tag 触发 [GitHub Actions](.github/workflows/release.yml) 构建并发布到 GitHub Release。
- Windows 安装包当前**未做 Authenticode 签名**，SmartScreen 可能提示不可信发布者 → 点「更多信息」→「仍要运行」，或右键安装包 → 属性 → 解除锁定。
- macOS 使用 ad-hoc 签名；首次打开可能提示未识别开发者，可在系统设置中允许。

## 同步说明

- 业务表、`app_setting`（配置与密钥）、仓库元数据与 `repo_file` 源码快照参与同步。
- `repo_file` 体积大、**优先级最低**：同步前检查手机可用存储，空间不足时跳过源码快照并在同步页提示。
- 搜索缓存、仓库本机路径（`local_path`）各端独立，不同步。

详见 [设计文档 §5.7](docs/DESIGN.md#57-桌面--手机同步)。

## 项目结构

```
openJob/
├── src/
│   ├── main/          # Electron 主进程（DB、LLM、同步、Agent）
│   ├── renderer/      # React UI
│   ├── preload/       # IPC 白名单桥接
│   └── shared/        # 双端共享类型与协议
├── mobile/            # Expo 手机端
├── docs/DESIGN.md     # 产品与架构设计（主文档）
├── scripts/           # 构建、图标、NSIS 工具链等
└── electron-builder.yml
```

## 配置与密钥

运行时配置与密钥落在用户数据目录，**勿将 `config.json` / `secrets.json` 提交到仓库**（已在 `.gitignore` 中排除）。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 产品定位、数据模型、Agent 流程、同步协议、实施阶段与踩坑记录

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

## 作者

OpenJob — [ivan.zwb@gmail.com](mailto:ivan.zwb@gmail.com)
