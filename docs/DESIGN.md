# OpenJob — 面试备考 Agent 设计方案

> 状态：设计定稿，待实施
> 最后更新：2026-08-11

---

## 目录

1. [产品定位](#1-产品定位)
2. [核心概念模型](#2-核心概念模型)
3. [Agent 五阶段流程](#3-agent-五阶段流程)
4. [功能设计](#4-功能设计)
5. [技术架构](#5-技术架构)
6. [数据模型](#6-数据模型)
7. [关键设计决策与理由](#7-关键设计决策与理由)
8. [风险与缓解](#8-风险与缓解)
9. [实施阶段](#9-实施阶段)
10. [明确不做的事](#10-明确不做的事)

---

## 1. 产品定位

### 1.1 一句话定义

一个以「一场具体面试」为单位的备考 Agent：给它岗位 JD、你的简历和面试日期，它诊断你的考点分布、排出每日备考计划、逐日推进、用提问检验掌握度，并在面试后回收真题反哺下一次。

### 1.2 形态选择：Agent 而非工具集

本项目**不做**成「知识图谱 / 项目问答 / 收藏 / 历史」四个并列功能的工具箱。工具集形态是被动的——用户想起来才打开，需要自己决定该学什么。

Agent 形态是主动的：用户每天打开看到的是「今天该干什么」，系统负责规划、追踪、调整和提醒。

这个选择的依据是：**备考最大的敌人是拖延和不知道从哪下手，不是缺信息。** 缺信息的问题通用 LLM 已经解决得不错了，而「在有限时间内决定学什么、学到什么程度」才是没被满足的需求。

### 1.3 与「直接问 ChatGPT」的区别

三条护城河，缺一不可：

| 差异点 | 说明 |
|---|---|
| 个性化 | 基于 JD × 简历交叉分析 + 你的实际答题表现，考点是「你会被问什么」而非「这个岗位一般考什么」 |
| 事实锚定 | 考察频率来自真实面经（网络检索 + 手动录入 + 自己复盘），代码结论强制引用 `file:line`，不是模型凭空生成 |
| 数据飞轮 | 面试复盘回流修正先验，跨 Campaign 累积，越用越准 |

### 1.4 核心产出物

所有链路的终点统一到一个东西：**面试时能说出口的话**。

不是「我看懂了」，而是一段口语化的、有逻辑结构的、能在 2 分钟内讲清楚的表述。知识点讲解产出它，源码阅读产出它，答题反馈优化它，最终汇聚成话术库。

---

## 2. 核心概念模型

### 2.1 中心对象：Campaign（一场备考战役）

```
Campaign
├── 输入
│   ├── 公司 + 岗位
│   ├── JD 原文
│   ├── 简历（可跨 Campaign 复用）
│   ├── 面试日期（deadline）
│   └── 每日可投入时长
├── 诊断产物
│   ├── 知识点树（KnowledgeNode，带三类覆盖标记）
│   └── 公司情报卡（CompanyIntel）
├── 执行产物
│   ├── 每日计划（PlanDay → Task）
│   ├── 答题记录（QuizAttempt）
│   └── 话术库（SpeechSnippet）
└── 回流产物
    └── 真题记录（InterviewReport → InterviewQuestion）
```

### 2.2 三类考点

JD 与简历交叉之后，每个知识点被打上覆盖类型标记，它们的准备策略完全不同：

| 类型 | 判定条件 | 准备目标 | 优先级 |
|---|---|---|---|
| `deep_dive` 必深挖 | 简历写了 + JD 要求 | 扛得住三轮追问，能讲原理和取舍 | 最高 |
| `gap` 短板 | JD 要求 + 简历没有 | 答出框架不露怯，可坦承不熟但展示学习路径 | 中高 |
| `landmine` 雷区 | 简历写了 + JD 没要求 | 能自圆其说，不被顺嘴一问问崩 | 中 |
| `extra` 加分项 | 都没有但相关 | 有余力再看 | 低 |

**这套分类是个性化的核心。** 只看 JD 会漏掉「雷区」，而雷区恰恰是最容易翻车的地方——面试官手里拿的是你的简历。

### 2.3 掌握度（Mastery）

0–5 分，是优先级排序的关键输入。两个来源：

- **自评**（快，三态映射到分数）— 基线，成本低但不准
- **答题得分**（`QuizAttempt.score`）— 客观修正，权重更高

因为掌握度必须有客观数据来源，「考我」功能从可选项升级为**核心机制**——它是整个系统唯一的掌握度传感器。

---

## 3. Agent 五阶段流程

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  诊断    │ → │  规划    │ → │  执行    │ ⇄ │  调整    │ → │  复盘    │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
     │              │              │              │              │
  考点分类       日程编排       每日任务       动态重排       真题回流
  公司情报       取舍决策       学/练/读       盲区提示       修正先验
```

### 3.1 诊断

1. 解析 JD → 抽取技能要求及权重
2. 解析简历 → 抽取技术栈、项目经历、可被深挖的点
3. 交叉分析 → 生成知识点树，标记四类覆盖类型
4. 联网检索公司面经 → 修正各节点的考察概率
5. 联网检索公司背景 → 生成情报卡（技术栈、面试流程、近期方向、反问素材）

### 3.2 规划

见 [4.3 优先级排序与日程规划](#43-优先级排序与日程规划)。

**这一阶段的本质是取舍，不是排满。** 知识点总时长几乎必然远超剩余可用时间（两周 × 每天 2 小时 = 28 小时，而图谱可能列出 60 小时内容）。Agent 必须明确告诉用户：这些点来不及全学，我给你排了最值钱的 N 个，剩下的每个准备一段 30 秒兜底话术。

### 3.3 执行

**今日任务页是产品主入口。** 每天的任务是混合编排的：

- `learn` 新学 2–3 个知识点
- `drill` 口述练习（对昨天学的做「考我」）
- `read_code` 源码阅读任务
- `review` 复习
- `fallback_script` 生成兜底话术

每天有明确的「完成」动作，形成节奏感。

### 3.4 调整

- 答题得分回写掌握度 → 重算优先级 → 明日计划自动调整
- 「今天没时间」一键顺延，后续日程自动重排
- 主动提示：长期未动的盲区、反复答错的点、简历上写了但一直没准备的雷区

### 3.5 复盘

面完当天录入实际被问到的题（趁记忆鲜活）。Agent 自动匹配到知识点节点，更新实测频率；匹配不上的标记为**盲区**——这些是图谱预测失败的地方，信息价值最高。

数据跨 Campaign 累积：面第二家时，第一家的真题已在修正先验。

---

## 4. 功能设计

### 4.1 JD × 简历交叉分析

**输入渐进式，降低冷启动摩擦。** 不要求一次填完四样东西：

1. 只给 JD → 立刻出考点清单（即时价值）
2. 补简历 → 考点重新分类，个性化程度质变
3. 补日期和每日时长 → 生成计划，进入 Agent 模式

每一步都有即时反馈。

简历独立存表，可跨 Campaign 复用。

### 4.2 知识点树

**结构：树 / DAG 为主干 + 少量横向边。**

不做网状大图——视觉噪音大、生成质量难控、维护困难。

- 层级：`domain` 领域 → `topic` 主题 → `point` 知识点 → 子知识点（可无限细化）
- 横向边只保留三种语义明确的关系：
  - `prerequisite` 前置依赖（影响日程拓扑序）
  - `related` 相关
  - `contrast` 易混对比（如 `synchronized` vs `ReentrantLock`）

**节点元数据**（排序依据）：考察概率、难度、预估时长、考察形式（概念题 / 手写代码 / 系统设计 / 场景题）、覆盖类型、掌握度。

#### 懒加载与去重

点击「细化」时才生成子节点，避免一次性生成的巨大 token 消耗。

**必须做去重**：展开「JVM 内存模型」生成的「垃圾回收」，可能与其他分支下已有节点重复。用 embedding 余弦相似度检测并合并，否则用户点几十次之后图就烂了。

#### 可手动编辑

节点支持改名、删除、手动新增（`is_user_added` 标记）。

由于系统不预置任何领域知识库（岗位完全由用户 JD 决定），冷门岗位的生成质量完全依赖模型发挥。**人工编辑是质量的最后一道保险**，实现成本很低但必须有。

#### 可视化后置

Agent 形态下日常入口是任务清单，不是图。图谱降级为「偶尔查看的全局进度地图」。

MVP 用**带层级和进度条的清单**即可满足九成需求，React Flow 可视化推到阶段 4。

### 4.3 优先级排序与日程规划

#### 打分公式

```
考察概率 = f(JD权重, 简历匹配度, 模型通用先验, 真题回流实测修正)
掌握差距 = 目标深度 - 当前掌握度
优先级   = 考察概率 × 掌握差距 ÷ 预估学习成本
```

然后在 `prerequisite` 拓扑序约束下排进日程。

#### 公式必须可见可调

Agent 一旦成为黑盒，用户不认同排序就不会跟着走，整个形态垮掉。UI 上要能看到每个节点的得分构成，权重可调。

#### 计划的柔性比精确更重要

计划的可信度是生死线。如果第一天就明显不合理（预估时长离谱、顺序别扭），用户第二天就不会再打开。

- 时长预估**刻意保守**，宁可排少一点制造完成感
- 计划可手动拖动调整
- 「今天没时间」一键顺延

#### 兜底话术

对于时间不够无法深入学习的知识点，生成 30 秒的兜底回答——不求深度，但求被问到时不露怯。这是真实备考策略，也是纯工具形态给不了的东西。

### 4.4 讲解：三档深度 + 口语化

面试是**限时口头输出**，同一知识点在不同场合需要不同长度：

| 档位 | 场景 | 要求 |
|---|---|---|
| `oneliner` 一句话本质 | 初面快问快答 | 30 秒内说完 |
| `spoken` 可背诵答案框架 | 「展开讲讲」 | **口语稿**，2 分钟，默认展开这档 |
| `deep` 深挖版本 | 追问到原理层 | 实现细节、源码、取舍 |

#### 口语稿是核心差异点

中间档**必须是口语稿而不是书面稿**，这一条要写死在 prompt 里，否则模型默认输出百科体。

- 书面语（❌）：「Redis 的过期策略采用惰性删除与定期删除相结合的方式」
- 口语（✅）：「Redis 其实是两种删除配合着用的，一个是懒的、一个是主动的」

要求：有逻辑连接词、可以直接念出来、听起来像人话。

#### 结构化模板（约束 LLM，不许自由发挥）

```
1. 一句话本质
2. 面试真实问法（2–3 个）
3. 口语化答案框架（分点，可背诵长度）
4. 代码 / 实例
5. 常见追问 & 陷阱
6. 关联知识点
```

其中「面试怎么问」和「常见追问」是区别于普通技术文档的核心价值——文档不会告诉你面试官下一句会问什么。

#### 缓存

三档分别缓存（`explanation` 表按 `tier` 存），避免重复生成。

### 4.5 「考我」：掌握度传感器 + 输出训练

流程：Agent 基于知识点提问 → 用户口述作答 → LLM 按 1–5 打分 → 给出反馈和**改进后的话术** → 分数回写掌握度。

三重价值：

1. 唯一的客观掌握度数据来源（支撑优先级排序）
2. 输出训练——看懂 ≠ 讲得出
3. 追问能力是 LLM 的强项，能模拟真实面试的深挖压力

**复用性说明**：源码问答模块必须做流式对话 UI，这套 UI 直接复用到「考我」上，几乎零额外成本。

语音输入（Web Speech API 或 whisper 接口）能显著提升训练强度——打字和开口是两种强度。放到阶段 4。

### 4.6 开源项目理解

#### 定位

不只是「读懂源码」，而是**产出面试中可主动抛出的素材**。

「我看过 Redis 这块的实现」是强加分项，前提是说得出具体东西。所以产出应沉淀为话术片段：某个设计的取舍、某个巧妙的实现、某个你有自己看法的点。

这样源码链路和知识点链路的终点汇合到同一个地方——话术库。这是比「知识点锚定代码位置」更强的连接（目标层面统一，而非仅内容关联）。

#### 检索方案：Agentic Search，不做向量索引

**不自建代码索引系统。** 理由：

- 纯向量 RAG 在代码上效果差，尤其「流程梳理」这类需要跨文件追调用链的任务
- 系统不限定岗位 ⇒ 不限定语言 ⇒ 语言特定的解析器方案每加一门语言都是新工程
- **Agentic search 天然语言无关**——让 Agent 拿着 `grep` / `read_file` / `list_dir` 自己迭代定位，像人读代码一样

配合 tree-sitter 生成的 **repo map**（全仓库符号骨架压缩成几千 token）作为导航地图。没有 parser 的语言优雅降级为目录树 + 文件头摘要，功能不断。

#### 项目预处理

clone 后跑一次「项目摘要生成」，产出模块划分、目录职责、核心数据结构、启动流程、关键设计决策。作为后续所有问答的常驻上下文。一次性成本，可缓存。

#### 代码 + 网络双检索

**代码回答 what 和 how，网络回答 why。**

「为什么这里用这个数据结构而不是那个」——答案通常在 issue 讨论、RFC、设计文档、邮件列表里，不在代码里。而面试聊源码时，why 层面的理解最能体现深度。

所以代码 Agent 的工具集是：`list_dir` + `read_file` + `grep` + `web_search` + `fetch_url`。

#### 流程梳理输出形态

**mermaid 时序图 / 流程图，每一步带 `文件:行号` 锚点，可点击跳转打开代码面板。**

这个体验做好了这个模块就成立了。

#### 强制引用

所有代码相关结论必须带 `file:line`。既是体验，也是抑制幻觉的主要手段。

### 4.7 联网检索

#### 五个检索场景（按价值排序）

1. **公司面经与面试流程** — 信息增量最大。模型先验是「Java 后端一般考什么」，搜索能拿到「这家公司这个岗位最近在考什么」
2. **版本敏感的技术细节** — 模型有知识截止日期，框架行为 / API 废弃 / 新特性答错概率不低，且面试中致命
3. **开源项目的设计意图** — 见 4.6
4. **公司技术背景** — 反推考点 + 反问环节素材
5. **知识点权威参考资料**

#### 不该搜的场景

**默认全搜是错的。** 稳定的基础知识（TCP 三次握手、红黑树、GC 算法原理）模型知道得很清楚，搜索只会引入噪音、增加延迟和成本，答案质量反而下降。

#### 触发策略：以规则为主干

| 方式 | 说明 |
|---|---|
| 规则触发（主） | 公司相关、版本敏感、时效性内容 → 必搜 |
| Agent 自主（辅） | 作为补充 |
| 用户显式 | 「联网查一下」按钮 |

不主要依赖 Agent 自主判断，因为模型对「我需不需要搜」判断不准——典型表现是要么每次都搜，要么该搜时自信地编。

#### 双 Provider，按语言自动路由

| Provider | 用途 | 说明 |
|---|---|---|
| **博查 Bocha** | 中文（面经、国内技术社区、公司情报） | DeepSeek 官方联网搜索供应方，阿里/腾讯/字节推荐。`POST https://api.bochaai.com/v1/web-search` |
| **Tavily** | 英文（官方文档、GitHub、英文技术博客） | 专为 LLM 设计，返回已提取正文 |

路由自动化（按查询语言 + 目标域名判断），不让用户手动选。

**博查关键参数**：`freshness`（`noLimit` / `oneDay` / `oneWeek` / `oneMonth` / `oneYear`）原生支持时效过滤，面经检索传 `oneYear`；`count` 最大 50；`summary=true` 返回正文摘要。

**Tavily 关键能力**：
- `include_domains` / `exclude_domains` — 原生实现域名白/黑名单，无需自建过滤层
- **Extract API** — 搜索拿 URL、Extract 抓正文，即 `fetch_url` 工具，无需自写爬虫
- `country` — 按国家提升结果权重

**注意事项**：
- Tavily `advanced` 模式消耗 2 credit（非 1），不要默认开启
- Tavily 早期在 advanced 模式下处理中文有 UTF-8 编码问题（已修复），需用较新版本库。按路由策略中文不走 Tavily，基本碰不到

#### 内容质量控制

面经内容质量分布极差：营销号洗稿、旧面经当新的发、标题党、CSDN 层层转载的错误内容。不过滤的话搜回来的可能比模型编的还差。

- **域名分级**：官方文档 / 一手来源（权重最高）> 牛客、一亩三分地、掘金等社区 > 内容农场（拉黑）
- **时间过滤**：面经取近 12 个月；技术文档看版本匹配
- **多源交叉验证**：多个独立来源都提到的考点才提高频率权重，单一来源标为存疑

#### 引用与来源可信度分级

每条来自搜索的结论必须带**来源链接 + 抓取时间**。与代码问答强制 `file:line` 是同一原则。

UI 上用角标明确区分三种信息来源，可信度递增：

```
[模型知识]  <  [网络检索]  <  [代码实证]
```

让用户自己判断哪些内容需要再验证。技术内容尤其重要——带着错误答案去面试比不知道更糟。

### 4.8 面经摄入管道（统一）

**三个来源走同一条管道**，只是 `source_type` 和可信度权重不同：

```
原始面经文本 → 拆分成独立题目 → 匹配到知识点节点 → 更新考察频率
                                      ↓ 匹配失败
                                   标记为盲区，新增节点
```

| 来源 | `source_type` | 可信度权重 |
|---|---|---|
| 自己面试后复盘 | `self_debrief` | 最高 |
| 手动粘贴（从牛客/公众号复制） | `pasted` | 中 |
| 网络搜索抓取 | `web` | 最低 |

#### 为什么必须有手动粘贴入口

即使用博查，中文面经的可获得性仍有天花板，这不是换 API 能解决的：

- 牛客网部分内容需登录才能看完整
- 一亩三分地强登录墙，基本抓不到
- **大量面经在微信公众号里，而公众号是封闭生态，搜索引擎覆盖极差**

手动粘贴的效果反而比搜索抓取更准（你自己筛过）。

### 4.9 标记与话术库

#### 统一 annotation 表

标记 / 高亮 / 笔记对**知识点、讲解片段、代码位置、真题、情报卡**使用同一张表，靠 `target_type` 区分。功能实现一次，全链路受益。

这是「两条链路都做」在工程上可行的关键——功能 3 和功能 4 是横切能力，不是独立模块。

#### 学习状态机（非简单收藏）

```
todo 未学 → learning 已看 → shaky 半懂存疑 → mastered 已掌握
                                  ↓
                            （复习任务来源）
```

`shaky` 状态特别有用，它是生成复习任务和薄弱点报告的主要来源。

#### 话术库

所有链路的终点。知识点的口语稿、源码里挖到的可讲素材、答题反馈优化后的表述，统一沉淀。

**必须支持用户改写成自己的话** —— 背书面语一听就假，用自己的表述才自然。

导出：Markdown / Anki 卡片 / PDF 面经清单（阶段 4）。

### 4.10 历史与可观测性

两层，价值完全不同：

#### 用户可见的历史

会话记录，可搜索、可续聊。查过哪些岗位、问过哪些问题、看过哪些代码。

#### 推理过程 trace

每条回答下挂可折叠面板，展示 Agent 调用了哪些工具、读了哪些文件、搜了什么关键词。

**目的不是 debug，是建立信任** —— 让用户能验证答案不是编的。

#### 历史即传感器（Agent 形态下的升级）

历史不只是给人查的，**它是 Agent 的决策输入**：

- 反复提问的内容 → 反推薄弱区域
- 答得差的题 → 提高该节点优先级
- 总是拖延不做的任务 → 提示或降低难度重排

历史从「记录」升级成「传感器数据」。

---

## 5. 技术架构

### 5.1 技术栈

**全 TypeScript 栈，Electron 桌面应用。** 交付形态是带 installer 的桌面程序，不是需要手动起服务的 Web 应用。

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node LTS + pnpm | Electron 兼容性最佳 |
| 应用外壳 | Electron | 主进程即 Node，后端逻辑直接跑在主进程，无 sidecar |
| 主进程语言 | TypeScript | 与前端同语言，类型可共享 |
| 渲染进程 | React + TypeScript + Vite | — |
| 主渲染通信 | Electron IPC（流式用 IPC event） | 替代 HTTP + SSE，进程内通信更简单 |
| 存储 | SQLite（better-sqlite3） | 同步 API，主进程内使用顺手 |
| ORM / 迁移 | Drizzle ORM | TS 优先、轻量；Prisma 在 Electron 打包有坑 |
| 向量 | **不用向量库**，纯 TS 余弦计算 | 数千级节点暴力计算仅几十毫秒 |
| 符号解析 | `web-tree-sitter`（WASM） | 无原生编译，打包最省心，可降级 |
| 仓库操作 | `simple-git` 包装系统 git | 检测系统 git，缺失时提示 |
| 图谱可视化 | React Flow（阶段 4） | — |
| 代码高亮 | Shiki | — |
| 流程图 | mermaid | — |
| UI | Tailwind + shadcn/ui | — |
| 打包 | electron-builder | NSIS(Win) / dmg(macOS) / AppImage+deb(Linux) |
| 自动更新 | electron-updater | — |

#### 数据与配置位置

一律放在 `app.getPath('userData')` 下，**不放项目目录**（安装后项目目录只读）：

```
<userData>/
├── config.json          # LLM / 搜索 provider 配置、API Key
├── openjob.db           # SQLite
├── repos/               # clone 下来的开源项目
└── cache/               # 搜索缓存、repo map、项目摘要
```

API Key 存储用 Electron `safeStorage`（走系统密钥链）加密后落盘，不明文存 `config.json`。

#### 进程内职责划分

| 进程 | 职责 |
|---|---|
| 主进程（Node） | LLM 调用、搜索、SQLite、git、tree-sitter、Agent 编排、长任务（仓库索引） |
| 渲染进程（React） | 纯 UI，通过 IPC 调用主进程能力，不直接碰文件系统和网络 |

长任务（clone + 索引）在主进程用 worker 或异步队列跑，通过 IPC 向渲染进程推送进度。

### 5.2 LLM Provider 抽象

统一 OpenAI 兼容接口，**两层结构：档位（tier）定义模型，角色（role）只做映射**。默认只配 `main` 一档即可完整运行，`cheap` 是可选成本优化——这是控成本的关键，也是配置面最小化的平衡点。

```ts
type LlmTier = 'main' | 'cheap';
type LlmRole = 'outline' | 'explain' | 'codeAgent' | 'quiz';

interface LlmConfig {
  providers: Record<string, {
    baseUrl: string;        // OpenAI 兼容端点
    apiKeyRef: string;      // 指向 safeStorage 中的密钥条目，不明文存储
  }>;
  tiers: Record<LlmTier, {
    provider: string;
    model: string;
    temperature?: number;
  }>;
  // 角色 → 档位映射。除贴出的覆盖项外默认都是 'main'，
  // 新角色加入时不用新增模型配置，只改映射。
  roles: Partial<Record<LlmRole, LlmTier>>;

  // embedding 不参与档位选择：模型一换向量空间就变，已有图谱/真题向量全部失效。
  // 它是固定资产，作为 provider 级固定配置存在，设置页只允许查看不允许随意切换。
  embedding: {
    provider: string;
    model: string;
  };
}
```

角色分工（默认映射）：

| 角色 | 用途 | 档位 | 说明 |
|---|---|---|---|
| `outline` | JD/简历解析、图谱大纲、排序决策 | `main` | 结构决策错不起，调用量小，成本占比低 |
| `explain` | 知识点讲解（调用量最大） | `cheap` | 全设计里唯一真正省钱的地方，可随意换便宜模型 |
| `codeAgent` | 源码检索 | `main` | 与 outline 共用强档，不单独占配置位 |
| `quiz` | 出题与评分 | `main` | 同上 |

> **硬约束**：`codeAgent` 必须走 `main` 档——不是因为它需要 function calling（如今便宜模型普遍支持），而是 agentic 循环对**工具协议遵循率**和连续多轮 tool call 的稳定性要求高，弱模型在这里发疯的代价远高于省下的几分钱。`embedding` 模型则相反，一旦选定就锁死，换模型等于推倒已有数据。

### 5.3 Search Provider 抽象

```ts
interface SearchConfig {
  providers: {
    bocha:  { endpoint: string; apiKeyRef: string };   // https://api.bochaai.com/v1/web-search
    tavily: { apiKeyRef: string };
  };

  // 自动路由，按顺序匹配，命中即用
  routing: Array<{
    match: { lang?: 'zh' | 'en'; domainHint?: string[] };
    provider: 'bocha' | 'tavily';
  }>;

  // 域名可信度分级，0 = 黑名单直接过滤
  domainCredibility: Record<string, 0 | 1 | 2 | 3 | 4 | 5>;

  cacheTtlDays: {
    companyIntel: number;      // 建议 7
    interviewReports: number;  // 建议 3
    techDocs: number;          // 建议 30
  };
}
```

默认路由规则：中文查询 → 博查；`github.com` / `docs.*` / `*.io` 等英文文档域名 → Tavily；兜底 → 博查。

默认可信度分级：官方文档域名与 `github.com` 为 5；`nowcoder.com`、`juejin.cn`、`zhihu.com`、`1point3acres.com` 等社区为 3；内容农场为 1；黑名单为 0。

### 5.4 Agent 共享工具箱

工具是**全局共享**的，不绑定在某个模块上。任何阶段的 Agent 都能调用，通过角色配置开关。

| 工具 | 用途 |
|---|---|
| `web_search` | 联网检索（自动路由 provider） |
| `fetch_url` | 抓取指定页面正文（Tavily Extract / 自建 fallback） |
| `list_dir` | 列目录 |
| `read_file` | 读文件（支持行号范围） |
| `grep` | 仓库内正则搜索 |
| `query_graph` | 查询知识点树（供规划器使用） |
| `update_mastery` | 回写掌握度 |

### 5.5 成本控制

| 手段 | 说明 |
|---|---|
| 懒加载 | 讲解按需生成，图谱细化点击才展开 |
| 分级缓存 | 讲解、项目摘要、搜索结果、公司情报全部缓存 |
| 模型分流 | 主力档跑除讲解外的全部角色，讲解单独走便宜档 |
| 上下文压缩 | 抓回的网页正文先摘要再进上下文（真正贵的是这块，不是搜索调用本身） |
| 复用共享 | 同一开源项目的摘要与 repo map 可跨 Campaign 复用 |

### 5.6 目录结构（建议）

**单包 + electron-vite**，用 path alias 做类型共享。

> 初版设计写的是 pnpm workspace 三包（`main` / `renderer` / `shared`）。改为单包的理由：electron-vite 是 Electron + Vite 的标准工具，默认就把 main、preload、renderer 三个构建目标统一编排；拆成 workspace 后这套编排要自己接，还要处理 shared 包的构建与 watch，对单人项目是纯粹的复杂度。类型共享靠 `@shared/*` alias 一样能拿到，「渲染进程不碰 Node API」靠 preload 白名单 + eslint 规则强制，比包边界更可靠。

```
openJob/
├── docs/
│   └── DESIGN.md
├── package.json
├── electron.vite.config.ts         # main / preload / renderer 三目标构建
├── electron-builder.yml            # 打包与 installer 配置
├── drizzle.config.ts
├── resources/
│   └── tree-sitter/                # 各语言 .wasm 语法文件
└── src/
    ├── shared/                     # 双端共享类型（单一语言的最大红利）
    │   ├── enums.ts                # coverageType / taskKind / tier ...
    │   ├── entities.ts             # KnowledgeNode / Task / Campaign ...
    │   ├── config.ts               # AppConfig / provider 配置 / 默认值
    │   ├── ipc.ts                  # IPC 通道映射与请求响应类型
    │   └── index.ts                # barrel
    │
    ├── preload/
    │   └── index.ts                # 白名单桥接，仅暴露类型化 invoke / on
    │
    ├── main/                       # Electron 主进程 = 全部后端逻辑
    │   ├── index.ts                # app 生命周期、窗口、单实例锁
    │   ├── ipc/                    # IPC handler 注册（替代 HTTP 路由）
    │   ├── config/                 # config.json 读写、safeStorage 密钥
    │   ├── db/
    │   │   ├── schema.ts           # Drizzle 表定义
    │   │   └── migrations/
    │   ├── sync/                   # 桌面 ↔ 手机增量同步（详见 5.7）
    │   │   ├── server.ts           # 局域网 HTTP 同步服务（配对/心跳/交换）
    │   │   ├── pairing.ts          # 配对会话与二维码负载
    │   │   ├── identity.ts         # 设备身份（首次启动生成）
    │   │   ├── triggers.ts         # 变更捕获触发器（本机写才记账）
    │   │   ├── collect.ts          # oplog → 变更集快照
    │   │   ├── apply.ts            # 变更集落库（以对端身份写，不产生回声）
    │   │   └── orchestrator.ts     # 同步编排与水位线推进
    │   ├── llm/                    # provider 抽象、角色路由、流式
    │   ├── search/                 # bocha / tavily / 路由 / 缓存 / 可信度
    │   ├── tools/                  # Agent 共享工具箱
    │   ├── agents/
    │   │   ├── diagnose.ts         # JD×简历分析、图谱生成
    │   │   ├── planner.ts          # 优先级排序、日程编排
    │   │   ├── tutor.ts            # 讲解生成（三档）
    │   │   ├── quizzer.ts          # 出题评分
    │   │   └── codeAgent.ts        # 源码检索
    │   ├── ingest/
    │   │   ├── jd.ts
    │   │   ├── resume.ts
    │   │   ├── interviewReport.ts  # 三入口统一管道
    │   │   └── repo.ts             # clone / repoMap / summary
    │   └── jobs/                   # 长任务队列与进度上报
    │
    └── renderer/                   # React UI，不直接碰 fs / network
        └── src/
            ├── pages/
            │   ├── Today.tsx       # 主入口
            │   ├── Campaign.tsx
            │   ├── KnowledgeList.tsx
            │   ├── Repo.tsx
            │   ├── Debrief.tsx
            │   ├── Scripts.tsx     # 话术库
            │   └── Settings.tsx    # provider / API Key 配置
            ├── components/
            │   ├── StreamChat.tsx  # 复用：考我 / 源码问答
            │   ├── SourceBadge.tsx # 来源可信度角标
            │   └── ToolTrace.tsx   # 推理过程面板
            └── ipc/                # 类型安全的 IPC 客户端封装
```

手机端（`mobile/`，Expo + React Native + expo-sqlite）与桌面端共享 `src/shared/` 类型，作为局域网同步的另一个对端，结构如下：

```
mobile/
└── src/
    ├── db/
    │   ├── schema.ts              # 与桌面同构的表定义（手写维护，靠 smoke 保障一致）
    │   └── index.ts               # 打开数据库、迁移、装触发器、加载对端凭据
    ├── data/
    │   └── queries.ts             # 只读查询（手机不跑 Agent，只浏览/打卡）
    ├── sync/
    │   ├── client.ts              # 配对/心跳/变更集交换的 HTTP 客户端（带签名）
    │   ├── triggers.ts            # 变更捕获触发器，语义与桌面端完全一致
    │   └── merge.ts               # 复用 shared/syncMerge 的合并/冲突解析
    ├── components/                # 通用 UI 组件
    └── screens/                   # 页面（Sync / Overview / …）
```

**安全基线**：渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，仅通过 preload 暴露白名单 IPC 方法。这既是 Electron 安全规范，也强制了「UI 不碰 IO」的分层。

**分层强制**：eslint `no-restricted-imports` 禁止 `src/renderer` 引入 `node:*`、`electron` 主进程模块及 `src/main/**`；`src/shared` 只允许纯类型与常量，不含任何运行时 IO。

### 5.7 桌面 ↔ 手机同步

桌面端（Electron 主进程）内置局域网 HTTP 同步服务，手机端（React Native）通过扫码配对后定期/按需交换增量。手机是**纯对端**：不跑 Agent、不建索引，只读数据 + 轻量打卡，所有变更都通过同一套机制回流桌面。

**变更捕获（两端对称）**：每张同步表配三个 SQLite 触发器（插入/更新/删除），把变更写成 `sync_oplog` 一行（表、行 ID、操作、墙钟、设备 ID、改动列）。关键约束：

- 触发器只记**本机用户操作**。应用对端变更时，连接会临时把 `sync_meta.writeAs` 改写为对端设备 ID，触发器 `WHEN` 条件据此放行/拦截——这叫「回声过滤」。没有这一层，应用对端数据会再写一条 oplog，两端水位互相顶死，永不收敛。
- 更新触发器只有列值真的变化才记账；`changed_fields` 记录具体改动列，供列级合并用。
- 每次启动 DROP 再 CREATE 全部触发器，避免旧列清单漏采。

**水位线语义（易踩坑，务必遵守）**：每个对端维护两条游标——

| 游标 | 语义 | 用途 |
|---|---|---|
| `last_local_seq` | 本端 oplog 里**已发给该对端**的水位 | 收集本机待发变更：`seq > last_local_seq` |
| `last_remote_seq` | **对端最近一次上报**的 oplog head | 请求对端增量：`seq > last_remote_seq` |

这两条语义不同、不可互换：用对端 head 过滤本端变更会**静默吞掉本机所有新修改**（这是线上出过的 bug）。同步一轮后两端原地对调推进：本地水位推到本端当前 head，远端水位推到对端上报的 head。

**合并**：两端都用自己的身份构造变更集快照（行快照 + tombstone），在桌面端 `shared/syncMerge` 做列级三方合并：

- 同一行不同列改动 → 自动按列合并
- 同一列改成不同值 / 删除与修改冲突 → 挂起为冲突，手机端弹 UI 让用户选本端还是对端
- 手机专属列（`local_path`、`status` 等）在合并时被剔除，不接受对端值

**安全**：配对交换 ECDH 派生共享密钥；每个请求带 HMAC 签名（设备 ID + 时间戳 + 路径 + body），防局域网内重放与伪造。

---

## 6. 数据模型

### 6.1 Campaign 与输入

```sql
campaign(
  id, company, role_title,
  jd_raw, jd_parsed_json,
  resume_id,                          -- 简历跨 Campaign 复用
  interview_date, daily_minutes,
  status,                             -- planning | active | done
  created_at, updated_at
)

resume(
  id, raw_text, parsed_json, created_at
)
```

### 6.2 知识点

```sql
knowledge_node(
  id, campaign_id, parent_id,
  name, kind,                         -- domain | topic | point
  coverage_type,                      -- deep_dive | gap | landmine | extra
  exam_prob,                          -- 0-1，考察概率
  difficulty,                         -- 1-5
  est_minutes,                        -- 预估学习时长
  exam_forms_json,                    -- [concept|coding|design|scenario]
  mastery,                            -- 0-5
  mastery_source,                     -- self | quiz | mixed
  priority_score,
  status,                             -- todo | learning | shaky | mastered
  embedding,                          -- blob，用于去重与真题匹配
  is_user_added,
  created_at
)

node_edge(
  id, from_node_id, to_node_id,
  relation                            -- prerequisite | related | contrast
)

explanation(
  id, node_id,
  tier,                               -- oneliner | spoken | deep
  content_md, model_used, sources_json,
  created_at
)
```

### 6.3 外部来源与检索

```sql
source(
  id, url, domain, title,
  provider,                           -- bocha | tavily | manual
  credibility,                        -- 1-5
  published_at, fetched_at, content_md
)

search_cache(
  id, query_hash, provider, params_json,
  results_json, fetched_at, ttl_days
)

company_intel(
  id, campaign_id,
  tech_stack_md, interview_process_md,
  hot_topics_md, talking_points_md,
  sources_json, updated_at
)
```

### 6.4 面经摄入

```sql
interview_report(                     -- 一段原始面经（三来源统一）
  id, campaign_id, company, role_title,
  source_type,                        -- web | pasted | self_debrief
  source_id,                          -- -> source，网络来源时非空
  raw_text, reported_at,
  credibility_weight, created_at
)

interview_question(                   -- 拆分出的单题
  id, report_id, question_text, round_no,
  matched_node_id, match_confidence,
  is_blind_spot,                      -- 匹配失败 = 图谱盲区
  created_at
)
```

### 6.5 计划与执行

```sql
plan_day(
  id, campaign_id, date, planned_minutes,
  status                              -- pending | done | skipped | deferred
)

task(
  id, plan_day_id, node_id, repo_id,
  kind,                               -- learn | drill | read_code | review | fallback_script
  est_minutes, actual_minutes,
  status, order_idx
)

quiz_attempt(
  id, node_id, question, user_answer,
  score,                              -- 1-5，掌握度数据来源
  feedback_md, improved_script_md,
  created_at
)
```

### 6.6 源码

```sql
repo(
  id, url, local_path, default_branch, commit_sha,
  languages_json, repo_map_md, summary_md,
  indexed_at, status
)

code_ref(
  id, repo_id, file_path, start_line, end_line,
  commit_sha, snippet
)
```

### 6.7 标记与话术

```sql
annotation(                           -- 统一标记表
  id,
  target_type,                        -- node | explanation | code_ref | question | intel
  target_id,
  kind,                               -- highlight | note | bookmark
  selected_text, note_md, created_at
)

speech_snippet(                       -- 话术库，所有链路终点
  id,
  source_type,                        -- node | code_ref | quiz
  source_id, tier, content_md,
  is_user_edited, created_at
)
```

### 6.8 会话与可观测

```sql
session(
  id, campaign_id,
  kind,                               -- quiz | repo_qa | free_chat | planning
  title, created_at
)

message(
  id, session_id, role, content_md, created_at
)

tool_call(
  id, message_id, tool_name, args_json,
  result_summary, duration_ms, token_cost,
  created_at
)
```

---

## 7. 关键设计决策与理由

记录**被否决的方案**，避免后续反复讨论。

| 决策 | 选择 | 否决的方案 | 理由 |
|---|---|---|---|
| 产品形态 | Agent（计划驱动） | 四功能并列工具集 | 备考的痛点是拖延和不知从何下手，不是缺信息 |
| 交付形态 | Electron 桌面应用 + installer | 需手动起服务的 Web 应用 | 本应用重度依赖本地文件系统（clone 仓库、读代码、长时索引），桌面是天然形态 |
| 后端语言 | TypeScript（Electron 主进程） | Python 3.11 + FastAPI | 详见下方专项说明 |
| 桌面外壳 | Electron | Tauri | 后端为 TS 时 Tauri 需 sidecar 一个 Node 进程，体积优势抵消且多出跨进程管理；Electron 主进程即 Node，无 sidecar |
| 工程结构 | 单包 + electron-vite + path alias | pnpm workspace 三包 | electron-vite 默认统一编排 main/preload/renderer；拆包后需自接构建与 shared 包 watch，收益（类型共享、分层）用 alias + eslint 即可获得 |
| 数据库 | SQLite（better-sqlite3） | Postgres | 单机本地，不值得引入 Docker 依赖 |
| ORM | Drizzle | Prisma | Prisma 的 query engine 二进制在 Electron 打包中易出问题 |
| 向量检索 | 纯 TS 余弦计算 | pgvector / Qdrant / Milvus | 数千级节点暴力计算仅几十毫秒 |
| 图存储 | SQLite 两张表（node / edge） | Neo4j | 只需取子树和邻居，图数据库是过度设计 |
| 前后端通信 | Electron IPC | HTTP + SSE | 进程内通信，流式用 IPC event 比 SSE 更简单，无端口占用问题 |
| tree-sitter | `web-tree-sitter`（WASM） | 原生绑定 | 无需原生编译，跨平台打包最省心 |
| 代码检索 | Agentic search + repo map | 向量索引 / 自建调用图 / LSP | 语言无关；向量 RAG 对跨文件调用链效果差；自建调用图工作量巨大 |
| 图谱可视化 | 阶段 4 再做，先用层级清单 | MVP 就做 React Flow | Agent 形态下主入口是任务清单，图只是全局地图 |
| 搜索 | 博查 + Tavily 双 provider 自动路由 | 单一 provider | Tavily 中文覆盖弱；博查专攻中文且原生支持时效过滤 |
| 抓取正文 | Tavily Extract API | 自写爬虫 + 正文提取 | 现成能力，无需重复造 |
| 搜索触发 | 规则为主 + Agent 自主为辅 | 全靠 Agent 自主判断 | 模型对「是否需要搜」判断不准 |
| 面经来源 | 搜索 + 手动粘贴 + 自己复盘，统一管道 | 只靠搜索 | 公众号封闭、牛客/一亩三分地有登录墙，搜索有天花板 |
| 掌握度 | 答题得分为主 + 自评为辅 | 纯自评 | 自评不准且用户懒得点，而排序强依赖此数据 |
| 讲解形态 | 三档 + 中档强制口语稿 | 单一书面讲解 | 面试是限时口头输出，书面语说出来很假 |
| 算法题 | 永久排除 | 纳入范围 | LeetCode 生态成熟，自己做不如直接用 |
| 系统设计 | 阶段 5+ 独立链路 | MVP 纳入 | 是综合应用而非知识点，需完全不同的交互形态 |
| 间隔重复(SRS) | 不做 | MVP 纳入 | 短期备考有日程计划即可，SRS 面向长期知识保鲜 |
| Agent 编排 | 原生 tool calling | LangChain 等框架 | 编排逻辑不复杂，框架抽象成本大于收益 |

### 7.1 专项：为什么放弃 Python

初版设计选 Python 的理由是「LLM / tree-sitter / 文本处理生态最顺」。**这个理由经不起推敲**——把本项目实际需要的能力逐项核对，没有一项是 Python 刚需：

| 能力 | Python 侧 | Node 侧 | 结论 |
|---|---|---|---|
| LLM 调用 | openai SDK | openai SDK（官方 TS 版） | 都是 OpenAI 兼容 HTTP，无差异 |
| 搜索 API | requests | fetch | 纯 HTTP，无差异 |
| tree-sitter | 原生扩展，需编译 | `web-tree-sitter` WASM | **Node 侧更省心**，无原生编译 |
| 余弦相似度 | numpy | 手写十行 TS | 数千向量在 JS 中仅数十毫秒 |
| SQLite | SQLModel | better-sqlite3 / Drizzle | 无差异 |
| git 操作 | subprocess | simple-git | 无差异 |

真正需要 Python 的是本地模型推理、numpy 重计算、transformers 生态——本项目一项都不涉及。

而 Python 在桌面分发上有实打实的阻碍：PyInstaller 打包体积 200–500MB；tree-sitter 原生扩展与 BLAS 常收集不全需手写 hook；冷启动数秒；**打出的 exe 被 Windows Defender 误报概率高**（对分发是致命的）；FastAPI 作为子进程需处理端口冲突、进程残留、优雅退出；自动更新无成熟方案。

换成 TS 栈后的额外红利：主进程与渲染进程共享同一份类型定义（`src/shared`），单人开发不必在两套类型系统间手工同步。

唯一损失是将来若要跑本地 embedding 模型 Python 更方便，但 embedding 走 API 或 `transformers.js` 均可解决。

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **计划不可信** | 第一天觉得不合理 → 第二天不再打开，Agent 形态直接垮掉 | 时长预估刻意保守；可手动调整；一键顺延；排序公式可见可调 |
| **技术讲解幻觉** | 带着错误答案去面试，比不知道更糟 | 代码强制 `file:line`；版本敏感内容检索官方文档；来源可信度角标 |
| **中文面经抓不到** | 考察频率失去事实依据，退化为模型编造 | 手动粘贴入口；自己复盘回流；多源交叉验证 |
| **搜索内容质量差** | 洗稿、旧面经、错误内容污染先验 | 域名分级；时间过滤（近 12 个月）；多源交叉验证 |
| **冷启动摩擦** | 要求一次填 JD+简历+日期+时长，门槛高 | 渐进式输入，每步都有即时反馈 |
| **冷门岗位生成质量差** | 无预置知识库兜底 | 节点可手动编辑、删除、新增 |
| **Token 成本** | 全量图谱 + 逐点讲解可达数十万 token | 懒加载 + 分级缓存 + 模型分流 + 上下文压缩 |
| **Agentic 检索不稳定** | Agent 乱翻文件、读十几个文件仍未定位 | 需反复调优 prompt 与工具描述；repo map 导航；限制单轮工具调用次数 |
| **大仓库索引耗时** | clone + 索引数分钟，用户干等 | 异步任务 + 进度反馈 |
| **节点重复膨胀** | 反复细化后图谱结构烂掉 | embedding 相似度去重合并 |
| **安装包未签名** | Windows SmartScreen 与 macOS Gatekeeper 拦截 | 分发前准备代码签名证书；自用阶段文档说明如何放行 |
| **原生模块跨平台构建** | better-sqlite3 需按 Electron ABI 重编译，跨平台易失败 | 用 `electron-rebuild`；或改用 Node 内置 `node:sqlite` 规避原生依赖 |
| **系统缺少 git** | 仓库 clone 功能直接不可用 | 启动时检测并给出明确安装引导，功能优雅降级 |
| **API Key 明文泄露** | 配置文件被读取 | 用 Electron `safeStorage` 加密后落盘，走系统密钥链 |

---

## 9. 实施阶段

原则：**每个阶段结束都是一个能实际用起来的东西**，不憋到最后一起交付。

### 阶段 0 — 底座

- 单包 electron-vite 骨架：`src/main` / `src/preload` / `src/renderer` / `src/shared`，分层由 eslint 规则约束
- Electron 主进程 + Vite React 渲染进程，`contextIsolation` + preload 白名单
- 类型安全的 IPC 层（含流式 event 通道）
- 配置与密钥：`config.json` + `safeStorage`，Settings 页可填 provider 与 API Key
- LLM provider 抽象（OpenAI 兼容 + tiers/roles 两层配置 + 流式）
- Search 层（博查 + Tavily 双 provider + 自动路由 + 缓存 + 引用追溯 + 可信度分级）
- Drizzle schema + 迁移，SQLite 建表（全量 schema 一次到位）
- 流式对话组件 `StreamChat`
- 来源角标 `SourceBadge` + 工具 trace 面板 `ToolTrace`
- **electron-builder 打通一次 installer 构建**（尽早验证打包链路，不要等到最后）

**验收**：装上 installer，打开应用，填入 API Key 后能对话、能联网搜索并给出带出处的回答。

#### 阶段 0 实施记录：Windows 构建的三个坑

这三条都是实际踩过并验证过解法的，换机器或清缓存后会重现。

**1. Defender 扫描导致 `EPERM: rename`**

electron-builder 解压 Electron 与 NSIS 工具链时，先写入 `xxx.tmp` 再重命名。Windows Defender
会在文件落盘瞬间扫描 `electron.exe`、`makensis.exe` 等可执行文件并持有句柄，而 Windows 上
目录内有文件被占用时无法重命名整个目录，于是报 `EPERM`。此时手动重命名同一目录是成功的，
说明只是扫描时间窗内的瞬时占用，不是权限问题。

- Electron 本体：配置 `electronDist: node_modules/electron/dist` 复用 devDependency 里已解压的副本，
  整个「下载 → 解压 → 重命名」步骤被跳过
- NSIS 工具链：`%LOCALAPPDATA%\electron-builder\Cache` 下用缓存里的 `7za.exe` 手动把 `.7z`
  直接解压到最终目录名，并把 `.state` 写成 `{"state":"complete", fileCount, extractedSize}`。
  electron-builder 靠这个文件判定缓存有效，状态停在 `"extracting"` 时每次都会重新解压

**2. pnpm 10 默认拦截依赖的构建脚本**

electron 与 esbuild 的二进制都靠 postinstall 下载，被拦下后 `node_modules/electron/dist` 根本不存在，
`pnpm dev` 和打包都会失败。需在 `package.json` 声明 `pnpm.onlyBuiltDependencies`，且必须在首次
安装这些包**之前**配好——补加之后 `pnpm rebuild` 不会重跑已跳过的脚本，只能直接执行 `install.js`。

**3. 版本区间冲突**

`@vitejs/plugin-react` 6.x 只支持 vite ^8，而 electron-vite 5 最高支持 vite ^7，必须锁 vite 7 +
plugin-react 5.x。TypeScript 7（原生 Go 移植版）与 typescript-eslint 尚不兼容（后者要求 `<6.1.0`），
项目只用 tsc 做类型检查，锁 5.x 即可，无功能损失。

此外国内网络下 electron-builder 从 GitHub Releases 拉二进制会超时，需设
`ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror。

### 阶段 1 — 诊断

- Campaign 创建（渐进式：先 JD → 补简历 → 补日期时长）
- JD 解析、简历解析、交叉分析 → 四类考点标记
- 知识点树生成（两层）+ 懒加载细化 + embedding 去重 + 手动编辑
- 公司情报卡（联网检索）
- 面经摄入管道（搜索 + 手动粘贴两个入口）→ 修正考察频率
- 考点展示：层级清单 + 进度条（不做图谱可视化）

**验收**：粘贴 JD 和简历，得到一份带优先级依据的分类考点清单。此阶段结束已是可用产品。

### 阶段 2 — 计划与执行（Agent 形态成立）

- 优先级排序（公式可见可调）+ 拓扑序约束
- 日程生成 + 手动调整 + 一键顺延
- **今日任务页（主入口）**
- 三档讲解生成（中档强制口语稿）+ 缓存
- 「考我」出题 → 评分 → 反馈 → 改进话术 → 回写掌握度
- 时间不足知识点的兜底话术生成
- 学习状态机 + 统一 annotation

**验收**：能连续使用一周，每天打开知道该干什么。

### 阶段 3 — 源码模块

- 仓库 clone + tree-sitter repo map（可降级）+ 项目摘要生成
- 代码 Agent：`list_dir` / `read_file` / `grep` / `web_search` / `fetch_url`
- 强制 `file:line` 引用 + 前端代码面板跳转
- 流程梳理 → mermaid 图 + 每步锚点
- 作为 `read_code` 任务类型接入日程
- 可讲素材沉淀进话术库

**验收**：给一个仓库 URL，能问出准确的、带行号引用的答案和流程图。

### 阶段 4 — 闭环与沉淀

- 面后复盘录入（复用摄入管道，`source_type=self_debrief`）
- 真题匹配 → 频率修正 → 盲区标记
- 跨 Campaign 先验累积
- 话术库汇总 + 导出（Markdown / Anki / PDF）
- 知识图谱可视化（React Flow）
- 语音口述输入

**验收**：完整飞轮跑通，第二个 Campaign 的排序明显优于第一个。

### 阶段 5+ — 扩展

- 系统设计题独立链路（案例式练习）
- 多 Campaign 对比与总览

---

## 10. 明确不做的事

- **算法题 / LeetCode 刷题** — 永久排除，现有生态更好
- **间隔重复排期（SRS）** — 短期备考场景用不上，日程内的 review 任务已足够
- **多用户 / 账号体系 / 计费** — 单人本地部署
- **网状知识图谱** — 只做树 + 三类横向边
- **自建代码索引 / 调用图 / LSP** — 用 agentic search 替代
- **向量数据库** — 纯 TS 余弦暴力计算足够
- **Neo4j 等图数据库** — SQLite 两张表足够
- **LangChain 等编排框架** — 原生 tool calling 足够
- **Python 后端** — 本项目无 Python 刚需，且阻碍桌面分发（见 7.1）
- **云端同步 / 服务端** — 纯本地应用，数据不出机器

---

## 附：术语表

| 术语 | 含义 |
|---|---|
| Campaign | 一场具体面试的备考单元，系统的中心对象 |
| 覆盖类型 | 知识点的四类标记：必深挖 / 短板 / 雷区 / 加分项 |
| 掌握度 | 0–5 分，主要来自「考我」答题得分，是排序的关键输入 |
| 兜底话术 | 时间不足无法深入学习的知识点的 30 秒回答，求不露怯 |
| 盲区 | 真题匹配不到任何知识点节点 = 图谱预测失败处，信息价值最高 |
| repo map | tree-sitter 生成的全仓库符号骨架，压缩为几千 token 作导航 |
| 话术库 | 所有链路的终点产出，「面试时能说出口的话」 |
