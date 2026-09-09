/**
 * 手机端关联简历 + 交叉分析。
 *
 * 这里钉住的是失败时的取舍：绑定和分析是两件事，绑定本身就有用（出题和参考答案立刻
 * 能结合履历），分析只是在此之上重算覆盖类型。所以模型挂了要保留绑定让用户重试分析，
 * 而不是把绑定一起回退——回退的话用户得先猜到「刚才那次点击其实什么都没留下」。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../db/migrations/bundle';

const completeJson = vi.hoisted(() => vi.fn());
const ids = vi.hoisted(() => ({ next: 0 }));

vi.mock('../llm/json', () => ({ completeJson }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    ids.next += 1;
    return `uuid-${ids.next}`;
  },
}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('../sync/identity', () => ({
  getDeviceIdentity: () => Promise.resolve({ deviceId: 'phone-1' }),
}));

const { diagnoseAttachResume } = await import('./diagnosisLocal');

function adapt(db: DatabaseSync): SQLiteDatabase {
  const shim = {
    execSync: (sql: string) => db.exec(sql),
    runSync: (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[])),
    getAllSync: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])),
    getFirstSync: (sql: string, ...args: unknown[]) =>
      db.prepare(sql).get(...(args as never[])) ?? null,
    closeSync: () => db.close(),
  };
  return shim as unknown as SQLiteDatabase;
}

let db: SQLiteDatabase;

function insertNode(id: string, name: string, coverage = 'gap'): void {
  db.runSync(
    `INSERT INTO knowledge_node
       (id, campaign_id, parent_id, name, kind, coverage_type, exam_prob, difficulty,
        est_minutes, exam_forms, mastery, mastery_source, priority_score, status, is_user_added, created_at)
     VALUES (?, 'c1', NULL, ?, 'point', ?, 0.5, 3, 30, '["concept"]', 1, 'self', 0, 'todo', 0, 1)`,
    id,
    name,
    coverage,
  );
}

function coverageOf(id: string): string {
  return db.getFirstSync<{ coverage_type: string }>(
    `SELECT coverage_type FROM knowledge_node WHERE id = ?`,
    id,
  )!.coverage_type;
}

function boundResumeId(): string | null {
  return db.getFirstSync<{ resume_id: string | null }>(
    `SELECT resume_id FROM campaign WHERE id = 'c1'`,
  )!.resume_id;
}

beforeEach(() => {
  db = adapt(new DatabaseSync(':memory:'));
  db.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.execSync(statement);
    }
  }

  db.runSync(
    `INSERT INTO resume (id, label, raw_text, parsed, created_at, updated_at)
     VALUES ('r1', '后端母版', '## 工作经历\n- 做过订单系统', ?, 1, 1)`,
    JSON.stringify({ skills: ['Go'], projects: [] }),
  );
  db.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, jd_parsed, status, created_at, updated_at)
     VALUES ('c1', 'ACME', '后端工程师', 'JD', NULL, 'planning', 1, 1)`,
  );
  insertNode('n-kafka', 'Kafka 副本同步');
  insertNode('n-index', '覆盖索引');
  completeJson.mockReset();
});

describe('diagnoseAttachResume', () => {
  it('绑定简历并按交叉分析结果更新覆盖类型', async () => {
    completeJson.mockResolvedValue({
      updates: [
        { nodeName: 'Kafka 副本同步', coverageType: 'deepDive' },
        { nodeName: '覆盖索引', coverageType: 'landmine' },
      ],
    });

    const message = await diagnoseAttachResume(db, 'c1', 'r1');

    expect(boundResumeId()).toBe('r1');
    expect(coverageOf('n-kafka')).toBe('deepDive');
    expect(coverageOf('n-index')).toBe('landmine');
    expect(message).toContain('2 个考点');
  });

  it('简历已解析过就不再调模型解析，只跑交叉分析', async () => {
    completeJson.mockResolvedValue({ updates: [] });

    await diagnoseAttachResume(db, 'c1', 'r1');

    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(completeJson.mock.calls[0]![1]).toBe('diagnosis.crossAnalyze');
  });

  it('简历没解析过时先解析并把结果存下来', async () => {
    db.runSync(`UPDATE resume SET parsed = NULL WHERE id = 'r1'`);
    completeJson.mockImplementation((_profile: string, promptId: string) => {
      if (promptId === 'diagnosis.resume') {
        return Promise.resolve({ skills: ['Go', 'Kafka'], projects: [] });
      }
      return Promise.resolve({ updates: [] });
    });

    await diagnoseAttachResume(db, 'c1', 'r1');

    const parsed = db.getFirstSync<{ parsed: string | null }>(
      `SELECT parsed FROM resume WHERE id = 'r1'`,
    )!.parsed;
    expect(parsed).not.toBeNull();
    expect(JSON.parse(parsed!).skills).toContain('Kafka');
  });

  /** 模型报了一个图谱里没有的考点名，不该凭空建节点也不该抛错 */
  it('分析结果里认不出的考点名直接跳过', async () => {
    completeJson.mockResolvedValue({
      updates: [
        { nodeName: '并不存在的考点', coverageType: 'deepDive' },
        { nodeName: 'Kafka 副本同步', coverageType: 'extra' },
      ],
    });

    const message = await diagnoseAttachResume(db, 'c1', 'r1');

    expect(coverageOf('n-kafka')).toBe('extra');
    expect(db.getAllSync(`SELECT id FROM knowledge_node`)).toHaveLength(2);
    expect(message).toContain('1 个考点');
  });

  it('还没有考点清单时说清楚要先跑 JD 诊断', async () => {
    db.runSync(`DELETE FROM knowledge_node`);
    completeJson.mockResolvedValue({ updates: [] });

    await expect(diagnoseAttachResume(db, 'c1', 'r1')).rejects.toThrow('请先生成考点清单');
  });

  /** 绑定与分析是两件事，后者失败不该把前者也撤掉 */
  it('交叉分析失败时保留绑定，覆盖类型原样不动', async () => {
    completeJson.mockRejectedValue(new Error('模型不可用'));

    await expect(diagnoseAttachResume(db, 'c1', 'r1')).rejects.toThrow('模型不可用');

    expect(boundResumeId()).toBe('r1');
    expect(coverageOf('n-kafka')).toBe('gap');
  });
});
