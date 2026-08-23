# OpenJob — 面试备考 Agent 设计方案

> 状态：持续实施中（桌面端 + 手机端已可用）
> 最后更新：2026-08-14
> 快速上手见仓库根目录 [README.md](../README.md)

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

**目标岗位（`job_target`）** 集中存放公司、岗位与 JD，备考战役通过 `job_target_id` 引用；战役表仍保留冗余字段以兼容诊断与同步。新建备考时从岗位库选择，而非每次手填 JD。

**简历优化版（`resume_variant`）** 不覆盖母版 `resume.raw_text`：针对某一目标岗位由 LLM 生成定向优化稿，支持人工编辑、母版对比、改动说明与 PDF 导出（经典 / 现代 / 紧凑模板）。桌面端在顶部 **「简历」** 页管理岗位、母版与优化版。

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

**考点清单的展示顺序和排程共用同一个口径**：`shared/campaign/studyOrder.ts` 的 `sortNodesByStudyOrder()`（难度升序 → 同难度优先级降序 → id → prerequisite 拓扑重排），两端都走它。手机端曾经只是 `ORDER BY priority_score DESC`，同一个战役在两端看到的清单顺序对不上。

排序末尾那一档 `id` 不是可选的装饰：难度与优先级并列很常见（同一批生成的兄弟考点往往覆盖类型、考察概率、时长都一样，算出来的分数完全相同），少了它，结果就退化成「数据库返回的行序」——而那个行序两端各按自己的插入/落库顺序来，本来就不同，`VACUUM` 一次（留快照、回退都会）还会再变一次。用 id 收尾才让「顺序」成为数据的属性而不是存储的副产品。

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

语音输入（Web Speech API 或 whisper 接口）能显著提升训练强度——打字和开口是两种强度。放到阶段 4。

#### 参考答案：答不上来的题也要有出路

评分给的「改进话术」是把用户说过的话改写一遍，答不上来的时候它什么也给不了——而答不上来恰恰是最需要范本的时刻。所以出完题就能单独要一份参考答案（`quiz.answer`），和作答、评分互不依赖：先看范本再练，或者答完对照，都行。参考答案按评分那条「能扛追问」的标准写，只给一段正确但平铺直叙的定义，用户照着背仍然过不了第二问。

参考答案可以就地改成自己的说法，再加入话术库——话术库是所有链路的终点，考我这条链路此前只有评分那一个入口。

**存进话术库时挂在考点而不是这次作答上。** 评分后自动存的那条挂 `quiz_attempt.id`，因为它就是那次作答的产物；手动存的参考答案挂 `knowledge_node.id`：题目在提交之前就能存，那时还没有作答记录，而且同一个考点反复练出的同一段话术会被去重合成一条。两端解析来源标签时都先按作答查，查不到再按考点查。

#### 模拟面试的参考答案：取材必须可信

模拟面试（自我介绍 / 系统设计 / 项目场景 / 综合）的参考答案是拿来照着练的，所以「像不像一份真实答案」比「答得多漂亮」重要。两条取材规则写进提示词：

- **最近的经历优先。** 上下文里的简历经历按时间倒序给出并编号，提示词明说序号越小越近。不写这句，模型会挑简历里描述最丰满的那段来答——那常常是三四年前的项目，而面试官问的是你现在什么水平。
- **一个答案只锚定一段经历。** 不约束的话，模型会把几段经历的亮点拼成一个「综合最优答案」：听起来很强，但没有哪一段是真实发生过的，面试官顺着追问两句就穿帮。自我介绍天然要覆盖多段，规则换成「按时间倒序一段一段讲，讲完一段再进入下一段」，同样不许交织。

**排序的前提是上下文里真的有时间。** `ResumeParsed.projects` 只有名称、摘要和可深挖点，取前四条等于随机取四条；带时间的经历一直在 `resume.rawText` 的 markdown 里（`### 机构 | 岗位 | 2021-04 ~ 至今`），`shared/resume/experienceTimeline.ts` 复用简历编辑器那套解析把它读出来排序，不另立格式约定。简历还没结构化、一个时间都读不出来时退回原来的项目摘要，并在段落标题里说明「简历未填写时间，无法判断新旧」——给不出时间就别假装有顺序，那会让提示词里那句「序号越小越近」变成谎话，比不给顺序更糟。

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
| UI | Tailwind CSS 4（`@theme` 令牌） | 配色集中在 CSS 变量里，深浅两套主题不必逐个组件改 |
| 打包 | electron-builder | NSIS(Win) / dmg(macOS) / AppImage+deb(Linux) |
| 自动更新 | electron-updater | 默认查官方 GitHub Release，`config.update.feedUrl` 可改到自建目录 |

#### 数据与配置位置

