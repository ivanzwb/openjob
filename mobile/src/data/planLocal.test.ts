/**
 * 手机端排程的插件任务必须与桌面逐条相同。
 *
 * 判据和 `src/main/plan/schedule.test.ts` 完全一样：同一份 fixture 输入，
 * 同一份「插件化之前」的旧算法。两端各自落库后可以按 (date, orderIdx) 对齐。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CAMPAIGN_SCOPE_KIND,
  REQUIRES_DESKTOP_REASON,
} from '@core/planner/contributions';
import {
  CROSS_CLIENT_PLAN,
  crossClientLegacyPlan,
  type LegacyPlanDay,
} from '@core/planner/__fixtures__/legacyPlan';
import { MIGRATIONS } from '../db/migrations/bundle';

const ids = vi.hoisted(() => ({ next: 0 }));

vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    ids.next += 1;
    return `uuid-${ids.next}`;
  },
}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('../sync/identity', () => ({
  getDeviceIdentity: () => Promise.resolve({ deviceId: 'dev-1' }),
}));
// writingAs 只负责把写入标成本机来源，直接执行回调即可
vi.mock('../sync/triggers', () => ({
  writingAs: (_db: unknown, _id: string, fn: () => void) => fn(),
}));

const { generatePlan, pluginTaskSupport } = await import('./planLocal');

interface FlatTask {
  date: string;
  kind: string;
  nodeId: string | null;
  repoId: string | null;
  estMinutes: number;
  orderIdx: number;
}

/** 与 apply.fk.test.ts 相同的 node:sqlite 适配层 */
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

function freshDb(): SQLiteDatabase {
  const raw = adapt(new DatabaseSync(':memory:'));
  raw.execSync('PRAGMA foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) raw.execSync(trimmed);
    }
  }
  return raw;
}

const ENABLED_CAPABILITIES = [{ id: 'source-repository', version: '1.0.0', enabled: true }];

function seed(
  raw: SQLiteDatabase,
  capabilities: unknown[] | null,
  options: { legacyScoped?: boolean } = {},
): void {
  raw.runSync(
    `INSERT INTO campaign (id, company, role_title, jd_raw, status, created_at, updated_at)
     VALUES (?, 'ACME', '后端工程师', 'jd', 'planning', 1, 1)`,
    CROSS_CLIENT_PLAN.campaignId,
  );

  for (const node of CROSS_CLIENT_PLAN.nodes) {
    raw.runSync(
      `INSERT INTO knowledge_node (
         id, campaign_id, name, kind, coverage_type, difficulty, est_minutes,
         mastery, priority_score, status, created_at
       ) VALUES (?, ?, ?, 'point', 'deepDive', ?, ?, ?, ?, ?, 0)`,
      node.id,
      CROSS_CLIENT_PLAN.campaignId,
      node.id,
      node.difficulty,
      node.estMinutes,
      node.mastery,
      node.priorityScore,
      node.status,
    );
  }

  for (const repo of CROSS_CLIENT_PLAN.repos) {
    raw.runSync(
      `INSERT INTO repo (id, url, local_path, status) VALUES (?, ?, ?, ?)`,
      repo.id,
      repo.url,
      `/tmp/${repo.id}`,
      repo.status,
    );
  }

  // 插件化迁移那一刻就存在的旧战役才有这个凭据；新建战役没有，因此不走工程岗兜底
  if (options.legacyScoped) {
    raw.runSync(
      `INSERT INTO migration_checkpoint (id, campaign_id, kind, completed_at)
       VALUES (?, ?, ?, 1)`,
      `${LEGACY_CAMPAIGN_SCOPE_KIND}:${CROSS_CLIENT_PLAN.campaignId}`,
      CROSS_CLIENT_PLAN.campaignId,
      LEGACY_CAMPAIGN_SCOPE_KIND,
    );
  }

  if (capabilities) {
    raw.runSync(
      `INSERT INTO campaign_runtime_descriptor (
         id, campaign_id, revision, core_version, role_pack, industry_pack,
         capabilities, competency_baseline_version, config_snapshot_hash, resolved_at
       ) VALUES ('descriptor-1', ?, 1, '1.0.0', ?, NULL, ?, '1.0.0', 'hash', 1)`,
      CROSS_CLIENT_PLAN.campaignId,
      JSON.stringify({ id: 'software-engineering', version: '1.0.0' }),
      JSON.stringify(capabilities),
    );
  }
}

function readTasks(raw: SQLiteDatabase): FlatTask[] {
  return raw
    .getAllSync<{
      date: string;
      kind: string;
      node_id: string | null;
      repo_id: string | null;
      est_minutes: number;
      order_idx: number;
    }>(
      `SELECT d.date AS date, t.kind, t.node_id, t.repo_id, t.est_minutes, t.order_idx
       FROM task t JOIN plan_day d ON d.id = t.plan_day_id
       WHERE d.campaign_id = ?
       ORDER BY d.date, t.order_idx`,
      CROSS_CLIENT_PLAN.campaignId,
    )
    .map((row) => ({
      date: row.date,
      kind: row.kind,
      nodeId: row.node_id,
      repoId: row.repo_id,
      estMinutes: row.est_minutes,
      orderIdx: row.order_idx,
    }));
}

