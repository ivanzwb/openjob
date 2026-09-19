/**
 * 把 quiz_attempt 与旧模拟面试题表投影成只读 PracticeAttempt。
 *
 * 投影而不是迁移：旧表继续由旧链路读写，一条历史记录也不改。理由不是省事——把
 * 「只有一个总分」的旧记录搬进新表，就得给四个维度各编一个分和一段引文，那些数字
 * 看起来和真评分一样，却谁也复核不了。宁可让历史记录诚实地缺一块（dimensionScores
 * 为空、readOnly 为 true），也不要一份分不出真假的数据。
 *
 * 于是「练习历史」这个列表有三种来源，按时间合一，来源标在每一行上。
 */

import type { Database } from 'better-sqlite3';
import type {
  PracticeAttempt,
  PracticeAttemptQuery,
  PracticeDimensionScore,
} from '@core/practice';
import { formatIdForExamForm } from '@core/plugins/examForms';
import type { RolePack } from '@core/plugins/types';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema';
import { listPracticeAttemptRows, listScores, rowToPracticeAttempt } from './repository';
import { getCampaignPracticePack } from './rolePack';

/**
 * 旧模拟面试题表的 SQL 名从 schema 反射，不在本模块再抄一遍表名。
 *
 * 那张表是产品经理岗位包当年留下的历史数据（回退路径），宿主只把它投影成只读
 * 历史，表名以 schema 为唯一事实源。
 */
const CASE_TABLE = getTableConfig(schema.caseRecord).name;

const DEFAULT_LIMIT = 50;

interface QuizRow {
  id: string;
  node_id: string;
  campaign_id: string;
  question: string;
  user_answer: string;
  score: number;
  feedback_md: string;
  created_at: number;
}

interface CaseRow {
  id: string;
  interview_type: string;
  title: string;
  scenario_md: string;
  user_answer_md: string | null;
  updated_at: number;
}

/**
 * 量规锚点按 descriptor pin 的岗位包现查，不写死快照。
 *
 * 用户决策：历史投影跟随已安装岗位包——装了什么就按什么投影（同一批旧记录会
 * 因为装了/卸了/换了版本显示成不同的量规）；缺包时返回 null，让投影按空串兜底，
 * 读历史不因为没装包而炸掉。
 */
function rubricIdForFormat(pack: RolePack | null, formatId: string): string {
  return pack?.interviewFormats.find((format) => format.id === formatId)?.rubricId ?? '';
}

/**
 * 旧「考我」链路走的是知识问答协议。
 *
 * 宿主不认识任何具体 formatId，所以按包声明的协议（knowledge）找那个形式；
 * 包没装/没声明时回退空串，读历史照常工作。
 */
function knowledgeFormatId(pack: RolePack | null): string {
  return pack?.interviewFormats.find((format) => format.protocol === 'knowledge')?.id ?? '';
}

/**
 * 旧「考我」链路无论考点声明了什么题型，用的都是 quiz.question 那一套，所以一律
 * 投影成技术知识问答，而不是按 node.exam_forms 猜一个。
 */
function projectQuizAttempts(
  raw: Database,
  campaignId: string,
  nodeId?: string | null,
): PracticeAttempt[] {
  // campaign_id 只在考点上：quiz_attempt 只认 node_id
  const sql = `SELECT a.id, a.node_id, n.campaign_id, a.question, a.user_answer,
                      a.score, a.feedback_md, a.created_at
               FROM quiz_attempt a
               JOIN knowledge_node n ON n.id = a.node_id
               WHERE n.campaign_id = ?`;
  const rows = (
    nodeId === undefined || nodeId === null
      ? raw.prepare(sql).all(campaignId)
      : raw.prepare(`${sql} AND a.node_id = ?`).all(campaignId, nodeId)
  ) as QuizRow[];

  // 题型翻译归岗位包所有：按包声明的协议（knowledge）取对应格式，缺包时回退空串，
  // 读历史照常工作
  const pack = getCampaignPracticePack(raw, campaignId);
  const formatId = knowledgeFormatId(pack);
  const rubricId = rubricIdForFormat(pack, formatId);

  return rows.map((row) => ({
    id: row.id,
    source: 'quiz' as const,
    readOnly: true,
    campaignId: row.campaign_id,
    nodeId: row.node_id,
    formatId,
    rubricId,
    competencyIds: [],
    questionMd: row.question,
    answerMd: row.user_answer,
    transcriptMd: null,
    // 旧记录只有一个总分，按它反推四个维度就是编造
    dimensionScores: {},
    totalScore: row.score,
    feedbackMd: row.feedback_md,
    previousAttemptId: null,
    createdAt: row.created_at,
  }));
}