一律放在 `app.getPath('userData')` 下，**不放项目目录**（安装后项目目录只读）：

```
<userData>/
├── config.json          # LLM / 搜索 provider 配置、界面主题
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

#### 界面主题（浅色 / 深色）

浅色是默认，深色在**设置 → 外观**切换。选择存在 `AppConfig.ui.theme`，随 `app_setting` 同步到手机（手机端不另设开关，见 5.7）。默认值只在字段缺失时生效——`mergeAppConfig` 写的是 `loaded.ui?.theme ?? base.ui.theme`，而不是「dark 视为未设置」，因此已经显式选过深色的老用户升级后仍是深色。

**桌面端改的是变量，不是组件。** 六个语义 token（`--color-bg` / `surface` / `border` / `fg` / `muted` / `accent`）在 `@theme` 里定义，`@theme` 装的是深色值，但它是 Tailwind 的编译基线、不等于默认主题：默认主题由 `html:not([data-theme='dark'])` 覆盖成浅色。选择器写成 `:not(dark)` 而不是 `[data-theme='light']`，是因为 `@theme` 只能被更高优先级的选择器覆盖，「没有 data-theme 属性」这个状态必须也落到浅色，否则首帧或属性被清掉时会退回深色基线，与默认浅色矛盾；反过来把浅色搬进 `@theme`、深色改成属性覆盖也成立，但要把下面整套调色板重映射连同 Tailwind 原始色阶一起对调写回去，回归面大得多，不值得。`color-scheme` 同理：基线不再写 `dark`，浅色分支给 `light`、`[data-theme='dark']` 给 `dark`。

真正的麻烦在于界面里另有三百多处直接写死的调色板类（`text-sky-300`、`bg-amber-950/40`、`hover:bg-black/20`），它们在深色下是刻意挑的——浅色阶当前景色，深色阶当着色底板。Tailwind v4 把调色板同样编译成 `var(--color-sky-300)`，所以浅色主题只需在浅色分支里按「保持感知对比度」重映射用到的色阶，一次生效，不必逐个组件改类名：

| 用途 | 深色取的色阶 | 浅色映射到 |
|---|---|---|
| 前景色 | 100 / 200 / 300 / 400 | 900 / 800 / 700 / 600~700（按各色相在白底的可读性取） |
| 着色底板 | 800 / 900 / 950 | 300 / 300 / 200 |
| 描边与实心按钮 | 500 / 700 | 不动，两个主题都成立 |

底板不能照着深浅直接翻到 50 档：这些类几乎都带 `/20`~`/40` 的透明度，叠在白底上会淡到看不出色相，告警面板退化成一个白框。停在 200/300 档，透明度化掉之后刚好剩一层能认出色相的浅色。

两个东西不参与翻转：**模态遮罩**用独立的 `--color-scrim`，两套主题都压暗——遮罩上盖的是简历纸张、寸照和白字按钮，跟着变浅就既压不住底层内容、也撑不住上面的白字；**`--color-white` 保持纯白**，二维码卡片、简历纸张、证件照底色都依赖它，而 `text-white` 只出现在实心按钮（强调色蓝、`emerald-700` 绿）和遮罩之上，这些底色都不跟着翻转，白字始终立得住。

由此有一条**必须遵守的约定**：实心深色按钮要显式写 `text-white`，不能靠继承 `--color-fg`。深色下 fg 本就接近白色，漏写时完全看不出问题，浅色下就变成蓝底黑字——第一版有二十多处这样的按钮，全是这个原因。

**启动不能闪一下另一套主题。** 主题在建窗之前就要定下来：主进程读 `config.json` → 决定窗口 `backgroundColor`，并通过 `additionalArguments` 把主题传给 preload → preload 同步读出注入 `window.bootstrap` → 渲染进程在 React 挂载前落 `html[data-theme]`。任何一环换成 IPC 往返，就会先看到一帧错主题。这条链上每处兜底值都要与 `DEFAULT_CONFIG.ui.theme` 同为浅色：preload 解析不到 `--ui-theme` 时返回 `light`，`uiTheme.ts` 的 store 初值也是 `light`，否则新装用户仍会闪一帧深色。

**三处配色不走这套 token**，各自单独跟随：Shiki 改成双主题输出（每个 token 上同时带 `--shiki-light` / `--shiki-dark`，切主题只是换取哪个变量，不必把已渲染的代码重新高亮——高亮是异步的，重跑会让长文档里的代码块集体闪一下）；mermaid 把配色烧进 SVG，只能按主题重新渲染；React Flow 走 `colorMode` 加控件变量覆盖。

**手机端没有 CSS 变量这条捷径，只能真改代码。** `mobile/src/theme.ts` 从静态对象改为订阅式 store 加 `useTheme()`，组件里约定 `const theme = useTheme()`——局部变量与原来的导入同名，于是四百多处 `theme.bg` 之类的引用一行都不用动。迁移方式是删掉旧的静态导出，让类型检查器把全部引用逐个报出来，保证不漏；模块顶层的样式常量和非组件辅助函数不能调钩子，改成接收 `theme: Palette` 参数由组件传入。写死的深色值（Toast 变体、来源标签、批注前景色）收进语义三元组 `tone.{amber,sky,emerald,red,slate}.{text,border,bg}`，深浅各一份——`Toast` 的 info 变体原本是深灰底配正文色，浅色下会变成深底深字、完全看不见，这类才是必须改的。store 的初值取浅色，与默认主题一致：手机端在同步到桌面配置之前就要显示界面，初值取错会在首次同步后闪一次主题。`app.json` 的 `userInterfaceStyle` 本来就是 `light`，系统级外观与默认主题一致，无需改动。

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
├── README.md                       # 项目介绍、构建与同步说明
├── LICENSE                         # Apache License 2.0
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
    │   ├── theme.ts                # 窗口底色，与渲染层 --color-bg 保持一致
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
            │   ├── StreamChat.tsx  # 复用：追问 / 源码问答
            │   ├── SourceBadge.tsx # 来源可信度角标
            │   └── ToolTrace.tsx   # 推理过程面板
            ├── lib/
            │   └── uiTheme.ts      # 当前主题，供少数不由 CSS 决定的配色取用
            └── ipc/                # 类型安全的 IPC 客户端封装
```

