import { useCallback, useEffect, useState } from 'react';
import type {
  CampaignSummary,
  DesignCaseResult,
  DesignSubmitResult,
  MockInterviewType,
} from '@shared/ipc';
import {
  MOCK_INTERVIEW_TYPE_LABELS,
  MOCK_INTERVIEW_TYPE_OPTIONS,
} from '@shared/ipc';
import { VoiceInputButton } from '../components/VoiceInputButton';
import { invoke } from '../ipc';

const ANSWER_PLACEHOLDER: Record<string, string> = {
  concept: '先给结论，再讲原理，最后补充 trade-off 和实际踩坑…',
  coding: '说明思路 → 写出核心代码 → 分析时间/空间复杂度 → 边界情况…',
  design: '需求澄清 → 高层架构 → 核心模块 → 扩展与权衡…',
  scenario: '背景 → 你的职责 → 具体行动 → 结果与复盘…',
};

export function DesignPractice(): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [interviewType, setInterviewType] = useState<MockInterviewType>('mixed');
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
      const c = await invoke('design:case', { campaignId, interviewType });
      setDesignCase(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [campaignId, interviewType]);

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
        interviewType: designCase.interviewType,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const typeHint =
    MOCK_INTERVIEW_TYPE_OPTIONS.find((o) => o.value === interviewType)?.hint ?? '';

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold">模拟面试</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          结合公司背景、岗位 JD、简历与考点清单出题，覆盖概念、编码、系统设计、项目场景等多类题型
        </p>
      </header>

      <div className="grid gap-3 lg:grid-cols-2">
        <label className="space-y-1">
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
        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">题型</span>
          <select
            value={interviewType}
            onChange={(e) => {
              setInterviewType(e.target.value as MockInterviewType);
              setDesignCase(null);
              setResult(null);
            }}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          >
            {MOCK_INTERVIEW_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {typeHint && <p className="text-[10px] text-[var(--color-muted)]">{typeHint}</p>}
        </label>
      </div>

      <div>
        <button
          type="button"
          disabled={!campaignId || loading}
          onClick={() => void start()}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm disabled:opacity-40"
        >
          {loading && !designCase ? '出题中…' : designCase ? '换一题' : '开始模拟'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {designCase && (
        <section className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{designCase.title}</h3>
              <span className="rounded bg-sky-900/40 px-2 py-0.5 text-[10px] text-sky-300">
                {MOCK_INTERVIEW_TYPE_LABELS[designCase.interviewType]}
              </span>
              {designCase.relatedNodeName && (
                <span className="text-[10px] text-[var(--color-muted)]">
                  关联考点：{designCase.relatedNodeName}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {designCase.company} · {designCase.roleTitle}
            </p>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{designCase.scenarioMd}</div>
          {designCase.constraints.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-[var(--color-muted)]">约束 / 考察点</h4>
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
                placeholder={
                  ANSWER_PLACEHOLDER[designCase.interviewType] ??
                  '口述你的回答，尽量结构化…'
                }
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
                  {loading ? '评分中…' : '提交回答'}
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
                <span className="text-xs text-emerald-400">改进稿已存入话术库</span>
              </div>
              <div>
                <h4 className="text-xs text-[var(--color-muted)]">反馈</h4>
                <p className="mt-1 whitespace-pre-wrap">{result.feedbackMd}</p>
              </div>
              <div>
                <h4 className="text-xs text-[var(--color-muted)]">改进稿</h4>
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
        <p className="text-sm text-[var(--color-muted)]">
          选择 Campaign 和题型后点击「开始模拟」。建议在备考中完成 JD 诊断、关联简历并生成公司情报，题目会更贴近真实面试。
        </p>
      )}
    </div>
  );
}
