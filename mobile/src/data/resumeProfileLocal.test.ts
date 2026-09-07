/**
 * 守「战役 prompt 取数 = 派生版优先（有匹配优化版用优化版正文），否则母版」。
 *
 * 之前 campaign 没绑简历时整个装配层都拿不到履历，推荐答案只能写
 * 「[X] 年经验」占位模板；这里守的是绑定之后两条腿都走对：
 * - 绑定母版 + 该目标岗位有派生自它的优化版 → rawText 用优化版 content_md
 * - 没有匹配派生版 → rawText 用母版 raw_text，skills/projects 始终取自母版 parsed
 */
import { describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { loadCampaignResumeForPrompt } from './resumeProfileLocal';

const MASTER_MD = '## 工作经历\n\n### 甲厂 | 后端 | 2020 ~ 至今\n- 做过订单系统\n';
const MASTER_PARSED = JSON.stringify({
  skills: ['Go', 'Kafka'],
  projects: [{ name: '订单系统', summary: '高并发下单', drillableTopics: ['一致性'] }],
});
const VARIANT_MD = '## 工作经历\n\n### 甲厂 | 资深后端 | 2020 ~ 至今\n- 负责订单中台（针对 JD 的表述改写）\n';

interface VariantRow {
  id: string;
  source_resume_id: string | null;
  content_md: string | null;
  updated_at: number;
  created_at: number;
}

function fakeDb(
  campaign: { resumeId: string | null; jobTargetId: string | null },
  variants: VariantRow[],
): SQLiteDatabase {
  return {
    getFirstSync: (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM resume')) {
        return campaign.resumeId
          ? { parsed: MASTER_PARSED, raw_text: MASTER_MD }
          : null;
      }
      throw new Error(`未预期的 getFirstSync：${sql} ${String(args[0])}`);
    },
    getAllSync: (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM resume_variant')) return variants;
      throw new Error(`未预期的 getAllSync：${sql} ${String(args[0])}`);
    },
  } as unknown as SQLiteDatabase;
}

const campaign = { resumeId: 'r1', jobTargetId: 't1' };

describe('loadCampaignResumeForPrompt', () => {
  it('目标岗位有派生自该母版的优化版：正文用优化版，skills/projects 用母版 parsed', () => {
    const db = fakeDb(campaign, [
      {
        id: 'v1',
        source_resume_id: 'r1',
        content_md: VARIANT_MD,
        updated_at: 200,
        created_at: 100,
      },
    ]);
    const fields = loadCampaignResumeForPrompt(db, campaign);
    expect(fields.rawText).toBe(VARIANT_MD);
    expect(fields.skills).toEqual(['Go', 'Kafka']);
    expect(fields.projects?.[0]?.name).toBe('订单系统');
  });

  it('派生版不属于该母版（source 对不上）不顶替正文', () => {
    const db = fakeDb(campaign, [
      { id: 'v-other', source_resume_id: 'another-master', content_md: VARIANT_MD, updated_at: 999, created_at: 998 },
    ]);
    const fields = loadCampaignResumeForPrompt(db, campaign);
    expect(fields.rawText).toBe(MASTER_MD);
  });

  it('战役没绑简历：返回空正文而不是拿别人的简历', () => {
    const db = fakeDb({ resumeId: null, jobTargetId: 't1' }, [
      { id: 'v1', source_resume_id: 'r1', content_md: VARIANT_MD, updated_at: 200, created_at: 100 },
    ]);
    const fields = loadCampaignResumeForPrompt(db, { resumeId: null, jobTargetId: 't1' });
    expect(fields.rawText).toBe('');
    expect(fields.skills).toEqual([]);
  });

  it('同名最新派生版胜出', () => {
    const db = fakeDb(campaign, [
      { id: 'v-old', source_resume_id: 'r1', content_md: '旧版', updated_at: 100, created_at: 100 },
      { id: 'v-new', source_resume_id: 'r1', content_md: VARIANT_MD, updated_at: 300, created_at: 200 },
    ]);
    expect(loadCampaignResumeForPrompt(db, campaign).rawText).toBe(VARIANT_MD);
  });
});