手机端（`mobile/`，Expo + React Native + expo-sqlite）与桌面端共享 `src/shared/` 类型，作为局域网同步的另一个对端。配对并全量同步后，手机可**离线独立运行** LLM 链路（诊断、讲解、考我、模拟面试、读源码与仓库 Agent），不依赖桌面 RPC 代理；克隆与 tree-sitter 索引仍在桌面端完成，索引后的 `repo_file` 快照同步到手机。

```
mobile/
└── src/
    ├── db/
    │   ├── migrations/            # 与桌面同构迁移（bundle 脚本打包）
    │   ├── migrate.ts             # 迁移执行器（逐条事务 + 日志/schema 自省）
    │   └── index.ts               # 打开数据库、迁移、装触发器、同步编排
    ├── data/                      # 本地 CRUD 与 LLM 业务逻辑
    ├── llm/                       # 手机端直连 LLM（chat / json / agent）
    ├── sync/
    │   ├── client.ts              # 配对/心跳/变更集交换的 HTTP 客户端（带签名）
    │   ├── repoFileStorage.ts     # repo_file 同步前存储空间检查
    │   ├── triggers.ts            # 变更捕获触发器，语义与桌面端完全一致
    │   └── apply.ts               # 变更集落库
    ├── components/                # 通用 UI 组件
    ├── screens/                   # 页面（Sync / Campaigns / Repos / …）
    └── theme.ts                   # 双主题调色板 + 订阅式 store（useTheme）
```

**安全基线**：渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，仅通过 preload 暴露白名单 IPC 方法。这既是 Electron 安全规范，也强制了「UI 不碰 IO」的分层。

**分层强制**：eslint `no-restricted-imports` 禁止 `src/renderer` 引入 `node:*`、`electron` 主进程模块及 `src/main/**`；`src/shared` 只允许纯类型与常量，不含任何运行时 IO。

**`src/shared` 里不许摸宿主全局**：这条比「不含 IO」更容易破。`src/shared` 同时被 Electron 主进程、渲染进程和 React Native 加载，三个运行时的全局面并不一样——Node 有 `globalThis.crypto.randomUUID()`，Hermes 没有（RN 里生成 UUID 得走 `expo-crypto`）。`flattenGeneratedTree` 曾经直接调这个全局，桌面端一路正常，手机端一点「JD 诊断」就抛 `Cannot read property 'randomUUID' of undefined`；更糟的是它在清空旧考点之后才炸，用户看到的是考点清单凭空消失。所以共享模块需要宿主能力时一律**由调用方注入**，且做成必填参数而非带默认值的可选参数：给了默认值就等于给回退留门，类型检查也就不再逼调用方交代能力从哪来。

### 5.7 桌面 ↔ 手机同步

桌面端（Electron 主进程）内置局域网 HTTP 同步服务，手机端（React Native）通过扫码配对后定期/按需交换增量。手机是**对等同步端**：本地可完整备考，变更通过同一套 oplog 机制回流桌面；仓库克隆与索引仅在桌面执行。

**变更捕获（两端对称）**：每张同步表配三个 SQLite 触发器（插入/更新/删除），把变更写成 `sync_oplog` 一行（表、行 ID、操作、墙钟、设备 ID、改动列）。关键约束：

