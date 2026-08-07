import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { completeJson } from '../llm/json';
import { search } from '../search';
import { getDb, schema } from '../db';
import {
  clearCampaignNodes,
  getCampaignRow,
  getResumeRow,
  insertNodes,
  refreshAllPriorities,
  rowToNode,
  saveJdParsed,
  saveResumeParsed,
  updateCampaign,
} from '../campaign/repository';
import { emit } from '../ipc/bridge';
import {
  crossAnalyzeSystem,
  crossAnalyzeUser,
  EXPAND_SYSTEM,
  type CrossAnalyzeResult,
  type ExpandNodeResult,
  type JdDiagnosisResult,
  JD_SYSTEM,
  RESUME_SYSTEM,
  INTEL_SYSTEM,
} from './prompts';
import { insertEdgesByName } from '../campaign/edges';
import { findDuplicateByName, flattenChildren, flattenGeneratedTree } from './tree';
import { filterDuplicatesByEmbedding } from './embedding';
import { applyHistoricalPrior } from './prior';
import { computePriority } from './priority';
import type { ResumeParsed } from '@shared/entities';

function report(jobId: string, label: string, message: string, progress: number | null): void {
  emit('job:progress', { jobId, label, progress, message, done: false, error: null });
}

function done(jobId: string, label: string, message: string): void {
  emit('job:progress', { jobId, label, progress: 1, message, done: true, error: null });
}

function fail(jobId: string, label: string, message: string): void {
  emit('job:progress', { jobId, label, progress: null, message, done: true, error: message });
}

/** 解析 JD 并生成两层知识点树 */
export async function diagnoseFromJd(campaignId: string, jobId: string): Promise<void> {
  const label = 'JD 诊断';
  try {
    const campaign = getCampaignRow(campaignId);
    if (!campaign.jdRaw.trim()) throw new Error('JD 内容为空');

    report(jobId, label, '正在解析 JD…', 0.1);
    const result = await completeJson<JdDiagnosisResult>(
      'outline',
      JD_SYSTEM,
      `公司：${campaign.company}\n岗位：${campaign.roleTitle}\n\nJD：\n${campaign.jdRaw}`,
    );

    report(jobId, label, '正在生成知识点树…', 0.5);
    clearCampaignNodes(campaignId);
    saveJdParsed(campaignId, result.jdParsed);
    const rows = flattenGeneratedTree(campaignId, result.nodes);
    insertNodes(rows);
    const edgesCreated = insertEdgesByName(campaignId, result.edges ?? []);
    refreshAllPriorities(campaignId);

    const priorBoosted = applyHistoricalPrior(campaignId, campaign.company);
    updateCampaign({ id: campaignId, roleTitle: result.jdParsed.roleTitle || campaign.roleTitle });
    done(
      jobId,
      label,
      `已生成 ${rows.length} 个考点` +
        (edgesCreated > 0 ? `、${edgesCreated} 条关系` : '') +
        (priorBoosted > 0 ? `，${priorBoosted} 个考点已应用历史真题先验` : ''),
    );
  } catch (err) {
    fail(jobId, label, err instanceof Error ? err.message : String(err));
  }
}

/** 附加简历：解析 + 交叉分析更新覆盖类型 */
export async function diagnoseAttachResume(
  campaignId: string,
  resumeId: string,
  jobId: string,
): Promise<void> {
  const label = '简历交叉分析';
  try {
    const campaign = getCampaignRow(campaignId);
    const resume = getResumeRow(resumeId);

    report(jobId, label, '正在解析简历…', 0.15);
    let parsed = resume.parsed;
    if (!parsed) {
      parsed = await completeJson<ResumeParsed>('outline', RESUME_SYSTEM, resume.rawText);
      saveResumeParsed(resumeId, parsed);
    }

    updateCampaign({ id: campaignId, resumeId });

    const db = getDb();
    const nodeRows = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.campaignId, campaignId))
      .all();
    if (nodeRows.length === 0) throw new Error('请先生成考点清单（运行 JD 诊断）');

    const nodeNames = nodeRows.map((n) => n.name);
    report(jobId, label, '正在交叉分析覆盖类型…', 0.5);

    const cross = await completeJson<CrossAnalyzeResult>(
      'outline',
      crossAnalyzeSystem(),
      crossAnalyzeUser(
        campaign.jdParsed ?? { roleTitle: campaign.roleTitle, requirements: [], seniority: null },
        parsed,
        nodeNames,
      ),
    );

    const nameToId = new Map(nodeRows.map((n) => [n.name, n.id]));
    for (const u of cross.updates) {
      const id = nameToId.get(u.nodeName);
      if (!id) continue;
      const row = nodeRows.find((r) => r.id === id)!;
      const node = rowToNode(row);
      const { score } = computePriority({ ...node, coverageType: u.coverageType });
      db.update(schema.knowledgeNode)
        .set({ coverageType: u.coverageType, priorityScore: score })
        .where(eq(schema.knowledgeNode.id, id))
        .run();
    }

    refreshAllPriorities(campaignId);
    done(jobId, label, `已更新 ${cross.updates.length} 个考点的覆盖类型`);
  } catch (err) {
    fail(jobId, label, err instanceof Error ? err.message : String(err));
  }
}

