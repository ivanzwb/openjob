/**
 * quiz/design 历史投影。
 *
 * 守两件事：旧记录能以只读形态出现在统一的练习历史里，以及投影不会把缺的东西
 * 补成看起来像真评分的数字——旧记录没有逐维度分，design 连总分都没存过。
 */

import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_ID, KNOWLEDGE_FORMAT_ID, NODE_ID, newPracticeDb } from './__fixtures__/campaign';
import { listPracticeHistory } from './history';

function seedQuizAttempt(
  raw: Database,
  id: string,
  score: number,
  createdAt: number,
  nodeId = NODE_ID,
): void {
  raw
    .prepare(
      `INSERT INTO quiz_attempt (
         id, node_id, question, user_answer, score, feedback_md, improved_script_md, created_at
       ) VALUES (?, ?, '怎么保证幂等', '用去重表', ?, '讲清楚了', '', ?)`,
    )
    .run(id, nodeId, score, createdAt);
}

function seedDesignCase(
  raw: Database,
  id: string,
  answer: string | null,
  updatedAt: number,
  interviewType = 'design',
): void {
  raw
    .prepare(
      `INSERT INTO design_case (
         id, campaign_id, requested_type, interview_type, related_node_name, title,
         scenario_md, constraints, evaluation_criteria, user_answer_md,
         recommended_answer_md, created_at, updated_at
       ) VALUES (?, ?, 'mixed', ?, NULL, '设计一个短链服务',
                 '每天十亿次读', '[]', '[]', ?, NULL, 1, ?)`,
    )
    .run(id, CAMPAIGN_ID, interviewType, answer, updatedAt);
}

describe('listPracticeHistory', () => {
  it('quiz 记录投影成只读 attempt，保留原分数', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-1', 4, 500);

    const [attempt] = listPracticeHistory(raw, { campaignId: CAMPAIGN_ID });

    expect(attempt).toMatchObject({
      id: 'qa-1',
      source: 'quiz',
      readOnly: true,
      campaignId: CAMPAIGN_ID,
      nodeId: NODE_ID,
      // 旧「考我」链路一直用的是技术知识问答那套 prompt
      formatId: KNOWLEDGE_FORMAT_ID,
      rubricId: 'se.technical-knowledge-rubric',
      totalScore: 4,
      questionMd: '怎么保证幂等',
      answerMd: '用去重表',
    });
  });

  /**
   * 旧记录只有一个总分。按总分反推四个维度会造出看起来能复核、实际谁也复核不了的
   * 数字，所以这里必须是空的。
   */
  it('投影不编造逐维度分', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-1', 4, 500);

    const [attempt] = listPracticeHistory(raw, { campaignId: CAMPAIGN_ID });

    expect(attempt.dimensionScores).toEqual({});
    expect(attempt.competencyIds).toEqual([]);
  });

  /**
   * design_case 只存了题目和作答：旧链路把分数返回给界面就丢了。填 0 会让这条记录
   * 在历史里显示成「评了 0 分」，按平均分算趋势时还会把整条曲线压下去。
   */
  it('design 记录的总分是 null，而不是 0', () => {
    const raw = newPracticeDb();
    seedDesignCase(raw, 'dc-1', '先分片再加缓存', 600);

    const [attempt] = listPracticeHistory(raw, { campaignId: CAMPAIGN_ID });

    expect(attempt).toMatchObject({
      id: 'dc-1',
      source: 'design',
      readOnly: true,
      totalScore: null,
      formatId: 'se.system-design',
      rubricId: 'se.system-design-rubric',
    });
    expect(attempt.questionMd).toContain('设计一个短链服务');
    expect(attempt.answerMd).toBe('先分片再加缓存');
  });

  it('还没作答的题目不算练习记录', () => {
    const raw = newPracticeDb();
    seedDesignCase(raw, 'dc-empty', null, 600);
    seedDesignCase(raw, 'dc-blank', '   ', 601);

    expect(listPracticeHistory(raw, { campaignId: CAMPAIGN_ID })).toEqual([]);
  });

  it('三种来源按时间倒序合成一个列表，来源标在每一行上', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-old', 3, 100);
    seedDesignCase(raw, 'dc-mid', '答案', 200);
    seedQuizAttempt(raw, 'qa-new', 5, 300);

    const history = listPracticeHistory(raw, { campaignId: CAMPAIGN_ID });

    expect(history.map((item) => [item.id, item.source])).toEqual([
      ['qa-new', 'quiz'],
      ['dc-mid', 'design'],
      ['qa-old', 'quiz'],
    ]);
  });

  it('按来源筛选', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-1', 3, 100);
    seedDesignCase(raw, 'dc-1', '答案', 200);

    expect(
      listPracticeHistory(raw, { campaignId: CAMPAIGN_ID, sources: ['quiz'] }).map((i) => i.id),
    ).toEqual(['qa-1']);
    expect(
      listPracticeHistory(raw, { campaignId: CAMPAIGN_ID, sources: ['design'] }).map((i) => i.id),
    ).toEqual(['dc-1']);
  });

  /** design_case 不绑定考点，混进考点历史里会让用户以为这条记录属于这个考点 */
  it('按考点筛选时不返回 design 记录', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-1', 3, 100);
    seedDesignCase(raw, 'dc-1', '答案', 200);

    const history = listPracticeHistory(raw, { campaignId: CAMPAIGN_ID, nodeId: NODE_ID });

    expect(history.map((item) => item.id)).toEqual(['qa-1']);
  });

  it('别的 Campaign 的记录不串进来', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-1', 3, 100);
    raw
      .prepare(
        `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
         VALUES ('c-other', 'OTHER', '前端', 'JD', 'planning', 1, 1)`,
      )
      .run();
    seedDesignCase(raw, 'dc-other', '答案', 200);
    raw.prepare(`UPDATE design_case SET campaign_id = 'c-other' WHERE id = 'dc-other'`).run();

    expect(listPracticeHistory(raw, { campaignId: CAMPAIGN_ID }).map((i) => i.id)).toEqual([
      'qa-1',
    ]);
    expect(listPracticeHistory(raw, { campaignId: 'c-other' }).map((i) => i.id)).toEqual([
      'dc-other',
    ]);
  });

  it('limit 生效', () => {
    const raw = newPracticeDb();
    for (let i = 0; i < 5; i++) seedQuizAttempt(raw, `qa-${i}`, 3, 100 + i);

    expect(listPracticeHistory(raw, { campaignId: CAMPAIGN_ID, limit: 2 })).toHaveLength(2);
  });

  it('只读投影没有逐维度明细，不是抛错', () => {
    const raw = newPracticeDb();
    seedQuizAttempt(raw, 'qa-1', 3, 100);

    // 投影行的 id 来自旧表，practice_score 里当然没有对应行
    expect(listPracticeHistory(raw, { campaignId: CAMPAIGN_ID })[0].dimensionScores).toEqual({});
  });
});