- 触发器只记**本机用户操作**。应用对端变更时，连接会临时把 `sync_meta.writeAs` 改写为对端设备 ID，触发器 `WHEN` 条件据此放行/拦截——这叫「回声过滤」。没有这一层，应用对端数据会再写一条 oplog，两端水位互相顶死，永不收敛。
- 更新触发器只有列值真的变化才记账；`changed_fields` 记录具体改动列，供列级合并用。
- 每次启动 DROP 再 CREATE 全部触发器，避免旧列清单漏采。

**行版本表（`sync_row_version`）**：`(表名, 行 ID) → 最后更新时间`，是后写覆盖唯一的时间来源。24 张同步表里只有 8 张有 `updated_at`，业务列给不出统一的时间，所以单独立表。它由另一组触发器（`syncrv_` 前缀）维护，与 oplog 触发器有两点关键差别：

- **不做回声过滤**，无条件记账。应用对端数据也要留下时间，否则这些行下一轮同步会因为「没有时间」而被判成最老，被对端反向覆盖。
- 落库后由 `apply` 按**来源端的时间**回写（`stampRowVersion`），而不是本机的「现在」。否则刚收到的行会显得比本地任何修改都新，同步方向一反就把对方的新数据盖掉。

存量库升级时 `backfillRowVersions` 回填一次：`max(oplog.wall_ms)` → `updated_at` → `created_at` → `0` 依次退让，靠 `sync_meta.rowVersionBackfilledAt` 保证只跑一次。

**水位线语义（易踩坑，务必遵守）**：每个对端维护两条游标——

| 游标 | 语义 | 用途 |
|---|---|---|
| `last_local_seq` | 本端 oplog 里**已发给该对端**的水位 | 收集本机待发变更：`seq > last_local_seq` |
| `last_remote_seq` | **对端最近一次上报**的 oplog head | 请求对端增量：`seq > last_remote_seq` |

这两条语义不同、不可互换：用对端 head 过滤本端变更会**静默吞掉本机所有新修改**（这是线上出过的 bug）。

**推进水位线的两条硬规则**（0.6.8 的丢数据事故推出来的，破一条就静默丢数据）：

1. **本端待发变更集按「对端自己上报的水位」取，不按本端存的 `last_local_seq`。** 桌面端是服务端，它的 `last_local_seq` 在回包发出**之前**就被推到了 head——回包一旦没送达（手机端超时掐断就是），这个数就变成一句没兑现的承诺。下一轮据它算出的本端变更集会漏掉对端其实没收到的那些行，而 `planMerge` 只认传进来的变更集、不查库，漏一行就等于告诉它「本机根本没有这一行」，于是对端更旧的值被**无条件写入**，本端较新的改动静默消失，连 `sync_overwrite` 都不会留痕。所以 `/sync/exchange` 把请求里的 `sinceSeq` 传进 `handleExchange`，本端变更集按它取；`syncMerge.test.ts` 的「本端变更集不完整的代价」把这个后果钉住了。
2. **只能推到「采集那一刻」的 head，不能推到「此刻」的 head。** 一轮同步要跑几十秒，用户这期间的编辑照样进 oplog 并拿到更小的 seq；用此刻的 head 会把这些从没发出去的改动一并标成已发送，它们要等到下次全表对账才补回来。所以推的是变更集自带的 `headSeq`。

失败的那一轮绝不推进任何水位线——手机端只在整轮落库成功后才写 `sync_peer`。

**合并（后写覆盖，不问用户）**：两端都用自己的身份构造变更集快照（行快照 + tombstone），跑同一份 `shared/syncMerge` 做列级合并：

- 同一行不同列改动 → 自动按列合并，两边的改动都留下
- 同一列改成不同值 / 删除与修改冲突 → **时间新的那份赢**，输的那份写进 `sync_overwrite` 留痕，不挂起、不弹窗
- 时间完全相同 → 比设备 ID 的字典序定胜负。这个兜底不是为了「公平」，而是**收敛的前提**：两端角色相反地各跑一遍合并，只有裁决规则不依赖「谁是本地」，才可能得出同一个结果
- 时间戳先按配对握手测出的时钟偏移归一到本地时钟再比，两台机器系统时间差几秒不会误判
- 手机专属列（如 `repo.local_path`）在合并时被剔除，不接受对端值
- `repo_file`（源码快照）同步优先级最低；手机端在落库前检查可用存储，不足则跳过并在同步页提示

`syncMerge.test.ts` 里有一组收敛测试：模拟同一对变更集在两个方向上各合并一次，断言两端落到完全一致的状态。