function expectedTasks(days: LegacyPlanDay[]): FlatTask[] {
  return days
    .flatMap((day) => day.tasks.map((task) => ({ date: day.date, ...task })))
    .sort((left, right) => left.date.localeCompare(right.date) || left.orderIdx - right.orderIdx);
}

let raw: SQLiteDatabase;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${CROSS_CLIENT_PLAN.today}T09:00:00`));
  raw = freshDb();
});

describe('手机端 generatePlan', () => {
  it('启用 source-repository 且有已索引仓库时，与插件化之前的排程逐条一致', async () => {
    seed(raw, ENABLED_CAPABILITIES);

    const result = await generatePlan(
      raw,
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    const days = crossClientLegacyPlan();
    expect(result).toEqual({
      daysCreated: days.length,
      tasksCreated: days.reduce((sum, day) => sum + day.tasks.length, 0),
      overflowFallbacks: 0,
    });
    expect(readTasks(raw)).toEqual(expectedTasks(days));
    expect(
      raw.getAllSync<{ date: string; planned_minutes: number }>(
        `SELECT date, planned_minutes FROM plan_day WHERE campaign_id = ? ORDER BY date`,
        CROSS_CLIENT_PLAN.campaignId,
      ),
    ).toEqual(days.map((day) => ({ date: day.date, planned_minutes: day.plannedMinutes })));
    // 桌面用例断言的是同一组日期与 orderIdx，两端因此可以逐条对齐
    expect(readTasks(raw).filter((task) => task.kind === 'readCode')).toEqual([
      {
        date: '2026-03-03',
        kind: 'readCode',
        nodeId: null,
        repoId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 5,
      },
      {
        date: '2026-03-05',
        kind: 'readCode',
        nodeId: null,
        repoId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 5,
      },
      {
        date: '2026-03-07',
        kind: 'readCode',
        nodeId: null,
        repoId: CROSS_CLIENT_PLAN.readyRepoId,
        estMinutes: 25,
        orderIdx: 2,
      },
    ]);
  });

  it('未启用 source-repository 时不生成 readCode，其余任务不受影响', async () => {
    seed(raw, [
      { id: 'source-repository', enabled: false, disabledReason: '用户已关闭源码能力' },
    ]);

    await generatePlan(
      raw,
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(readTasks(raw)).toEqual(
      expectedTasks(crossClientLegacyPlan()).filter((task) => task.kind !== 'readCode'),
    );
  });

  it('旧 Campaign 的 descriptor 还没同步过来时继续按工程岗位包排源码任务', async () => {
    seed(raw, null, { legacyScoped: true });

    await generatePlan(
      raw,
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(readTasks(raw)).toEqual(expectedTasks(crossClientLegacyPlan()));
  });

  /**
   * 与上一条成对，判定与桌面 src/main/plan/schedule.test.ts 的同名用例一致：
   * 两者都没有 descriptor，差别只在有没有旧数据凭据。
   */
  it('还没选岗位的新 Campaign 不排源码任务，其余任务照排', async () => {
    seed(raw, null);

    await generatePlan(
      raw,
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(readTasks(raw)).toEqual(
      expectedTasks(crossClientLegacyPlan()).filter((task) => task.kind !== 'readCode'),
    );
  });
});

describe('pluginTaskSupport', () => {
  it('手机排出的 readCode 标记为需桌面完成，而不是被丢掉', async () => {
    seed(raw, ENABLED_CAPABILITIES);

    await generatePlan(
      raw,
      CROSS_CLIENT_PLAN.campaignId,
      CROSS_CLIENT_PLAN.interviewDate,
      CROSS_CLIENT_PLAN.dailyMinutes,
    );

    expect(readTasks(raw).filter((task) => task.kind === 'readCode')).toHaveLength(3);
    expect(pluginTaskSupport(raw, CROSS_CLIENT_PLAN.campaignId, 'readCode')).toEqual({
      platform: 'mobile',
      availability: 'view-only',
      executable: false,
      blockedReason: REQUIRES_DESKTOP_REASON,
    });
  });

  it('基础任务不归插件所有，不带降级提示', () => {
    seed(raw, ENABLED_CAPABILITIES);

    for (const kind of ['learn', 'drill', 'review', 'fallbackScript'] as const) {
      expect(pluginTaskSupport(raw, CROSS_CLIENT_PLAN.campaignId, kind)).toBeNull();
    }
  });

  it('能力被禁用后不再声称任务可执行', () => {
    seed(raw, [{ id: 'source-repository', enabled: false, disabledReason: '版本不兼容' }]);

    expect(pluginTaskSupport(raw, CROSS_CLIENT_PLAN.campaignId, 'readCode')).toBeNull();
  });
});
