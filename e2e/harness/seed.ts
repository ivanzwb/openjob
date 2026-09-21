/**
 * 用例前置数据：走应用自己的 IPC 建岗位 / 简历 / 备考 / 岗位画像。
 *
 * 不走界面点击也不直接写库：前者慢且脆，后者绕过了被测代码。IPC 是渲染层与应用之间
 * 真正的契约，用建前置换来的是「用例测的那条路」与用户走的是同一条。
 */
import type { AppInstance } from './app';

export interface SeededCampaign {
  resumeId: string;
  jobTargetId: string;
  campaignId: string;
}

const RESUME_TEXT = [
  '姓名：赵伟炳',
  '城市：杭州',
  '工作年限：17 年',
  '',
  '工作经历：',
  '诺基亚 · 软件架构师 · 2010-2025',
  '主导 Web 基站网元管理系统从 C/S 到 B/S 的架构演进；抽象统一后端接口，模块复用率 70%；',
  '系统性能提升 50%，故障率下降 90%；组建并带领 12 人技术团队，建立架构评审机制。',
  '',
  '技能：Java、TypeScript、Node.js、分布式系统、系统设计',
].join('\n');

const JD_TEXT = [
  '岗位职责：',
  '1. 负责后端服务的架构设计与性能优化；',
  '2. 主导核心系统的技术选型与演进。',
  '任职要求：',
  '1. 扎实的 Java / 分布式系统基础，熟悉 JVM 内存模型与并发；',
  '2. 有大型系统的架构设计经验。',
].join('\n');

export async function seedCampaign(
  app: AppInstance,
  options: { company?: string; roleTitle?: string } = {},
): Promise<SeededCampaign> {
  const resume = await app.page.invoke<{ id: string }>('resume:create', {
    label: 'E2E 母版简历',
    rawText: RESUME_TEXT,
  });
  const target = await app.page.invoke<{ id: string }>('jobTarget:create', {
    company: options.company ?? 'E2E 公司',
    roleTitle: options.roleTitle ?? '资深后端开发工程师',
    jdRaw: JD_TEXT,
  });
  const campaign = await app.page.invoke<{ id: string }>('campaign:create', {
    jobTargetId: target.id,
    resumeId: resume.id,
  });
  if (!campaign?.id) throw new Error('建备考失败：没有拿到 id');
  return { resumeId: resume.id, jobTargetId: target.id, campaignId: campaign.id };
}

/** 给备考钉上岗位画像，练习链路才有 descriptor 可用 */
export async function setRoleProfile(
  app: AppInstance,
  campaignId: string,
  options: {
    rolePackId?: string;
    roleFamily?: string;
    level?: string;
    interviewLanguage?: string;
  } = {},
): Promise<void> {
  await app.page.invoke('campaign:setRoleProfile', {
    campaignId,
    roleFamily: options.roleFamily ?? 'software',
    rolePackId: options.rolePackId ?? 'software-engineering',
    level: options.level ?? '中级',
    interviewLanguage: options.interviewLanguage ?? 'zh',
  });
}

/** 常见前置：简历 + 岗位 + 备考 + 画像 */
export async function seedReadyCampaign(
  app: AppInstance,
  options: Parameters<typeof seedCampaign>[1] & Parameters<typeof setRoleProfile>[2] = {},
): Promise<SeededCampaign> {
  const seeded = await seedCampaign(app, options);
  await setRoleProfile(app, seeded.campaignId, options);
  return seeded;
}

export { RESUME_TEXT, JD_TEXT };