/** 懒加载细化某个 topic/point */
export async function diagnoseExpandNode(nodeId: string, jobId: string): Promise<void> {
  const label = '细化考点';
  try {
    const db = getDb();
    const parent = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.id, nodeId))
      .get();
    if (!parent) throw new Error('节点不存在');

    const campaign = getCampaignRow(parent.campaignId);
    report(jobId, label, `正在细化「${parent.name}」…`, 0.2);

    const result = await completeJson<ExpandNodeResult>(
      'outline',
      EXPAND_SYSTEM,
      `公司：${campaign.company}\n岗位：${campaign.roleTitle}\n主题：${parent.name}\nJD 摘要：${campaign.jdRaw.slice(0, 2000)}`,
    );

    const siblings = db
      .select()
      .from(schema.knowledgeNode)
      .where(eq(schema.knowledgeNode.campaignId, parent.campaignId))
      .all();
    const existingNames = siblings.map((n) => n.name);

    const candidateNames = result.children.map((c) => c.name);
    const embeddingSkipped = await filterDuplicatesByEmbedding(
      parent.campaignId,
      candidateNames,
    );
    const embeddingSkipSet = new Set(embeddingSkipped);

    const filtered = result.children.filter(
      (c) =>
        !findDuplicateByName(existingNames, c.name) && !embeddingSkipSet.has(c.name),
    );

    const rows = flattenChildren(
      parent.campaignId,
      parent.id,
      parent.coverageType,
      filtered,
    );
    insertNodes(rows);
    const keptNames = new Set(filtered.map((c) => c.name));
    const edgesCreated = insertEdgesByName(
      parent.campaignId,
      (result.edges ?? []).filter((e) => keptNames.has(e.from) && keptNames.has(e.to)),
    );
    refreshAllPriorities(parent.campaignId);

    const skipped = result.children.length - filtered.length;
    done(
      jobId,
      label,
      `新增 ${rows.length} 个子考点` +
        (edgesCreated > 0 ? `、${edgesCreated} 条关系` : '') +
        (skipped > 0 ? `（去重跳过 ${skipped} 个）` : ''),
    );
  } catch (err) {
    fail(jobId, label, err instanceof Error ? err.message : String(err));
  }
}

/** 联网检索并生成公司情报卡 */
export async function diagnoseFetchIntel(campaignId: string, jobId: string): Promise<void> {
  const label = '公司情报';
  try {
    const campaign = getCampaignRow(campaignId);
    const query = `${campaign.company} ${campaign.roleTitle} 面试 面经 流程`;
    report(jobId, label, '正在检索面经与公开信息…', 0.2);

    const searchRes = await search({
      query,
      freshness: 'oneYear',
      count: 8,
      cacheCategory: 'companyIntel',
    });

    const context = searchRes.results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${(r.contentMd ?? '').slice(0, 800)}`)
      .join('\n\n---\n\n');

    report(jobId, label, '正在整理情报卡…', 0.6);
    const intel = await completeJson<{
      techStackMd: string;
      interviewProcessMd: string;
      hotTopicsMd: string;
      talkingPointsMd: string;
    }>('outline', INTEL_SYSTEM, `公司：${campaign.company}\n岗位：${campaign.roleTitle}\n\n检索结果：\n${context}`);

    const db = getDb();
    const now = Date.now();
    const existing = db
      .select()
      .from(schema.companyIntel)
      .where(eq(schema.companyIntel.campaignId, campaignId))
      .get();

    if (existing) {
      db.update(schema.companyIntel)
        .set({ ...intel, updatedAt: now })
        .where(eq(schema.companyIntel.id, existing.id))
        .run();
    } else {
      db.insert(schema.companyIntel)
        .values({
          id: randomUUID(),
          campaignId,
          ...intel,
          sourceIds: [],
          updatedAt: now,
        })
        .run();
    }

    done(jobId, label, '公司情报卡已更新');
  } catch (err) {
    fail(jobId, label, err instanceof Error ? err.message : String(err));
  }
}

export { ingestInterviewReport } from './ingest';
export { ingestWebReports } from './webIngest';
