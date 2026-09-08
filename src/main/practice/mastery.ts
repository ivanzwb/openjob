/**
 * 桌面端掌握度的唯一写库入口。
 *
 * 收成一处之前有两个写入方，规则并不一致：答题提交按 0.3/0.7 混合并标 'quiz'，
 * 对话里的 update_mastery 工具直接覆盖成绝对值并标 'mixed'——后者还漏了 status，
 * 于是掌握度掉到 2 分以下、节点却仍然显示「已掌握」。两套写法各自都说得通，问题
 * 是没人能回答「这个数字是怎么来的」，而掌握度是复练、优先级和当天计划的输入。
 *
 * 所以规则放 shared（两端同一份 applyMasterySignal），写库只留这一处：要改混合
 * 权重只有一个地方可改，要查 status / priority_score 何时被重算也只有一个地方要看。
 */

import type { Database } from 'better-sqlite3';
import {
  applyMasterySignal,
  masteryToStatus,
  type MasterySignal,
  type PracticeMasteryUpdate,
} from '@shared/practice';
import type { CoverageType, MasterySource } from '@shared/enums';
import { computePriority } from '../diagnosis/priority';

interface MasteryRow {
  id: string;
  coverage_type: CoverageType;
  exam_prob: number;
  est_minutes: number;
  mastery: number;
  mastery_source: MasterySource;
}

/**
 * 写入一次掌握度信号，并同步重算 status 与 priority_score。
 *
 * 三个派生字段一起写：mastery 变了而 status 没变，界面上就会出现「2 分的已掌握」；
 * priority_score 不跟着变，今天该学什么就还是按旧掌握度排的。
 */
export function writeMasterySignal(
  raw: Database,
  nodeId: string,
  signal: MasterySignal,
): PracticeMasteryUpdate {
  const row = raw
    .prepare(
      `SELECT id, coverage_type, exam_prob, est_minutes, mastery, mastery_source
       FROM knowledge_node WHERE id = ?`,
    )
    .get(nodeId) as MasteryRow | undefined;
  if (!row) throw new Error('考点不存在');

  const next = applyMasterySignal(
    { mastery: row.mastery, masterySource: row.mastery_source },
    signal,
  );
  const status = masteryToStatus(next.mastery);
  const priority = computePriority({
    id: row.id,
    coverageType: row.coverage_type,
    examProb: row.exam_prob,
    estMinutes: row.est_minutes,
    mastery: next.mastery,
  });

  raw
    .prepare(
      `UPDATE knowledge_node
       SET mastery = ?, mastery_source = ?, status = ?, priority_score = ?
       WHERE id = ?`,
    )
    .run(next.mastery, next.masterySource, status, priority.score, nodeId);

  return { nodeId, mastery: next.mastery, status, priorityScore: priority.score };
}
