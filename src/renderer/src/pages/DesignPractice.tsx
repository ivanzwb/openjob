import { useCallback, useEffect, useState } from 'react';
import type { CampaignSummary, DesignCaseResult, DesignSubmitResult } from '@shared/ipc';
import { VoiceInputButton } from '../components/VoiceInputButton';
import { invoke } from '../ipc';

export function DesignPractice(): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [designCase, setDesignCase] = useState<DesignCaseResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<DesignSubmitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke('campaign:list', undefined).then((list) => {
      setCampaigns(list);
      setCampaignId((prev) => prev || list[0]?.id || '');
    });
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setAnswer('');
    try {
      const c = await invoke('design:case', { campaignId });
      setDesignCase(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  const submit = async (): Promise<void> => {
    if (!designCase || !answer.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke('design:submit', {
        campaignId: designCase.campaignId,
        caseTitle: designCase.title,
        scenarioMd: designCase.scenarioMd,
        userAnswer: answer.trim(),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold">系统设计练习</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          基于 Campaign 背景生成案例式题目，口述架构方案后获得评分与改进大纲
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-xs text-[var(--color-muted)]">关联 Campaign</span>
          <select
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setDesignCase(null);
              setResult(null);
            }}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          >
            {campaigns.length === 0 ? (
              <option value="">请先创建 Campaign</option>
            ) : (
              campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company} · {c.roleTitle}
                </option>
              ))
            )}
          </select>
        </label>
        <button
          type="button"
          disabled={!campaignId || loading}
          onClick={() => void start()}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm disabled:opacity-40"
        >
          {loading && !designCase ? '出题中…' : designCase ? '换一题' : '开始出题'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {designCase && (
        <section className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div>
            <h3 className="font-medium">{designCase.title}</h3>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {designCase.company} · {designCase.roleTitle}
            </p>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{designCase.scenarioMd}</div>
          {designCase.constraints.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-[var(--color-muted)]">约束</h4>
              <ul className="mt-1 list-inside list-disc text-sm">
                {designCase.constraints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {designCase.evaluationCriteria.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-[var(--color-muted)]">评分维度</h4>
              <ul className="mt-1 list-inside list-disc text-sm text-[var(--color-muted)]">
                {designCase.evaluationCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {!result && (
            <>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={10}
                placeholder="按需求澄清 → 高层架构 → 核心模块 → 扩展与权衡 的结构回答…"
                className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <VoiceInputButton currentText={answer} onTextChange={setAnswer} />
                <button
                  type="button"
                  disabled={loading || !answer.trim()}
                  onClick={() => void submit()}
                  className="ml-auto rounded bg-emerald-700 px-4 py-2 text-sm disabled:opacity-40"
                >
                  {loading ? '评分中…' : '提交方案'}
                </button>
              </div>
            </>
          )}

          {result && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-2xl font-semibold text-[var(--color-accent)]">
                  {result.score}/5
                </span>
                <span className="text-xs text-emerald-400">改进大纲已存入话术库</span>
              </div>
              <div>
                <h4 className="text-xs text-[var(--color-muted)]">反馈</h4>
                <p className="mt-1 whitespace-pre-wrap">{result.feedbackMd}</p>
              </div>
              <div>
                <h4 className="text-xs text-[var(--color-muted)]">改进大纲</h4>
                <p className="mt-1 whitespace-pre-wrap text-emerald-300">
                  {result.improvedOutlineMd}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setAnswer('');
                }}
                className="text-xs text-sky-400 hover:underline"
              >
                重新作答
              </button>
            </div>
          )}
        </section>
      )}

      {!designCase && !loading && campaigns.length > 0 && (
        <p className="text-sm text-[var(--color-muted)]">选择 Campaign 后点击「开始出题」</p>
      )}
    </div>
  );
}