**单一入口，全量由代码判定**：界面上只有一个同步动作，没有「增量 / 全量」之分——要用户理解两种同步的差别本身就是设计失败。是否退回全表对账由 `needsFullSync()` 决定：水位线还在 0（首次配对）、上一轮**落库落了一半**、或距上次全量超过 7 天。最后一条是给多设备场景兜底：纯增量下 A→B、B→C 的链式同步可能让 C 一直看不到 A 的某些改动，定期全量对账把这类空洞抹平。

**失败也要记一笔，而且要分清断在哪一步**。手机端每轮失败都往 `sync_run` 写一行（以前只更新界面上那行字，库里什么都不留，于是「上次失败就转全量」这条判断永远读到的是上一次成功——注释里承诺的自愈是死代码）。status 分两种是给恢复策略用的：

- `not-applied`：交换阶段就失败了，本机一个字节都没动，下一轮重发同一段增量即可。
- `failed`：回包拿到了，落库过程中出的事，水位线可能停在半途，下一轮必须全表对账。

**只有 `failed` 才升级成全量**。无脑「失败就全量」看着更安全，实际是把偶发失败变成永久失败：回包太大本身就是超时的主因，换成全量只会更大，于是每轮都超时、每轮都判定要全量，同步再也好不了。

**超时不能一个数走天下**。握手（`/sync/ping`、`/sync/pair`）只交换几十字节，10 秒不通就是网络本身有问题；而 `/sync/exchange` 要等桌面端把整轮变更应用完、再把回包整个序列化出来，全表对账时还带着源码快照，给的是 180 秒。这个数给小了不是偶尔失败而是**再也不会成功**：手机端一掐断，水位线就不推进，桌面端下一轮还是从同一个起点重算同一份回包，而它的 oplog 还在往前走，回包一轮比一轮大——0.6.8 就是这么卡死的，而桌面端每轮都跑完并记下一条成功记录，两端状态看着完全矛盾。

**判断「是不是自己掐的」要看 `AbortController.signal`，不能看 `e.name`**。React Native 的 fetch 被 abort 打断时经常抛的是 `Network request failed`，并不叫 `AbortError`；照名字判断会把自己造成的超时报成「对方拒绝连接或重置」，照着网络方向白查一整天。同理，连接类错误必须把原始信息带出来——地址变了、两端不在同一个网、桌面端没开、被防火墙拦，压成一句猜出来的结论等于把唯一的线索删掉。

**快照：两端各自留、各自退**。快照是本机的事，不进同步范围，两端谁都不需要对方在线就能回退自己。用 `VACUUM INTO` 而不是拷 `.db` 文件：WAL 模式下未 checkpoint 的事务还在 `-wal` 里，直接拷主文件会得到一个缺了最近写入的旧状态。

留快照的时机有三个：

- **同步前**：确定有变更要落库（`plan.auto.length > 0`）才做，无变更的空轮不做——同步每 60 秒一轮，每轮全库拷贝会把磁盘和电量都吃掉，而没有写入的同步本来也没什么可退的。`plan.auto` 含 `delete`，所以删除同样在保护范围内。再叠一层节流（`shouldCreatePresyncBackup()`，15 分钟）：间隔内复用上一份而不新建，`syncRun.backupFile` 记的就是复用的那一份——它确实是这轮同步能退回去的位置。
- **迁移前**：`getDb()` / `openDb()` 里，发现有未应用的迁移且库非空时先留一份。挂在「打开数据库」而不是「装更新」上，是因为 schema 真正改变的那一刻在这里——无论新版本是自动更新、侧载还是本地构建装上来的都会经过。空库直接跳过：没有可丢的东西。
- **手动**：同步页有「立即备份」，重装或手工改动之前用。

**迁移前快照做不出来就不迁移**。桌面端抛错，手机端也抛错（`createBackup` 在空间不足时返回 `null`，迁移前这一处把它升级为错误），文案直接说「腾空间后重新打开，数据还没被改动」。代价是应用暂时打不开，但这是可恢复的；反过来在没有退路的情况下改库是不可恢复的。

**「有没有待跑的迁移」这个判断，闸门和执行必须用同一份答案**，否则会出现「日志说跑完了所以不备份」和「自省说要重建所以照跑」同时成立——整份清单里唯一会删表的迁移，恰好在没有退路的情况下跑。桌面端因此按 Drizzle 自己那套算（水位取 `max(created_at)`，数 `when` 更大的条数），不能拿 journal 条数减日志行数：两者只要对不上就永远算出「还有待跑的」，每次启动白做一次全库 `VACUUM`，把真正那份升级前快照挤出保留窗口。手机端把这个判断收进 `pendingMigrationIndices()`，闸门和 `runMigrations()` 都问它。

**迁移清单本身有两条硬规则**，两条都栽过：

