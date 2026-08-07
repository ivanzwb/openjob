import { desc, eq, sql } from 'drizzle-orm';
import type { InterviewReportView } from '@shared/ipc';
import { getDb, schema } from '../db';

/**
 * 面经列表带出处。
 *
 * 网络来源的每条结论都要能回到「哪个链接、什么时候抓的、这个域名几分」，
 * 否则考察频率的事实锚定就只是个说法。
 */
export function listReports(campaignId: string): InterviewReportView[] {
  const db = getDb();

  const rows = db
    .select({
      report: schema.interviewReport,
      source: schema.source,
    })
    .from(schema.interviewReport)
    .leftJoin(schema.source, eq(schema.interviewReport.sourceId, schema.source.id))
    .where(eq(schema.interviewReport.campaignId, campaignId))
    .orderBy(desc(schema.interviewReport.createdAt))
    .all();

  if (rows.length === 0) return [];

  const counts = db
    .select({
      reportId: schema.interviewQuestion.reportId,
      total: sql<number>`count(*)`,
      blindSpots: sql<number>`sum(case when ${schema.interviewQuestion.isBlindSpot} then 1 else 0 end)`,
    })
    .from(schema.interviewQuestion)
    .groupBy(schema.interviewQuestion.reportId)
    .all();

  const countByReport = new Map(counts.map((c) => [c.reportId, c]));

  return rows.map(({ report, source }) => {
    const count = countByReport.get(report.id);
    return {
      id: report.id,
      sourceType: report.sourceType,
      reportedAt: report.reportedAt,
      createdAt: report.createdAt,
      credibilityWeight: report.credibilityWeight,
      excerpt: report.rawText.slice(0, 160).replace(/\s+/g, ' ').trim(),
      questionCount: count?.total ?? 0,
      blindSpotCount: count?.blindSpots ?? 0,
      source: source
        ? {
            url: source.url,
            domain: source.domain,
            title: source.title,
            credibility: source.credibility,
            fetchedAt: source.fetchedAt,
            publishedAt: source.publishedAt,
          }
        : null,
    };
  });
}
