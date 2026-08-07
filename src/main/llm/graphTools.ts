import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { rowToNode } from '../campaign/repository';
import { computePriority } from '../diagnosis/priority';
import type { ToolOutcome } from './tools';

const COVERAGE_LABEL: Record<string, string> = {
  deepDive: '必深挖',
  gap: '短板',
  landmine: '雷区',
  extra: '加分项',
};

/** query_graph / update_mastery 的执行体，两者都需要 Campaign 上下文 */
export function runGraphTool(
  name: string,
  args: Record<string, unknown>,
  campaignId: string | null,
): ToolOutcome {
  if (!campaignId) {
    return {
      content: '当前对话没有绑定备考战役，无法查询知识点树。',
      summary: `${name} 缺少 campaign 上下文`,
      citations: [],
    };
  }

  const db = getDb();
  const rows = db
    .select()
    .from(schema.knowledgeNode)
    .where(eq(schema.knowledgeNode.campaignId, campaignId))
    .all();

  if (name === 'query_graph') {
    const keyword = String(args['keyword'] ?? '').trim().toLowerCase();
    const limit = typeof args['limit'] === 'number' ? Math.min(50, args['limit']) : 15;

    const filtered = (keyword
      ? rows.filter((r) => r.name.toLowerCase().includes(keyword))
      : rows.filter((r) => r.kind !== 'domain')
    )
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, limit);

    if (filtered.length === 0) {
      return { content: '没有匹配的考点。', summary: 'query_graph 无结果', citations: [] };
    }

    const lines = filtered.map(
      (r) =>
        `- ${r.name}（${COVERAGE_LABEL[r.coverageType] ?? r.coverageType}）` +
        ` 考察概率 ${Math.round(r.examProb * 100)}%` +
        ` 掌握 ${r.mastery.toFixed(1)}/5` +
        ` 状态 ${r.status}` +
        ` 预估 ${r.estMinutes} 分钟`,
    );

    return {
      content: lines.join('\n'),
      summary: `query_graph 返回 ${filtered.length} 个考点`,
      citations: [],
    };
  }

  const nodeName = String(args['node_name'] ?? '').trim().toLowerCase();
  const target = rows.find((r) => r.name.trim().toLowerCase() === nodeName);
  if (!target) {
    return {
      content: `找不到考点「${args['node_name']}」，请先用 query_graph 确认名称。`,
      summary: 'update_mastery 未命中考点',
      citations: [],
    };
  }

  const raw = Number(args['mastery']);
  if (!Number.isFinite(raw)) {
    return {
      content: 'mastery 必须是 0-5 的数字。',
      summary: 'update_mastery 参数非法',
      citations: [],
    };
  }
  const mastery = Math.min(5, Math.max(0, raw));

  // 来自对话的自评比答题得分弱，标 mixed 而非 quiz，避免污染客观分
  const node = rowToNode({ ...target, mastery });
  const { score } = computePriority(node);
  db.update(schema.knowledgeNode)
    .set({ mastery, masterySource: 'mixed', priorityScore: score })
    .where(eq(schema.knowledgeNode.id, target.id))
    .run();

  return {
    content: `已把「${target.name}」的掌握度更新为 ${mastery}/5。`,
    summary: `update_mastery ${target.name} → ${mastery}`,
    citations: [],
  };
}