1. **`meta/_journal.json` 的 `when` 必须严格递增。** Drizzle 不按序号补齐迁移，它取日志里 `created_at` 的最大值当水位，只跑 `when` 更大的那些。所以一条 `when` 比前面小的迁移，会在所有「已经升过头」的库上被**永久跳过**——不报错、不重试，那张表就是永远建不出来，而全新安装一切正常，本地根本复现不了。`0013_prompt_run` 真的这么丢过一次（手填的时间戳里混进一个 drizzle-kit 真实生成的，恰好偏小）。已经发出去的库只能靠一条 `CREATE TABLE IF NOT EXISTS` 的补建迁移捞回来，改原来那条的 `when` 对它们没用。`src/main/db/migrations.test.ts` 守这条。
2. **一条迁移一个事务。** 桌面端由 Drizzle 保证（整批 `BEGIN`/`COMMIT`），手机端要显式 `withTransactionSync()`——SQLite 的 DDL 本来就是事务性的，不包只是漏了。这对「建新表-搬数据-删旧表-改名」那种重建尤其要命：不包事务时在删表和改名之间断掉，留下的是一个没有目标表、数据全在 `__new_*` 里的库，而手机端的容错重放会先把建表当成「已存在」跳过、再撞上 `no such table`，这个错不在白名单里，于是每次启动都挂在同一行，应用彻底打不开。

**保留策略三条规则叠加，都不是「全局留最近 N 份」**。判定逻辑 `selectStaleBackups()` 放在 `shared/sync.ts` 两端共用（删文件各自用自己的 API），另有 50MB 空间下限。

1. **按 reason 分组**。同步前快照产生得最勤，全局排序会让它在几次同步内就把「升级前」那一份挤掉，而「升级不该丢数据」全靠那一份兜底。
2. **同步前快照分两层：最近 N 份 + 按天各一份**。只按份数留的话，可恢复的时间跨度由同步频率决定：一天同步几十次，"最近 10 份"全落在最近十几分钟里，昨天以前一份不剩。而数据不对通常是隔天才被发现的，那时候能退回去比精确到分钟重要得多。配额桌面端 `最近 6 份 + 14 天 / 其他各 3`，手机端 `最近 3 份 + 5 天 / 其他各 2`。
3. **总字节数封顶**，超了从旧到新淘汰（桌面端 4GB，手机端 1GB）。份数上限管不住磁盘：一份快照等于一整个库，而库里带着 `repo_file` 源码快照，单份能到几百 MB，乘上二十几份就是几个 GB。上限是尽力而为的——**每一类最新的那一份不参与淘汰**，因为它们各自是一条退路的终点，库本身大到几份就超标时，保底的退路优先于上限。

**清理挂在两处**：新建快照之后，以及每次 `getDb()` / `openDb()`。只挂前者不够——按天保留和总量上限都是随时间过期的，而同步节流之后可能好几天不新建快照，过期文件会一直躺着。

规则 2 和「同步前节流」是一次真实事故推出来的：0.6.7 有人报同步后考点清单和模拟面试数据全没了，而排查时发现该端 10 份同步前快照全部落在两小时的窗口里，事故当时的现场早被挤掉，根本无从对比。备份留了却覆盖不到出问题的时刻，等于没留。

**配置随行**：`app_setting` 整份参与同步，桌面 `config.json` 的改动经镜像下发到手机，因此界面主题（`ui.theme`）也一起过去——手机端只读跟随，不再做一套本机开关，两端观感一致。落库后若 `app_setting` 有变更，手机会重新 hydrate 配置缓存并据此切主题。

**版本闸门**：两端版本号不同就不同步，配对也不建立。桌面端与手机端由同一个 `v*` tag 构建（两条 release workflow 各有一步从 tag 同步版本号），所以同一次发布出来的两个包版本必然相同；反过来，版本不同意味着库结构、协议或合并规则可能已经不是一套，此时同步不是「可能出错」而是可能静默写坏数据。

- 要求补丁号也一致。带数据库迁移的发布经常只抬补丁号，而迁移正是最容易把两端库结构拉开的东西。
- 闸门只设在桌面端（局域网里它是唯一的服务端），`/sync/pair`、`/sync/exchange`、`/sync/rpc` 各一道。`/sync/exchange` 那道**必须挡在 `handleExchange` 之前**——那一步就开始写库了。`/sync/rpc` 也要挡：它转发到的 IPC 处理器同样会写桌面端的库，旧形状的 payload 照样能写出残缺数据。手机端不自行判断，避免两端规则跑偏后互相甩锅。
- 认不出对端版本（不带 `appVersion` 的旧手机端）同样拒绝，但错误文案要说清是让用户去升级，而不是丢一句「参数错误」。
- 返回 409 与 `code: 'versionMismatch'`，手机端据此换成升级指引界面而不是一行红字：这条不是网络抖动，重试一百次也不会好。桌面端同时收到 `sync:versionMismatch` 事件并在设置页提示（限流 5 分钟一次，否则自动同步每 60 秒重试会把提示刷满）——被拒的往往是桌面端（自动更新跑在手机前面），只在手机上提示会让人以为是手机坏了。
- 开发态（`app.isPackaged === false`）放行。仓库里的版本号只在发布时由 tag 同步，平时本来就不一样（`0.6.6` 对 `1.0.0`），照发布态的规则拦会把本地调试链路一起掐死。

