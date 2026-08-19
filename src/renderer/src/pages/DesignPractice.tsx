import { useCallback, useEffect, useState } from 'react';
import type {
  CampaignSummary,
  DesignCaseResult,
  DesignSubmitResult,
  MockInterviewType,
} from '@shared/ipc';
import {
  MOCK_INTERVIEW_LANGUAGE_LABELS,
  MOCK_INTERVIEW_LANGUAGE_OPTIONS,
  MOCK_INTERVIEW_TYPE_LABELS,
  MOCK_INTERVIEW_TYPE_OPTIONS,
} from '@shared/ipc';
import type { MockInterviewKind, MockInterviewLanguage } from '@shared/design/prompts';
import { VoiceInputButton } from '../components/VoiceInputButton';
import { PageShell } from '../components/PageShell';
import { invoke } from '../ipc';
import { useDataRefresh } from '../ipc/dataVersion';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

const ANSWER_PLACEHOLDER: Record<MockInterviewKind, Record<MockInterviewLanguage, string>> = {
  concept: {
    zh: '先给结论，再讲原理，最后补充 trade-off 和实际踩坑…',
    en: 'Start with the conclusion, explain the mechanism, then add trade-offs and examples...',
  },
  coding: {
    zh: '说明思路 → 写出核心代码 → 分析时间/空间复杂度 → 边界情况…',
    en: 'Explain your approach, core code or pseudocode, complexity, and edge cases...',
  },
  design: {
    zh: '需求澄清 → 高层架构 → 核心模块 → 扩展与权衡…',
    en: 'Clarify requirements, outline the architecture, key components, scaling, and trade-offs...',
  },
  scenario: {
    zh: '背景 → 你的职责 → 具体行动 → 结果与复盘…',
    en: 'Use STAR: situation, your role, actions, results, and lessons learned...',
  },
  selfIntro: {
    zh: '用 60-90 秒介绍你的背景、核心项目、技术亮点，以及为什么匹配这个岗位…',
    en: 'Give a 60-90 second intro covering your background, key projects, strengths, and role fit...',
  },
};

export function DesignPractice(): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [interviewType, setInterviewType] = useState<MockInterviewType>('mixed');
  const [interviewLanguage, setInterviewLanguage] = useState<MockInterviewLanguage>('zh');
  const [designCase, setDesignCase] = useState<DesignCaseResult | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<DesignSubmitResult | null>(null);

  // 出题与评分按 Campaign + 题型取 key，切页回来还能接上同一次题目
  const caseKey = `design:case:${campaignId}:${interviewType}:${interviewLanguage}`;
  const submitKey = `design:submit:${campaignId}`;
  const caseTask = useTask(caseKey);
  const submitTask = useTask(submitKey);
  const loading = caseTask.running || submitTask.running;
  const error = caseTask.error ?? submitTask.error;

  const refresh = useCallback(() => {
    void invoke('campaign:list', undefined).then((list) => {
      setCampaigns(list);
      setCampaignId((prev) => prev || list[0]?.id || '');
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useDataRefresh(refresh);

  useTaskResult<DesignCaseResult>(caseKey, (c) => {
    setDesignCase(c);
    setResult(null);
    setAnswer('');
  });
  useTaskResult<DesignSubmitResult>(submitKey, setResult);

  const start = (force = false): void => {
    if (!campaignId) return;
    void runTask(caseKey, () =>
      invoke('design:case', { campaignId, interviewType, interviewLanguage, force }),
    ).catch(() => undefined);
  };

  const submit = (): void => {
    if (!designCase || !answer.trim()) return;
    const current = designCase;
    const said = answer.trim();
    void runTask(submitKey, () =>
      invoke('design:submit', {
        campaignId: current.campaignId,
        caseTitle: current.title,
        scenarioMd: current.scenarioMd,
        userAnswer: said,
        interviewType: current.interviewType,
        interviewLanguage: current.interviewLanguage,
      }),
    ).catch(() => undefined);
  };

  const typeHint =
    MOCK_INTERVIEW_TYPE_OPTIONS.find((o) => o.value === interviewType)?.hint ?? '';

  return (
    <PageShell className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">模拟面试</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          结合公司背景、岗位 JD、简历与考点清单出题，覆盖概念、编码、系统设计、项目场景等多类题型
        </p>
      </header>

      <div className="grid gap-3 lg:grid-cols-3">
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
        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">面试语言</span>
          <select
            value={interviewLanguage}
            onChange={(e) => {
              setInterviewLanguage(e.target.value as MockInterviewLanguage);
              setDesignCase(null);
              setResult(null);
            }}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          >
            {MOCK_INTERVIEW_LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <button
          type="button"
          disabled={!campaignId || loading}
          onClick={() => start(Boolean(designCase))}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {caseTask.running ? '出题中…' : designCase ? '重新出题' : '开始模拟'}
        </button>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          已生成的题目会自动保存；再次进入会直接显示保存题，只有点击「重新出题」才会生成新题。
        </p>
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
              <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-300">
                {MOCK_INTERVIEW_LANGUAGE_LABELS[designCase.interviewLanguage]}
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
                  ANSWER_PLACEHOLDER[designCase.interviewType][designCase.interviewLanguage]
                }
                className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <VoiceInputButton currentText={answer} onTextChange={setAnswer} />
                <button
                  type="button"
                  disabled={loading || !answer.trim()}
                  onClick={submit}
                  className="ml-auto rounded bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-40"
                >
                  {submitTask.running ? '评分中…' : '提交回答'}
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
    </PageShell>
  );
}
