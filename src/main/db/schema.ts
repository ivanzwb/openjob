import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AnnotationKind,
  AnnotationTarget,
  CampaignStatus,
  CoverageType,
  EdgeRelation,
  EvidenceKind,
  ExamForm,
  ExplanationTier,
  MasterySource,
  MessageRole,
  NodeKind,
  NodeStatus,
  PlanDayStatus,
  ReportSourceType,
  RepoStatus,
  SessionKind,
  SourceProvider,
  SpeechSourceType,
  TaskKind,
  TaskStatus,
  ToolName,
} from '../../shared/enums';
import type { Citation, JdParsed, ResumeParsed } from '../../shared/entities';
import type { MockInterviewKind, MockInterviewType } from '../../shared/design/prompts';

/**
 * 全量 schema 一次到位——后续阶段只填数据不改结构，避免频繁迁移。
 *
 * 约定：
 * - 时间统一 epoch 毫秒的 integer
 * - 日期（无时间）用 'YYYY-MM-DD' 的 text
 * - JSON 列用 text + mode:'json'，配 $type 保留类型
 */

// ---------------------------------------------------------------------------
// Campaign 与输入
// ---------------------------------------------------------------------------

export const resume = sqliteTable('resume', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  rawText: text('raw_text').notNull(),
  parsed: text('parsed', { mode: 'json' }).$type<ResumeParsed>(),
  /** 排版模板等预览样式，JSON 字符串；null 表示用默认模板 */
  previewStyle: text('preview_style'),
  /**
   * 寸照，data URL。刻意不放进 raw_text：正文会整份交给模型重排与优化，
   * 图片进了正文既白烧 token，也会在重排后丢失。
   */
  photo: text('photo'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** 目标岗位：公司 + 岗位 + JD，简历优化与备考共用 */
export const jobTarget = sqliteTable(
  'job_target',
  {
    id: text('id').primaryKey(),
    company: text('company').notNull(),
    roleTitle: text('role_title').notNull(),
    jdRaw: text('jd_raw').notNull(),
    jdParsed: text('jd_parsed', { mode: 'json' }).$type<JdParsed>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_job_target_company').on(t.company, t.roleTitle)],
);

/** 针对某目标岗位的简历优化版 */
export const resumeVariant = sqliteTable(
  'resume_variant',
  {
    id: text('id').primaryKey(),
    // 优化版生成后就是独立的一份简历：母版被删只是断开来源，不跟着删
    sourceResumeId: text('source_resume_id').references(() => resume.id, {
      onDelete: 'set null',
    }),
    jobTargetId: text('job_target_id')
      .notNull()
      .references(() => jobTarget.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    contentMd: text('content_md').notNull(),
    changelogMd: text('changelog_md').default('').notNull(),
    previewStyle: text('preview_style'),
    /** 寸照 data URL，生成时继承母版 */
    photo: text('photo'),
    isUserEdited: integer('is_user_edited', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_resume_variant_target').on(t.jobTargetId),
    index('idx_resume_variant_source').on(t.sourceResumeId),
  ],
);

export const campaign = sqliteTable('campaign', {
  id: text('id').primaryKey(),
  company: text('company').notNull(),
  roleTitle: text('role_title').notNull(),
  jdRaw: text('jd_raw').notNull(),
  jdParsed: text('jd_parsed', { mode: 'json' }).$type<JdParsed>(),
  jobTargetId: text('job_target_id').references(() => jobTarget.id, { onDelete: 'set null' }),
  resumeId: text('resume_id').references(() => resume.id, { onDelete: 'set null' }),
  interviewDate: text('interview_date'),
  dailyMinutes: integer('daily_minutes'),
  status: text('status').$type<CampaignStatus>().notNull().default('planning'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ---------------------------------------------------------------------------
// 知识点
// ---------------------------------------------------------------------------

export const knowledgeNode = sqliteTable(
  'knowledge_node',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    // 自引用不加 references()，避免 drizzle 处理循环引用时的类型推断问题
    parentId: text('parent_id'),
    name: text('name').notNull(),
    kind: text('kind').$type<NodeKind>().notNull(),
    coverageType: text('coverage_type').$type<CoverageType>().notNull(),
    examProb: real('exam_prob').notNull().default(0),
    difficulty: integer('difficulty').notNull().default(3),
    estMinutes: integer('est_minutes').notNull().default(30),
    examForms: text('exam_forms', { mode: 'json' }).$type<ExamForm[]>().notNull().default([]),
    mastery: real('mastery').notNull().default(0),
    masterySource: text('mastery_source').$type<MasterySource>().notNull().default('self'),
    priorityScore: real('priority_score').notNull().default(0),
    status: text('status').$type<NodeStatus>().notNull().default('todo'),
    /** Float32Array 序列化后的字节，用于细化去重与真题匹配 */
    embedding: text('embedding', { mode: 'json' }).$type<number[]>(),
    isUserAdded: integer('is_user_added', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_node_campaign').on(t.campaignId),
    index('idx_node_parent').on(t.parentId),
    index('idx_node_priority').on(t.campaignId, t.priorityScore),
  ],
);

export const nodeEdge = sqliteTable(
  'node_edge',
  {
    id: text('id').primaryKey(),
    fromNodeId: text('from_node_id')
      .notNull()
      .references(() => knowledgeNode.id, { onDelete: 'cascade' }),
    toNodeId: text('to_node_id')
      .notNull()
      .references(() => knowledgeNode.id, { onDelete: 'cascade' }),
    relation: text('relation').$type<EdgeRelation>().notNull(),
  },
  (t) => [index('idx_edge_from').on(t.fromNodeId), index('idx_edge_to').on(t.toNodeId)],
);

export const explanation = sqliteTable(
  'explanation',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => knowledgeNode.id, { onDelete: 'cascade' }),
    tier: text('tier').$type<ExplanationTier>().notNull(),
    contentMd: text('content_md').notNull(),
    modelUsed: text('model_used').notNull(),
    sourceIds: text('source_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at').notNull(),
  },
  // 三档分别缓存，同一节点同一档位只保留一条
  (t) => [index('idx_explanation_node_tier').on(t.nodeId, t.tier)],
);

// ---------------------------------------------------------------------------
// 外部来源与检索
// ---------------------------------------------------------------------------

export const source = sqliteTable(
  'source',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    domain: text('domain').notNull(),
    title: text('title').notNull(),
    provider: text('provider').$type<SourceProvider>().notNull(),
    credibility: integer('credibility').notNull().default(3),
    publishedAt: integer('published_at'),
    fetchedAt: integer('fetched_at').notNull(),
    contentMd: text('content_md'),
  },
  (t) => [index('idx_source_url').on(t.url), index('idx_source_domain').on(t.domain)],
);

export const searchCache = sqliteTable(
  'search_cache',
  {
    id: text('id').primaryKey(),
    queryHash: text('query_hash').notNull(),
    provider: text('provider').notNull(),
    paramsJson: text('params_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    resultsJson: text('results_json', { mode: 'json' }).$type<unknown[]>().notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    ttlDays: integer('ttl_days').notNull(),
  },
  (t) => [index('idx_search_cache_hash').on(t.queryHash)],
);

export const companyIntel = sqliteTable('company_intel', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id')
    .notNull()
    .references(() => campaign.id, { onDelete: 'cascade' }),
  techStackMd: text('tech_stack_md').notNull().default(''),
  interviewProcessMd: text('interview_process_md').notNull().default(''),
  hotTopicsMd: text('hot_topics_md').notNull().default(''),
  talkingPointsMd: text('talking_points_md').notNull().default(''),
  sourceIds: text('source_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  updatedAt: integer('updated_at').notNull(),
});

export const designCase = sqliteTable(
  'design_case',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    requestedType: text('requested_type').$type<MockInterviewType>().notNull(),
    interviewType: text('interview_type').$type<MockInterviewKind>().notNull(),
    relatedNodeName: text('related_node_name'),
    title: text('title').notNull(),
    scenarioMd: text('scenario_md').notNull(),
    constraints: text('constraints', { mode: 'json' }).$type<string[]>().notNull().default([]),
    evaluationCriteria: text('evaluation_criteria', { mode: 'json' }).$type<string[]>().notNull().default([]),
    userAnswerMd: text('user_answer_md'),
    recommendedAnswerMd: text('recommended_answer_md'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_design_case_campaign_type').on(t.campaignId, t.requestedType)],
);

// ---------------------------------------------------------------------------
// 面经摄入（三入口统一管道）
// ---------------------------------------------------------------------------

export const interviewReport = sqliteTable(
  'interview_report',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id').references(() => campaign.id, { onDelete: 'set null' }),
    company: text('company').notNull(),
    roleTitle: text('role_title').notNull(),
    sourceType: text('source_type').$type<ReportSourceType>().notNull(),
    sourceId: text('source_id').references(() => source.id, { onDelete: 'set null' }),
    rawText: text('raw_text').notNull(),
    reportedAt: integer('reported_at'),
    /** selfDebrief 最高、web 最低，影响频率修正的权重 */
    credibilityWeight: real('credibility_weight').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_report_company').on(t.company, t.roleTitle)],
);

export const interviewQuestion = sqliteTable(
  'interview_question',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => interviewReport.id, { onDelete: 'cascade' }),
    questionText: text('question_text').notNull(),
    roundNo: integer('round_no'),
    matchedNodeId: text('matched_node_id').references(() => knowledgeNode.id, {
      onDelete: 'set null',
    }),
    matchConfidence: real('match_confidence'),
    /** 匹配不到节点 = 图谱预测失败，信息价值最高 */
    isBlindSpot: integer('is_blind_spot', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_question_report').on(t.reportId),
    index('idx_question_node').on(t.matchedNodeId),
  ],
);

// ---------------------------------------------------------------------------
// 计划与执行
// ---------------------------------------------------------------------------

export const planDay = sqliteTable(
  'plan_day',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    plannedMinutes: integer('planned_minutes').notNull().default(0),
    status: text('status').$type<PlanDayStatus>().notNull().default('pending'),
  },
  (t) => [index('idx_plan_day_campaign_date').on(t.campaignId, t.date)],
);

export const task = sqliteTable(
  'task',
  {
    id: text('id').primaryKey(),
    planDayId: text('plan_day_id')
      .notNull()
      .references(() => planDay.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').references(() => knowledgeNode.id, { onDelete: 'cascade' }),
    repoId: text('repo_id'),
    kind: text('kind').$type<TaskKind>().notNull(),
    estMinutes: integer('est_minutes').notNull().default(20),
    actualMinutes: integer('actual_minutes'),
    status: text('status').$type<TaskStatus>().notNull().default('pending'),
    orderIdx: integer('order_idx').notNull().default(0),
  },
  (t) => [index('idx_task_plan_day').on(t.planDayId, t.orderIdx)],
);

export const quizAttempt = sqliteTable(
  'quiz_attempt',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => knowledgeNode.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    userAnswer: text('user_answer').notNull(),
    /** 1-5，掌握度的唯一客观来源 */
    score: integer('score').notNull(),
    feedbackMd: text('feedback_md').notNull().default(''),
    improvedScriptMd: text('improved_script_md'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_quiz_node').on(t.nodeId)],
);

// ---------------------------------------------------------------------------
// 源码
// ---------------------------------------------------------------------------

export const repo = sqliteTable('repo', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  localPath: text('local_path').notNull(),
  defaultBranch: text('default_branch'),
  commitSha: text('commit_sha'),
  languages: text('languages', { mode: 'json' }).$type<string[]>().notNull().default([]),
  repoMapMd: text('repo_map_md'),
  summaryMd: text('summary_md'),
  indexedAt: integer('indexed_at'),
  status: text('status').$type<RepoStatus>().notNull().default('pending'),
});

export const codeRef = sqliteTable(
  'code_ref',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repo.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    commitSha: text('commit_sha'),
    snippet: text('snippet'),
  },
  (t) => [index('idx_code_ref_repo').on(t.repoId)],
);

/** 索引时快照的文本文件，供手机端 list_dir / read_file / grep */
export const repoFile = sqliteTable(
  'repo_file',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repo.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    content: text('content').notNull(),
    lineCount: integer('line_count').notNull(),
    byteSize: integer('byte_size').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_repo_file_repo').on(t.repoId),
    index('idx_repo_file_path').on(t.repoId, t.filePath),
  ],
);

// ---------------------------------------------------------------------------
// 标记与话术
// ---------------------------------------------------------------------------

/** 统一标记表：知识点、讲解片段、代码位置、真题、情报卡共用一张表 */
export const annotation = sqliteTable(
  'annotation',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type').$type<AnnotationTarget>().notNull(),
    targetId: text('target_id').notNull(),
    kind: text('kind').$type<AnnotationKind>().notNull(),
    selectedText: text('selected_text'),
    noteMd: text('note_md'),
    highlightColor: text('highlight_color'),
    selectionStart: integer('selection_start'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_annotation_target').on(t.targetType, t.targetId)],
);

/** 所有链路的终点产出：面试时能说出口的话 */
export const speechSnippet = sqliteTable(
  'speech_snippet',
  {
    id: text('id').primaryKey(),
    sourceType: text('source_type').$type<SpeechSourceType>().notNull(),
    sourceId: text('source_id').notNull(),
    tier: text('tier').$type<ExplanationTier>().notNull(),
    contentMd: text('content_md').notNull(),
    isUserEdited: integer('is_user_edited', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_speech_source').on(t.sourceType, t.sourceId)],
);

// ---------------------------------------------------------------------------
// 会话与可观测性
// ---------------------------------------------------------------------------

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id').references(() => campaign.id, { onDelete: 'cascade' }),
    /** 追问会话绑定知识点；其它会话保持 null */
    nodeId: text('node_id').references(() => knowledgeNode.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SessionKind>().notNull(),
    title: text('title').notNull().default(''),
    contextSummaryMd: text('context_summary_md').notNull().default(''),
    contextSummaryThroughId: text('context_summary_through_id'),
    contextSummarySourceCount: integer('context_summary_source_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_session_node').on(t.nodeId, t.kind, t.createdAt)],
);

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    contentMd: text('content_md').notNull(),
    citations: text('citations', { mode: 'json' }).$type<Citation[]>().notNull().default([]),
    /** 本轮回答的实际 token 用量；端点不返回 usage 时为 null */
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /**
     * 这条回答的证据等级（模型知识 / 网络检索 / 代码实证）。
     * 必须落库：来源角标的意义是让用户事后核验答案不是编的，
     * 只在流式过程中出现一次等于没有。
     */
    evidenceKind: text('evidence_kind').$type<EvidenceKind>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_message_session').on(t.sessionId, t.createdAt)],
);

/** 推理过程 trace：既建立信任，也是 Agent 后续的决策输入 */
export const toolCall = sqliteTable(
  'tool_call',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').$type<ToolName>().notNull(),
    args: text('args', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    resultSummary: text('result_summary').notNull().default(''),
    durationMs: integer('duration_ms').notNull().default(0),
    tokenCost: integer('token_cost'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_tool_call_message').on(t.messageId)],
);

// ---------------------------------------------------------------------------
// 端间同步
// ---------------------------------------------------------------------------

/**
 * 变更日志：由 SQLite 触发器写入，业务代码无感知。
 *
 * 为什么日志里只存元数据不存行内容：同步时直接回读业务表的当前值即可，
 * 中间态对 LWW 合并没有意义。存快照会让日志随 embedding、message 这类
 * 大字段迅速膨胀。
 *
 * 删除也记在这里而不是给每张表加 deleted_at —— 软删除要求全代码库每个
 * SELECT 都带过滤条件，漏一处就是已删数据重新出现在 UI 上。
 */
export const syncOplog = sqliteTable(
  'sync_oplog',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    op: text('op').$type<'insert' | 'update' | 'delete'>().notNull(),
    /** 触发器取的本机墙钟毫秒；跨端比较前会用握手测得的时钟偏移校正 */
    wallMs: integer('wall_ms').notNull(),
    deviceId: text('device_id').notNull(),
    /** UPDATE 时实际发生变化的列名，字段级冲突判定的依据；insert/delete 为 null */
    changedFields: text('changed_fields', { mode: 'json' }).$type<string[]>(),
  },
  (t) => [
    index('idx_oplog_row').on(t.tableName, t.rowId),
    index('idx_oplog_seq').on(t.seq),
  ],
);

/** 已配对的对端设备，以及与它的同步水位线 */
export const syncPeer = sqliteTable('sync_peer', {
  deviceId: text('device_id').primaryKey(),
  displayName: text('display_name').notNull(),
  platform: text('platform').notNull(),
  /** 配对时交换的共享密钥，用于请求签名与通道加密 */
  sharedKey: text('shared_key').notNull(),
  lastAddress: text('last_address'),
  /** 上次成功同步后，本机 oplog 推进到的 seq */
  lastLocalSeq: integer('last_local_seq').notNull().default(0),
  /** 上次成功同步时对端 oplog 的 seq */
  lastRemoteSeq: integer('last_remote_seq').notNull().default(0),
  lastSyncAt: integer('last_sync_at'),
  pairedAt: integer('paired_at').notNull(),
});

/** 每次同步的审计记录，回退入口挂在这上面 */
export const syncRun = sqliteTable(
  'sync_run',
  {
    id: text('id').primaryKey(),
    peerDeviceId: text('peer_device_id').notNull(),
    direction: text('direction').$type<'auto' | 'manual'>().notNull(),
    status: text('status')
      .$type<'running' | 'success' | 'conflict' | 'failed' | 'rolledBack'>()
      .notNull(),
    /** 同步前快照的文件名，回退时按它还原 */
    backupFile: text('backup_file'),
    appliedCount: integer('applied_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('idx_sync_run_started').on(t.startedAt)],
);

/** 待用户裁决的冲突。用户选完某一边后才落到业务表 */
export const syncConflict = sqliteTable(
  'sync_conflict',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => syncRun.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    /** 两端都改过的列 */
    field: text('field').notNull(),
    localValue: text('local_value', { mode: 'json' }),
    remoteValue: text('remote_value', { mode: 'json' }),
    localWallMs: integer('local_wall_ms').notNull(),
    remoteWallMs: integer('remote_wall_ms').notNull(),
    resolution: text('resolution').$type<'pending' | 'local' | 'remote'>()
      .notNull()
      .default('pending'),
  },
  (t) => [index('idx_sync_conflict_run').on(t.runId, t.resolution)],
);

/** 跨端同步的应用配置与密钥（明文 JSON，依赖同步通道加密） */
export const appSetting = sqliteTable('app_setting', {
  id: text('id').primaryKey(),
  configJson: text('config_json').notNull(),
  secretsJson: text('secrets_json').notNull().default('{}'),
  updatedAt: integer('updated_at').notNull(),
});

/** 本机身份等单例配置 */
export const syncMeta = sqliteTable('sync_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// Prompt AB 实验（本机专属，不参与端间同步）
// ---------------------------------------------------------------------------

/**
 * 每次 completeJson 调用的落库记录：AB 实验与质量分析的原料。
 *
 * 刻意不进 SYNCED_TABLES——实验数据只在产生它的设备上有意义，同步过去
 * 只会让对端设备多一份无用的重复记录。打标失败也不得影响主流程（吞掉）。
 */
export const promptRun = sqliteTable(
  'prompt_run',
  {
    id: text('id').primaryKey(),
    /** promptId，如 'quiz.question' */
    promptId: text('prompt_id').notNull(),
    /** 实际命中的版本，如 'quiz.question@v1' */
    versionId: text('version_id').notNull(),
    /** 分流指纹：设备 id，决定该调用稳定落在哪个版本 */
    fingerprint: text('fingerprint').notNull(),
    role: text('role').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    /** 本次调用是否成功产出 JSON */
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    /** 失败原因（ok=false 时） */
    error: text('error'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    /** 从发起调用到拿到结果的毫秒数 */
    latencyMs: integer('latency_ms').notNull(),
    /** 原始输出（截断存），供离线回归对比字段完整性 */
    outputJson: text('output_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_prompt_run_prompt_version').on(t.promptId, t.versionId),
    index('idx_prompt_run_created').on(t.createdAt),
  ],
);