**安全**：配对交换 ECDH 派生共享密钥；每个请求带 HMAC 签名（设备 ID + 时间戳 + 路径 + body），防局域网内重放与伪造。

---

## 6. 数据模型

### 6.1 全部数据表与同步范围

一共 32 张表。「同步」一列以 `src/main/sync/tables.ts` 里的 `SYNCED_TABLES` 为准——那是代码里的唯一事实来源，触发器和变更集的列名都从 Drizzle schema 反射得到，不在别处重复写一遍（重复写就一定会有一天忘了改，那个字段会静默地永远同步不过去）。

**Campaign 与输入**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `resume` | 简历母版：正文、解析结果、排版样式、寸照 | 是 |
| `job_target` | 目标岗位：公司 + 岗位 + JD，简历优化与备考共用 | 是 |
| `resume_variant` | 针对某个目标岗位的简历优化版 | 是 |
| `campaign` | 一场备考战役，中心对象 | 是 |

**知识点**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `knowledge_node` | 考点树节点：覆盖类型、考察概率、难度、掌握度、优先级、学习状态、去重用的 embedding | 是 |
| `node_edge` | 考点间的横向关系：`prerequisite` / `related` / `contrast` | 是 |
| `explanation` | 三档深度的讲解正文 | 是 |

**外部来源与检索**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `source` | 检索到的外部来源：URL、可信度、正文 | 是 |
| `search_cache` | 检索结果缓存 | 否 |
| `company_intel` | 公司情报卡：技术栈、面试流程、高频考点、反问素材 | 是 |
| `design_case` | 模拟面试的题目、约束、评分标准、你的作答与参考答案 | 是 |

**面经摄入**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `interview_report` | 面经原文与可信度权重 | 是 |
| `interview_question` | 从面经拆出的题目，以及它匹配到的考点 | 是 |

**计划与执行**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `plan_day` | 某一天的排期 | 是 |
| `task` | 排期里的具体任务 | 是 |
| `quiz_attempt` | 「考我」的作答、评分与改进稿 | 是 |

**源码**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `repo` | 仓库元数据：状态、索引时间、repo map、摘要 | 是，`local_path` 除外 |
| `code_ref` | 代码引用位置与片段 | 是 |
| `repo_file` | 索引时快照的文本文件，供手机端读源码 | 是 |

**标记与话术**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `annotation` | 统一标记表：高亮、笔记、学习状态，五类目标共用 | 是 |
| `speech_snippet` | 话术库：面试时能说出口的话 | 是 |

**会话与可观测**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `session` | 会话，含挂在考点上的追问会话 | 是 |
| `message` | 会话消息，含 token 用量与证据等级 | 是 |
| `tool_call` | 推理过程 trace | 是 |

**配置**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `app_setting` | 应用配置与密钥，整份参与同步 | 是 |

**同步机制自身，以及本机专属**

| 表 | 存什么 | 同步 |
| --- | --- | --- |
| `sync_oplog` | 变更日志，由触发器写入 | 否 |
| `sync_row_version` | 每一行最后一次更新的时间，后写覆盖的判定依据 | 否 |
| `sync_peer` | 已配对的对端设备与同步水位线 | 否 |
| `sync_run` | 每次同步的审计记录，回退入口挂在它上面 | 否 |
| `sync_overwrite` | 后写覆盖里被丢掉的旧值留痕 | 否 |
| `sync_meta` | 本机身份等单例配置 | 否 |
| `prompt_run` | 每次 LLM 调用的落库记录，prompt AB 实验与质量分析的原料 | 否 |

**不同步的四类理由**

- `sync_*` 是同步机制自身的状态，同步它们会递归；何况水位线表达的就是「我和对端各自推进到哪儿」，两端的值本来就必须不同。
- `search_cache` 是纯缓存，两端各自重建即可，传过去只是浪费带宽。
- `prompt_run` 是实验数据，只在产生它的那台设备上有意义，同步过去只会让对端多一份用不上的记录。
- `repo.local_path` 是唯一的**列级**例外：克隆产物在哪个目录是本机的事，传过去会让手机拿到一个不存在的路径。同一张表的 `status`、`indexed_at`、`summary_md` 等元数据仍然要同步，手机端才知道这个仓库索引好了。