/**
 * 旧模拟面试题表投影。
 *
 * totalScore 恒为 null：旧链路把分数返回给界面就丢了，库里只有题目和作答。填 0
 * 会让这条记录在历史里显示成「评了 0 分」。
 */
function projectCaseRecords(
  raw: Database,
  campaignId: string,
): PracticeAttempt[] {
  const rows = raw
    .prepare(
      `SELECT id, interview_type, title, scenario_md, user_answer_md, updated_at
       FROM ${CASE_TABLE}
       WHERE campaign_id = ? AND user_answer_md IS NOT NULL AND trim(user_answer_md) <> ''`,
    )
    .all(campaignId) as CaseRow[];

  const pack = getCampaignPracticePack(raw, campaignId);
  return rows.map((row) => {
    // 历史行存的是插件化之前的题型取值：按包声明的题型查它对应的面试形式。宿主不
    // 认识任何一个取值，包没装/没声明该取值时回退空串，读历史照常工作。
    const formatId = formatIdForExamForm(pack, row.interview_type);
    return {
      id: row.id,
      // 归档表投影的来源标成中性的 legacy：宿主不认识这张表的领域语义，只按形状读它
      source: 'legacy' as const,
      readOnly: true,
      campaignId,
      nodeId: null,
      formatId,
      rubricId: rubricIdForFormat(pack, formatId),
      competencyIds: [],
      questionMd: [`# ${row.title}`, row.scenario_md].join('\n\n'),
      answerMd: row.user_answer_md ?? '',
      transcriptMd: null,
      dimensionScores: {},
      totalScore: null,
      feedbackMd: '',
      previousAttemptId: null,
      createdAt: row.updated_at,
    };
  });
}

function projectPracticeAttempts(
  raw: Database,
  campaignId: string,
  nodeId?: string | null,
): PracticeAttempt[] {
  return listPracticeAttemptRows(raw, campaignId, nodeId).map((row) => {
    const dimensionScores: Record<string, number> = {};
    for (const score of listScores(raw, row.id)) {
      dimensionScores[score.dimensionId] = score.score;
    }
    return rowToPracticeAttempt(row, dimensionScores);
  });
}

/**
 * 三种来源合成一个按时间倒序的列表。
 *
 * 指定 nodeId 时不返回旧模拟面试题记录：它不绑定考点，硬塞进考点历史里会让
 * 用户以为这条记录属于这个考点。
 */
export function listPracticeHistory(
  raw: Database,
  query: PracticeAttemptQuery,
): PracticeAttempt[] {
  const sources = new Set(query.sources ?? ['practice', 'quiz', 'legacy']);
  const scopedToNode = query.nodeId !== undefined && query.nodeId !== null;
  const merged: PracticeAttempt[] = [];

  if (sources.has('practice')) {
    merged.push(...projectPracticeAttempts(raw, query.campaignId, query.nodeId));
  }
  if (sources.has('quiz')) {
    merged.push(...projectQuizAttempts(raw, query.campaignId, query.nodeId));
  }
  if (sources.has('legacy') && !scopedToNode) {
    merged.push(...projectCaseRecords(raw, query.campaignId));
  }

  merged.sort((left, right) => right.createdAt - left.createdAt);
  return merged.slice(0, query.limit ?? DEFAULT_LIMIT);
}

/** 单条练习记录的逐维度明细；只读投影没有明细，返回空数组。 */
export function getPracticeAttemptScores(
  raw: Database,
  attemptId: string,
): PracticeDimensionScore[] {
  return listScores(raw, attemptId);
}
