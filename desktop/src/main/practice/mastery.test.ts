/**
 * 掌握度回写：一条路径，三个派生字段一起动。
 *
 * 这组用例守的是 T12 的一条验收——「mastery 回写路径唯一」。收拢之前答题提交与
 * update_mastery 工具各写一遍，工具那条还漏了 status，所以库里会出现「掌握度 1.5
 * 分但状态是已掌握」。最后一个用例直接扫源码：新增第二个写入方时它会失败。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_ID, NODE_ID, newPracticeDb, nodeRow } from './__fixtures__/campaign';
import { writeMasterySignal } from './mastery';

describe('writeMasterySignal', () => {
  it('首次答题与先验各占一半，来源标成 quiz', () => {
    const raw = newPracticeDb({ mastery: 2, masterySource: 'self' });

    const update = writeMasterySignal(raw, NODE_ID, { kind: 'practice', score: 4 });

    expect(update.mastery).toBeCloseTo(3, 5);
    expect(nodeRow(raw)).toMatchObject({ mastery: 3, mastery_source: 'quiz' });
  });

  it('已经有客观分之后，新一次答题占七成', () => {
    const raw = newPracticeDb({ mastery: 2, masterySource: 'quiz' });

    const update = writeMasterySignal(raw, NODE_ID, { kind: 'practice', score: 4 });

    // 2 * 0.3 + 4 * 0.7
    expect(update.mastery).toBeCloseTo(3.4, 5);
  });

  it('对话里的自评是绝对值，来源标成 mixed 而不是 quiz', () => {
    const raw = newPracticeDb({ mastery: 2, masterySource: 'quiz' });

    const update = writeMasterySignal(raw, NODE_ID, { kind: 'selfReport', mastery: 5 });

    // 自评不与客观分混合，但也不许冒充客观分
    expect(update.mastery).toBe(5);
    expect(nodeRow(raw).mastery_source).toBe('mixed');
  });

  it('自评超出 0-5 时收敛到边界', () => {
    const raw = newPracticeDb({ mastery: 2 });

    expect(writeMasterySignal(raw, NODE_ID, { kind: 'selfReport', mastery: 9 }).mastery).toBe(5);
    expect(writeMasterySignal(raw, NODE_ID, { kind: 'selfReport', mastery: -3 }).mastery).toBe(0);
  });

  /**
   * 收拢前 update_mastery 工具只写 mastery / mastery_source / priority_score。
   * 于是「已掌握」的考点被自评降到 1 分后仍然显示已掌握，也不会被重新排进计划。
   */
  it('掌握度掉下去时 status 跟着掉——这是收拢前工具那条路径漏掉的', () => {
    const raw = newPracticeDb({ mastery: 4.8, masterySource: 'mixed' });
    raw.prepare(`UPDATE knowledge_node SET status = 'mastered' WHERE id = ?`).run(NODE_ID);

    const update = writeMasterySignal(raw, NODE_ID, { kind: 'selfReport', mastery: 1 });

    expect(update.status).toBe('shaky');
    expect(nodeRow(raw).status).toBe('shaky');
  });

  it('掌握度上去时 priority_score 跟着下来', () => {
    const raw = newPracticeDb({ mastery: 1, masterySource: 'quiz' });
    const before = nodeRow(raw).priority_score;

    const update = writeMasterySignal(raw, NODE_ID, { kind: 'practice', score: 5 });

    // 掌握差距变小，同一考点在今天的计划里应该往后排
    expect(update.priorityScore).toBeLessThan(before === 0 ? Number.POSITIVE_INFINITY : before);
    expect(nodeRow(raw).priority_score).toBeCloseTo(update.priorityScore, 10);
  });

  it('考点不存在时报错，而不是静默建一行', () => {
    const raw = newPracticeDb();

    expect(() => writeMasterySignal(raw, 'n-missing', { kind: 'practice', score: 3 })).toThrow(
      '考点不存在',
    );
    expect(
      raw.prepare(`SELECT count(*) AS n FROM knowledge_node WHERE campaign_id = ?`).get(CAMPAIGN_ID),
    ).toEqual({ n: 1 });
  });
});

/**
 * 唯一写入方的静态守卫。
 *
 * 只认「UPDATE 既有考点的掌握度」，不管建考点时把 mastery 初始化成 0 的 INSERT：
 * 后者不是一次评分回写，拦下来只会逼着新建路径绕过这条规则。
 */
describe('回写路径唯一', () => {
  const MAIN_DIR = join(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : sourceFiles(path);
      }
      if (!entry.name.endsWith('.ts')) return [];
      if (entry.name.endsWith('.test.ts')) return [];
      return [path];
    });
  }

  it('src/main 里只有 practice/mastery.ts 会 UPDATE 掌握度', () => {
    const rawSqlUpdate = /UPDATE\s+knowledge_node[\s\S]{0,400}?\bmastery\s*=/;
    const drizzleUpdate = /\.update\(\s*schema\.knowledgeNode\s*\)[\s\S]{0,400}?\bmastery\s*:/;

    const writers = sourceFiles(MAIN_DIR)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return rawSqlUpdate.test(source) || drizzleUpdate.test(source);
      })
      .map((file) => file.slice(MAIN_DIR.length + 1).replace(/\\/g, '/'));

    expect(writers).toEqual(['practice/mastery.ts']);
  });
});
