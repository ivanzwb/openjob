/**
 * Phase 0 兼容性闸门的标准战役：一个插件化之前就存在的软件工程 Campaign。
 *
 * 桌面「旧库不重建」回归和共享层闸门必须喂同一份输入，否则「两端一致」这类
 * 断言只是各自和自己比。数据刻意做成插件化之前的形状——没有 role_profile、
 * 没有 binding、没有 descriptor，全靠回填补齐。
 */
import type { CoverageType, ExamForm, NodeKind, PlanDayStatus, RepoStatus, TaskKind, TaskStatus } from '../../enums';

export const PHASE0_CAMPAIGN = {
  id: 'phase0-campaign',
  company: '示例科技',
  roleTitle: '后端工程师',
  jdRaw: [
    '熟悉 MySQL 索引优化与慢查询排查；',
    '精通 Redis 缓存与持久化；',
    '有分布式系统设计经验；',
    '能独立完成算法编码题。',
  ].join('\n'),
  status: 'planning',
  dailyMinutes: 180,
  interviewDate: '2026-03-09',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as const;

export interface Phase0Node {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  coverageType: CoverageType;
  examForms: ExamForm[];
  difficulty: number;
  estMinutes: number;
  priorityScore: number;
}

/**
 * 四种工程题型各至少一个考点。
 *
 * 闸门要证明插件化没有让任何一种题型消失，所以 concept/coding/design/scenario
 * 必须在这里齐全——少一种，对应的断言就退化成空跑。
 */
export const PHASE0_NODES: readonly Phase0Node[] = [
  {
    id: 'phase0-node-backend',
    parentId: null,
    name: '后端基础',
    kind: 'domain',
    coverageType: 'deepDive',
    examForms: [],
    difficulty: 3,
    estMinutes: 30,
    priorityScore: 0.9,
  },
  {
    id: 'phase0-node-index',
    parentId: 'phase0-node-backend',
    name: 'MySQL 索引',
    kind: 'topic',
    coverageType: 'deepDive',
    examForms: ['concept'],
    difficulty: 3,
    estMinutes: 30,
    priorityScore: 0.8,
  },
  {
    id: 'phase0-node-pushdown',
    parentId: 'phase0-node-index',
    name: '索引下推',
    kind: 'point',
    coverageType: 'gap',
    examForms: ['concept'],
    difficulty: 4,
    estMinutes: 25,
    priorityScore: 0.7,
  },
  {
    id: 'phase0-node-coding',
    parentId: 'phase0-node-backend',
    name: '算法与编码',
    kind: 'topic',
    coverageType: 'gap',
    examForms: ['coding'],
    difficulty: 4,
    estMinutes: 40,
    priorityScore: 0.6,
  },
  {
    id: 'phase0-node-design',
    parentId: 'phase0-node-backend',
    name: '分布式系统设计',
    kind: 'topic',
    coverageType: 'deepDive',
    examForms: ['design'],
    difficulty: 5,
    estMinutes: 45,
    priorityScore: 0.5,
  },
  {
    id: 'phase0-node-project',
    parentId: 'phase0-node-backend',
    name: '项目深挖',
    kind: 'topic',
    coverageType: 'landmine',
    examForms: ['scenario'],
    difficulty: 3,
    estMinutes: 30,
    priorityScore: 0.4,
  },
];

export interface Phase0Repo {
  id: string;
  url: string;
  localPath: string;
  status: RepoStatus;
}

/**
 * 未索引的那个仓库 url 刻意排在前面。
 *
 * 默认仓库按 (url, id) 取第一个，若哪天选仓库时漏掉 status 过滤，就会挑中
 * 这个还没索引好的仓库，断言随即失败。
 */
export const PHASE0_REPOS: readonly Phase0Repo[] = [
  {
    id: 'phase0-repo-pending',
    url: 'https://example.com/a-service.git',
    localPath: '/tmp/phase0/a-service',
    status: 'pending',
  },
  {
    id: 'phase0-repo-ready',
    url: 'https://example.com/z-service.git',
    localPath: '/tmp/phase0/z-service',
    status: 'ready',
  },
];

export const PHASE0_READY_REPO_ID = 'phase0-repo-ready';

export interface Phase0PlanDay {
  id: string;
  date: string;
  plannedMinutes: number;
  status: PlanDayStatus;
}

export const PHASE0_PLAN_DAYS: readonly Phase0PlanDay[] = [
  { id: 'phase0-day-1', date: '2026-03-02', plannedMinutes: 150, status: 'done' },
  { id: 'phase0-day-2', date: '2026-03-03', plannedMinutes: 175, status: 'pending' },
];

export interface Phase0Task {
  id: string;
  planDayId: string;
  nodeId: string | null;
  repoId: string | null;
  kind: TaskKind;
  estMinutes: number;
  status: TaskStatus;
  orderIdx: number;
}

/** 含一条已排好的 readCode：权限网关判定仓库是否在战役范围内要靠它。 */
export const PHASE0_TASKS: readonly Phase0Task[] = [
  {
    id: 'phase0-task-learn',
    planDayId: 'phase0-day-1',
    nodeId: 'phase0-node-index',
    repoId: null,
    kind: 'learn',
    estMinutes: 30,
    status: 'done',
    orderIdx: 0,
  },
  {
    id: 'phase0-task-drill',
    planDayId: 'phase0-day-1',
    nodeId: 'phase0-node-pushdown',
    repoId: null,
    kind: 'drill',
    estMinutes: 20,
    status: 'done',
    orderIdx: 1,
  },
  {
    id: 'phase0-task-readcode',
    planDayId: 'phase0-day-2',
    nodeId: null,
    repoId: PHASE0_READY_REPO_ID,
    kind: 'readCode',
    estMinutes: 25,
    status: 'pending',
    orderIdx: 5,
  },
];

/** readCode 的既有时长，插件化后仍应由岗位包模板给出同一个值。 */
export const PHASE0_READ_CODE_MINUTES = 25;
