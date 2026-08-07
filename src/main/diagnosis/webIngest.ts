import type { IngestReportResult } from '@shared/ipc';
import { getCampaignRow } from '../campaign/repository';
import { fetchUrl, search } from '../search';
import { ingestInterviewReport } from './ingest';

export async function ingestWebReports(campaignId: string): Promise<{
  reports: IngestReportResult[];
  sourcesFetched: number;
}> {
  const campaign = getCampaignRow(campaignId);
  const query = `${campaign.company} ${campaign.roleTitle} 面试 面经 真题`;
  const searchRes = await search({
    query,
    freshness: 'oneYear',
    count: 6,
    cacheCategory: 'interviewReports',
  });

  const reports: IngestReportResult[] = [];
  let sourcesFetched = 0;

  for (const hit of searchRes.results) {
    let raw = (hit.contentMd ?? hit.snippet).trim();
    if (raw.length < 150 && hit.url) {
      try {
        const page = await fetchUrl({ url: hit.url });
        raw = page.contentMd.trim();
        sourcesFetched++;
      } catch {
        // 单条抓取失败不阻断
      }
    }
    if (raw.length < 80) continue;

    const header = `来源：${hit.title}\nURL：${hit.url}\n\n`;
    const result = await ingestInterviewReport(campaignId, header + raw, 'web');
    reports.push(result);
  }

  return { reports, sourcesFetched };
}
