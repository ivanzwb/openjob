import { describe, expect, it } from 'vitest';
import {
  PRESYNC_BACKUP_MIN_INTERVAL_MS,
  selectStaleBackups,
  shouldCreatePresyncBackup,
  type BackupInfo,
  type BackupRetention,
} from './sync';

function backup(reason: string, createdAt: number, sizeBytes = 1024): BackupInfo {
  return { file: `openjob-${createdAt}-${reason}.db`, sizeBytes, createdAt, reason };
}

const MB = 1024 * 1024;

/** 本地时间的某天某时，dayKey 按本地日期分桶，用 Date 构造避免时区偏移 */
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 0, day, hour, minute).getTime();
}

/** 份数规则的用例不测体积，给一个够大的上限让它不参与判定 */
const MOBILE: BackupRetention = {
  recentPresync: 3,
  presyncDays: 5,
  other: 2,
  maxTotalBytes: 1024 * MB,
};

describe('selectStaleBackups', () => {
  it('同步前快照超出上限时删最旧的', () => {
    const all = [1, 2, 3, 4, 5].map((n) => backup('presync', n));

    const stale = selectStaleBackups(all, MOBILE);

    expect(stale.map((b) => b.createdAt)).toEqual([2, 1]);
  });

  it('频繁的同步前快照挤不掉升级前那一份', () => {
    // 这条是「升级不应该导致数据丢失」的核心：手机端每 60 秒可能同步一次，
    // 若按全局「留最近 3 份」，升级后几分钟内升级前的现场就被冲掉了。
    const all = [
      backup('premigrate', 100),
      ...[201, 202, 203, 204, 205].map((n) => backup('presync', n)),
    ];

    const stale = selectStaleBackups(all, MOBILE);

    expect(stale.some((b) => b.reason === 'premigrate')).toBe(false);
    expect(stale.map((b) => b.createdAt)).toEqual([202, 201]);
  });

  it('每一类各自限量，互不占用额度', () => {
    const all = [
      ...[1, 2, 3].map((n) => backup('premigrate', n)),
      ...[4, 5, 6].map((n) => backup('manual', n)),
    ];

    const stale = selectStaleBackups(all, MOBILE);

    // 每类留 2 份，各删掉自己最旧的那一份
    expect(stale.map((b) => b.file).sort()).toEqual([
      'openjob-1-premigrate.db',
      'openjob-4-manual.db',
    ]);
  });

  it('顺序错乱的输入也按时间判断，不依赖调用方先排序', () => {
    const all = [backup('presync', 3), backup('presync', 1), backup('presync', 5), backup('presync', 2)];

    const stale = selectStaleBackups(all, { ...MOBILE, recentPresync: 1, presyncDays: 1, other: 1 });

    expect(stale.map((b) => b.createdAt)).toEqual([3, 2, 1]);
  });

  it('没到上限时一个都不删', () => {
    const all = [backup('presync', 1), backup('premigrate', 2)];

    expect(selectStaleBackups(all, MOBILE)).toEqual([]);
  });

  it('今天的密集同步冲不掉前几天的现场', () => {
    // 只按份数留会让可恢复范围被同步频率决定：一天同步几十次，
    // 昨天以前的快照全没了，而数据不对往往是隔天才发现的。
    const retention: BackupRetention = { ...MOBILE, recentPresync: 2, presyncDays: 3, other: 2 };
    const all = [
      backup('presync', at(10, 9, 3)),
      backup('presync', at(10, 9, 2)),
      backup('presync', at(10, 9, 1)),
      backup('presync', at(10, 9, 0)),
      backup('presync', at(9, 20)),
      backup('presync', at(8, 20)),
      backup('presync', at(5, 20)),
    ];

    const stale = selectStaleBackups(all, retention);

    // 今天保留最近两份，同一天更早的收敛成 0 份（当天已有代表）
    expect(stale.map((b) => b.createdAt)).toEqual([at(10, 9, 1), at(10, 9, 0), at(5, 20)]);
    // 前两天各自的那一份必须活着
    expect(stale.some((b) => b.createdAt === at(9, 20))).toBe(false);
    expect(stale.some((b) => b.createdAt === at(8, 20))).toBe(false);
  });

  it('份数没超但体积超了，也要从旧到新删到降下来', () => {
    // 份数上限管不住磁盘：一份快照就是一整个库，库里带着 repo_file 源码快照
    const retention: BackupRetention = { ...MOBILE, maxTotalBytes: 700 * MB };
    const all = [
      backup('presync', at(10, 9), 300 * MB),
      backup('presync', at(9, 9), 300 * MB),
      backup('presync', at(8, 9), 300 * MB),
    ];

    const stale = selectStaleBackups(all, retention);

    // 三份都在份数额度内，但 900MB 超了 700MB，删掉最旧的一份刚好降到 600MB
    expect(stale.map((b) => b.createdAt)).toEqual([at(8, 9)]);
  });

  it('体积超标也不会删掉每一类最新的那一份', () => {
    // 最新的同步前 = 撤销刚才那次同步，最新的升级前 = 回到升级之前，
    // 删掉就等于这条退路没了。库大到几份就超标时，退路优先于上限。
    const retention: BackupRetention = { ...MOBILE, maxTotalBytes: 10 * MB };
    const all = [
      backup('presync', at(10, 9), 300 * MB),
      backup('presync', at(9, 9), 300 * MB),
      backup('premigrate', at(1, 9), 300 * MB),
    ];

    const stale = selectStaleBackups(all, retention);

    expect(stale.map((b) => b.createdAt)).toEqual([at(9, 9)]);
    expect(stale.some((b) => b.reason === 'premigrate')).toBe(false);
  });

  it('上限设为 0 表示不按体积限制', () => {
    const retention: BackupRetention = { ...MOBILE, maxTotalBytes: 0 };
    const all = [backup('presync', at(10, 9), 900 * MB), backup('presync', at(9, 9), 900 * MB)];

    expect(selectStaleBackups(all, retention)).toEqual([]);
  });
});

describe('shouldCreatePresyncBackup', () => {
  it('没有任何同步前快照时必须建', () => {
    expect(shouldCreatePresyncBackup(null, at(10, 9))).toBe(true);
  });

  it('间隔内复用上一份，不重复建', () => {
    const last = at(10, 9);
    expect(shouldCreatePresyncBackup(last, last + PRESYNC_BACKUP_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  it('超过间隔就建新的', () => {
    const last = at(10, 9);
    expect(shouldCreatePresyncBackup(last, last + PRESYNC_BACKUP_MIN_INTERVAL_MS)).toBe(true);
  });

  it('每分钟一轮的同步在一小时里只留 4 份，而不是 60 份', () => {
    const start = at(10, 9);
    let last: number | null = null;
    let created = 0;
    for (let minute = 0; minute < 60; minute++) {
      const now = start + minute * 60 * 1000;
      if (shouldCreatePresyncBackup(last, now)) {
        created++;
        last = now;
      }
    }
    expect(created).toBe(4);
  });
});
