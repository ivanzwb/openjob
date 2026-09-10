/**
 * Phase 1 闸门的标准战役：一个产品经理 Campaign。
 *
 * 与 phase0Campaign 成对使用。Phase 0 证明「插件外壳没有破坏工程流程」，
 * Phase 1 要证明「同一套通用核心换一个岗位包也能整条跑通，而且不把工程口吻
 * 带过去」。两条结论都跨越诊断、组合、排程、练习和复盘，任何单点测试都不会
 * 因为链子断在别处而失败，所以两端都必须喂同一份输入。
 *
 * 这份 fixture 同时给共享层闸门、桌面练习端到端和手机复盘往返使用：三处各自
 * 造一份产品战役的话，「桌面看到的盲区就是手机写的那条」这种断言就退化成
 * 各自和自己比。
 */

import type { CoverageType, ExamForm, NodeKind } from '../../enums';

export const PHASE1_CAMPAIGN = {
  id: 'phase1-campaign',
  company: '示例出行',
  roleTitle: '产品经理',
  jdRaw: [
    '负责会员与增长方向的产品规划，定义目标与成功指标；',
    '组织用户调研，输出可行动的用户结论；',
    '在资源有限的情况下确定需求优先级并推动落地；',
    '与研发、设计和运营协作，对业务结果负责。',
  ].join('\n'),
  status: 'planning',
  dailyMinutes: 120,
  interviewDate: '2026-04-10',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as const;

/** 与 jdRaw 一一对应，供能力诊断使用；权重之和为 1。 */
export const PHASE1_JD_REQUIREMENTS: readonly { skill: string; weight: number }[] = [
  { skill: '定义产品目标与成功指标', weight: 0.3 },
  { skill: '组织用户调研并输出可行动结论', weight: 0.25 },
  { skill: '在资源受限时确定需求优先级', weight: 0.25 },
  { skill: '推动跨职能协作并对业务结果负责', weight: 0.2 },
];

export interface Phase1Node {
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
 * 产品考点。
 *
 * examForms 是插件化之前就存在的字段，取值仍限于 concept/coding/design/scenario。
 * 这里只用 concept 与 scenario：产品战役里出现 coding 就说明有别处在按工程题型
 * 兜底，闸门要能立刻看见。
 */
export const PHASE1_NODES: readonly Phase1Node[] = [
  {
    id: 'phase1-node-product',
    parentId: null,
    name: '产品方法',
    kind: 'domain',
    coverageType: 'deepDive',
    examForms: [],
    difficulty: 3,
    estMinutes: 30,
    priorityScore: 0.9,
  },
  {
    id: 'phase1-node-metrics',
    parentId: 'phase1-node-product',
    name: '指标体系与实验',
    kind: 'topic',
    coverageType: 'gap',
    examForms: ['concept'],
    difficulty: 4,
    estMinutes: 30,
    priorityScore: 0.8,
  },
  {
    id: 'phase1-node-north-star',
    parentId: 'phase1-node-metrics',
    name: '北极星指标与护栏指标',
    kind: 'point',
    coverageType: 'gap',
    examForms: ['concept'],
    difficulty: 4,
    estMinutes: 25,
    priorityScore: 0.75,
  },
  {
    id: 'phase1-node-research',
    parentId: 'phase1-node-product',
    name: '用户调研与洞察',
    kind: 'topic',
    coverageType: 'deepDive',
    examForms: ['scenario'],
    difficulty: 3,
    estMinutes: 25,
    priorityScore: 0.6,
  },
  {
    id: 'phase1-node-prioritization',
    parentId: 'phase1-node-product',
    name: '需求优先级',
    kind: 'topic',
    coverageType: 'landmine',
    examForms: ['scenario'],
    difficulty: 3,
    estMinutes: 20,
    priorityScore: 0.5,
  },
];

/**
 * 手机端面后复盘的原文。
 *
 * 第一题能匹配到已有考点（指标），第二题刻意问一个图谱里没有的方向：往返测试
 * 要同时验证「已有考点被抬概率」和「新盲区被建出来并同步到桌面」两件事，只留
 * 一种的话，桌面那边少了哪一半都看不出来。
 */
export const PHASE1_DEBRIEF_TEXT = [
  '今天面完记录一下。',
  '第一个问题问了北极星指标和护栏指标怎么选，我答得比较泛。',
  '第二个问题问了定价策略怎么做灰度，这块完全没准备到。',
].join('\n');

/** 复盘里那道能匹配上的题命中的考点。 */
export const PHASE1_DEBRIEF_MATCHED_NODE_ID = 'phase1-node-north-star';

/**
 * 产品战役里不该出现的工程口吻。
 *
 * 闸门扫的是真正送给模型的 system prompt，而不只是岗位包声明：声明干净但组合
 * 时被别的层追加进来，用户看到的仍然是一份带编码要求的产品案例题。
 */
export const PHASE1_ENGINEERING_MARKERS: readonly string[] = [
  'coding',
  'qps',
  'repo',
  'readcode',
  '编码',
  '算法题',
  '系统设计',
  '分布式',
  '吞吐',
  '源码',
];
