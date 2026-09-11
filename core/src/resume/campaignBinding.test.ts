import { describe, expect, it } from 'vitest';
import {
  latestVariantOfTarget,
  pickDefaultResumeId,
  pickVariantForCampaign,
} from './campaignBinding';

const t = (ms: number) => ms;

const variant = (id: string, source: string | null, updatedAt: number) => ({
  id,
  sourceResumeId: source,
  updatedAt,
  createdAt: updatedAt - 1000,
});

const resume = (id: string, updatedAt: number) => ({ id, updatedAt, createdAt: updatedAt - 1000 });

describe('pickDefaultResumeId', () => {
  it('目标岗位有派生版时绑其母版，不退回最新母版', () => {
    const variants = [
      variant('v-new', 'master-new', t(3000)),
      variant('v-old', 'master-old', t(1000)),
    ];
    const resumes = [resume('other-latest', t(99999))];
    expect(pickDefaultResumeId(variants, resumes)).toBe('master-new');
  });

  it('派生版按 updatedAt 取最新，source 已断开的派生版不算数', () => {
    const variants = [variant('v-detached', null, t(99999)), variant('v-ok', 'm', t(2000))];
    expect(pickDefaultResumeId(variants, [])).toBe('m');
  });

  it('没有派生版时退回最新母版', () => {
    const resumes = [resume('a', t(100)), resume('b', t(500))];
    expect(pickDefaultResumeId([], resumes)).toBe('b');
  });

  it('都没有时返回 null', () => {
    expect(pickDefaultResumeId([], [])).toBeNull();
  });
});

describe('pickVariantForCampaign', () => {
  it('只认派生自该绑定母版的派生版，取最新', () => {
    const variants = [
      variant('mine-old', 'm', t(100)),
      variant('other', 'other-master', t(500)),
      variant('mine-new', 'm', t(900)),
    ];
    expect(pickVariantForCampaign(variants, 'm')?.id).toBe('mine-new');
  });

  it('战役没绑简历时不猜派生版', () => {
    expect(pickVariantForCampaign([variant('v', 'm', t(100))], null)).toBeNull();
    expect(pickVariantForCampaign([variant('v', 'm', t(100))], '')).toBeNull();
  });
});

describe('latestVariantOfTarget', () => {
  it('同 updatedAt 时按 createdAt 决出', () => {
    const variants = [
      variant('a', 'm1', t(1000)),
      { ...variant('b', 'm2', t(1000)), createdAt: t(2000) },
    ];
    expect(latestVariantOfTarget(variants)?.id).toBe('b');
  });
});
