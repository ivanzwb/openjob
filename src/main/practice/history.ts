/**
 * 把 quiz_attempt / design_case 投影成只读 PracticeAttempt。
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
} from '@shared/practice';
import type { ExamForm } from '@shared/enums';
import {
  LEGACY_EXAM_FORM_TO_FORMAT_ID,
  softwareEngineeringRolePack,
} from '@shared/plugins/builtin/softwareEngineering';
import type { RolePack } from '@shared/plugins/types';
import { listPracticeAttemptRows, listScores, rowToPracticeAttempt } from './repository';

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

interface DesignRow {
  id: string;
  interview_type: string;
  title: string;
  scenario_md: string;
  user_answer_md: string | null;
  updated_at: number;
}

function rubricIdForFormat(rolePack: RolePack, formatId: string): string {
  return rolePack.interviewFormats.find((item) => item.id === formatId)?.rubricId ?? '';
}

function isExamForm(value: string): value is ExamForm {
  return Object.hasOwn(LEGACY_EXAM_FORM_TO_FORMAT_ID, value);
}

/**
 * 旧「考我」链路无论考点声明了什么题型，用的都是 quiz.question 那一套，所以一律
 * 投影成技术知识问答，而不是按 node.exam_forms 猜一个。
 */
function projectQuizAttempts(
  raw: Database,
  rolePack: RolePack,
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

  const formatId = LEGACY_EXAM_FORM_TO_FORMAT_ID.concept;
  const rubricId = rubricIdForFormat(rolePack, formatId);

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
 * design_case 投影。
 *
 * totalScore 恒为 null：旧链路把分数返回给界面就丢了，库里只有题目和作答。填 0
 * 会让这条记录在历史里显示成「评了 0 分」。
 */
function projectDesignCases(
  raw: Database,
  rolePack: RolePack,
  campaignId: string,
): PracticeAttempt[] {
  const rows = raw
    .prepare(
      `SELECT id, interview_type, title, scenario_md, user_answer_md, updated_at
       FROM design_case
       WHERE campaign_id = ? AND user_answer_md IS NOT NULL AND trim(user_answer_md) <> ''`,
    )
    .all(campaignId) as DesignRow[];

  return rows.map((row) => {
    const formatId = isExamForm(row.interview_type)
      ? LEGACY_EXAM_FORM_TO_FORMAT_ID[row.interview_type]
      : LEGACY_EXAM_FORM_TO_FORMAT_ID.design;
    return {
      id: row.id,
      source: 'design' as const,
      readOnly: true,
      campaignId,
      nodeId: null,
      formatId,
      rubricId: rubricIdForFormat(rolePack, formatId),
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
 * 指定 nodeId 时不返回 design 记录：design_case 不绑定考点，硬塞进考点历史里会让
 * 用户以为这条记录属于这个考点。
 */
export function listPracticeHistory(
  raw: Database,
  query: PracticeAttemptQuery,
  rolePack: RolePack = softwareEngineeringRolePack,
): PracticeAttempt[] {
  const sources = new Set(query.sources ?? ['practice', 'quiz', 'design']);
  const scopedToNode = query.nodeId !== undefined && query.nodeId !== null;
  const merged: PracticeAttempt[] = [];

  if (sources.has('practice')) {
    merged.push(...projectPracticeAttempts(raw, query.campaignId, query.nodeId));
  }
  if (sources.has('quiz')) {
    merged.push(...projectQuizAttempts(raw, rolePack, query.campaignId, query.nodeId));
  }
  if (sources.has('design') && !scopedToNode) {
    merged.push(...projectDesignCases(raw, rolePack, query.campaignId));
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