**「同步」具体意味着什么**：整行参与后写覆盖合并（细节见 5.7），删除也会传播。而快照文件不在数据库里，两端各自保存、各自回退，不参与同步。

### 6.2 Campaign 与输入

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

### 6.3 知识点

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

### 6.4 外部来源与检索

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

### 6.5 面经摄入

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

### 6.6 计划与执行

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

### 6.7 源码

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

### 6.8 标记与话术

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

### 6.9 会话与可观测

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
| 浅色主题实现 | 在浅色分支重映射 Tailwind 调色板变量 | 逐处补 `dark:` / `light:` 变体或改类名 | 界面有三百多处写死的调色板类，改类名等于重刷 45 个文件、深色也可能回归；v4 的调色板本身就编译成 CSS 变量，重映射一处生效 |
| 默认浅色的落地方式 | `@theme` 保持深色基线，浅色用 `html:not([data-theme='dark'])` 覆盖 | 把浅色搬进 `@theme`、深色改成 `[data-theme='dark']` 覆盖 | 后者更「正」，但要把整套调色板重映射连同 Tailwind 原始色阶对调写回去，两套主题极易弄混；`:not(dark)` 只动选择器，同时保证无属性时也是浅色、不闪深色帧 |
| 主题偏好存放 | `AppConfig.ui.theme`，随 `app_setting` 同步 | 各端本机偏好（`sync_meta` / localStorage） | 配置本来整份同步，手机端不必再做一套开关；代价是两端不能各用一套主题，目前不需要 |
| 手机端主题 | 订阅式 store + `useTheme()`，组件内变量仍叫 `theme` | 保留静态 `theme` 对象、切主题时整树 remount | 静态对象换不了主题；remount 会重置导航与页面状态。删掉静态导出可让类型检查器枚举全部四百多处引用，变量同名则组件内部零改动 |
| 更新源默认值 | 默认查官方 GitHub Release，`feedUrl` 作为覆盖项 | 保持 `feedUrl` 必填，空则完全不联网 | 安装包本来就发在 GitHub Release，必填等于默认没有更新检测；不联网的诉求由「启动检查」开关承担，手动检查是用户主动行为 |
| 按钮图标化的边界 | 语义普及的动作（删除、上移、下移）纯图标，其余图标 + 文字 | 全部配文字，或全部换成图标 | 垃圾桶不需要「删除」二字，但「AI 优化」「至今」这类换成图标只能靠猜；手机端更严格：没有 hover tooltip，纯图标一律要 `accessibilityLabel` |
| 手机端更新方式 | 问 GitHub Releases API，下 APK 后唤起系统安装器，只在用户点按时检测 | 接 `expo-updates` / EAS Update，或后台定时轮询 | APK 本来就挂在 release 上，再建一套 OTA 服务器只是重复；`expo-updates` 只能换 JS bundle，而这个 App 一直在加原生模块（相机、打印、安装器），换不了原生的更新等于没更新。匿名 API 每小时 60 次，轮询容易撞限流，手动检查也符合「不想联网就别点」 |
| 同一段选区的划词动作 | 笔记、细化、存话术每段只做一次，做过就禁按钮并说明原因 | 允许重复，或后一次覆盖前一次 | 这三个都是「新增一条」，重复点只会攒出内容一样的多条记录，复习时还得自己认哪条有用；覆盖则会悄悄弄丢已经写好的笔记。高亮不在此列：它走删旧建新的更新路径，本来就只有一条。判定与落库共用 `findMarkOnSelection`，界面禁用只是提示，真正兜住连点和两端并发的是主进程与手机端数据层的幂等 |
| 重新生成的要求输入 | 桌面锚在「重新生成」按钮上的弹层，手机复用划词那套动作弹层 | 工具栏下方内联展开一块 | 内联块把正文往下顶，还会和划选浮窗抢同一片位置；讲解里其他输入（编辑讲解、记笔记、细化）都在弹层里，重新生成没道理自成一套 |
| 手机端月份选择 | 自己搭年 + 月面板（Modal + 月份格子） | 接 `@react-native-community/datetimepicker` | 原生模块要重新 prebuild 才生效，而系统选择器是年月日三段，简历只要年月；自搭的面板还能顺手给「清空」留位置（留空的字段不进 PDF） |

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
- 「考我」出题 → 参考答案（可编辑、可入话术库）→ 评分 → 反馈 → 改进话术 → 回写掌握度
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

---

## 附：许可证

本项目源代码采用 [Apache License 2.0](../LICENSE)。第三方依赖（如 Expo、Electron）各自遵循其许可证。
