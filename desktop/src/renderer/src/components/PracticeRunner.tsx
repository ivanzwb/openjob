import { useCallback, useEffect, useState } from 'react';
import { type CampaignRuntimeView } from '@core/ipc';
import type { ExamFormDefinition } from '@core/plugins/types';
import type { PracticeDimensionScore, PracticeEvaluation, PracticeSession } from '@core/practice';
import {
  derivePracticeView,
  sliceAnswerCitation,
  sortScoresByWeight,
  summarizeEvaluation,
} from '@core/hostUi';
import { normalizeDisplayText } from '@core/lib/markdownDisplay';
import {
  DEFAULT_INTERVIEW_LANGUAGE,
  INTERVIEW_LANGUAGE_CHOICES,
  examFormTakesLanguage,
  normalizeInterviewLanguage,
  practiceExamForms,
} from '@core/practice';
import { MarkdownContent } from './MarkdownContent';
import { VoiceInputButton } from './VoiceInputButton';
import { invoke, onEvent } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

/**
 * 一个维度分的完整依据。
 *
 * 分数、量规锚点、回答原文三样必须同时在场。只给「结构化 3 分」，用户没有任何办法判断
 * 这个 3 分是不是随口给的；把锚点原文和被引用的那句话摆在一起，他至少能反驳。
 *
 * 引文按 start/end 从自己的作答里切出来显示，而不是照抄模型返回的 quote：两者不一致时
 * 用户该看到的是自己真的写过的字，同时这条分数要被标成依据存疑。
 */
function DimensionScoreCard({
  score,
  answerMd,
}: {
  score: PracticeDimensionScore;
  answerMd: string;
}): React.JSX.Element {
  const citation = sliceAnswerCitation(answerMd, score.answer);

  return (
    <li className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold text-[var(--color-accent)]">{score.score}</span>
        <span className="text-sm">{score.label}</span>
        <span className="text-[10px] text-[var(--color-muted)]">权重 {score.weight}</span>
        {score.critical && (
          <span className="rounded bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300">
            关键维度
          </span>
        )}
      </div>

      <p className="mt-1.5 text-[10px] text-[var(--color-muted)]">
        量规锚点（{score.anchor.score} 分）：{score.anchor.text}
      </p>

      <div className="mt-1.5 border-l-2 border-[var(--color-border)] pl-2 text-xs">
        {citation.exact ? (
          <p>
            <span className="text-[var(--color-muted)]">{citation.before}</span>
            <mark className="bg-amber-500/25 text-[var(--color-fg)]">{citation.quote}</mark>
            <span className="text-[var(--color-muted)]">{citation.after}</span>
          </p>
        ) : (
          <p className="text-red-400">
            这条分数引用的片段在你的作答里对不上（模型给的是「{score.answer.quote}」），
            依据存疑，请谨慎采信。
          </p>
        )}
      </div>

      {score.rationaleMd && (
        <div className="mt-1.5 text-xs">
          <MarkdownContent text={normalizeDisplayText(score.rationaleMd)} />
        </div>
      )}
    </li>
  );
}

/**
 * 通用练习入口。
 *
 * 题型下拉直接来自岗位包声明（RolePack.examForms）的 id + label，界面不认识任何一个
 * 取值——把 `se.system-design` 之类的 ID 抄进来能跑通，但换一个岗位包就是静默失效：
 * createSession 报 unknown-format，而错在界面里的一个字符串。包没装/没声明题型时下拉
 * 为空，出题按钮随之禁用。
 *
 * 会话 ID 落 localStorage：出题、追问、评分都是分钟级的模型调用，中途切页面回来时
 * 让用户重新出题等于把刚才那几分钟连同作答一起丢掉。
 */
export function PracticeRunner({
  campaignId,
  leading,
}: {
  campaignId: string;
  /** 工具行最前面的一项（页面级的「关联备考」这类选择）；不传时这一行只有练习自己的那几项 */
  leading?: React.ReactNode;
}): React.JSX.Element {
  const [examForms, setExamForms] = useState<ExamFormDefinition[]>([]);
  const [examFormChoice, setExamFormChoice] = useState('');
  // 已选语言；空串表示「还没选过」，落到岗位意图里的面试语言
  const [languageChoice, setLanguageChoice] = useState('');
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [answer, setAnswer] = useState('');
  const [evaluation, setEvaluation] = useState<PracticeEvaluation | null>(null);
  const [scoredAnswer, setScoredAnswer] = useState('');
  // 连同它属于哪场备考一起存：换 Campaign 时上一场的结论自动作废，不必先同步清一次
  const [runtimeState, setRuntimeState] = useState<{
    campaignId: string;
    view: CampaignRuntimeView | null;
  } | null>(null);
  // 装 / 卸岗位包会改变题型声明：主进程广播一次，这里就地重取。首次挂载时包可能还没
  // 装载完，只取一次的话下拉会一直是空的，直到用户换一场备考才恢复。
  const [inventoryVersion, setInventoryVersion] = useState(0);
  useEffect(() => onEvent('plugin:inventory-changed', () => setInventoryVersion((n) => n + 1)), []);

  // 选中的题型必须落在包的声明里：包还没加载、或选择已不在声明里时，退回第一个声明的
  // 题型（包没声明题型时为空串，出题按钮随之禁用）。派生而不是用 effect 写回 state。
  const examForm = examForms.some((form) => form.id === examFormChoice)
    ? examFormChoice
    : (examForms[0]?.id ?? '');

  const storageKey = `openjob:practice:${campaignId}:${examForm}`;
  const languageKey = `openjob:practice:language:${campaignId}:${examForm}`;
  const [scope, setScope] = useState(storageKey);
  const createKey = `practice:create:${campaignId}:${examForm}`;
  const sessionId = session?.id ?? 'none';
  const turnKey = `practice:turn:${sessionId}`;
  const evaluateKey = `practice:evaluate:${sessionId}`;

  const createTask = useTask(createKey);
  const turnTask = useTask(turnKey);
  const evaluateTask = useTask(evaluateKey);
  const error = createTask.error ?? turnTask.error ?? evaluateTask.error;

  const reload = useCallback((id: string) => {
    void invoke('practice:getSession', { sessionId: id }).then((next) => {
      if (next) setSession(next);
    });
  }, []);

  // 出题、追问、评分都要按 descriptor 里的岗位包展开；没有它这条链路根本起不来，
  // 与其让用户点下去再吃一个 role-pack-unavailable，不如先说清楚该去哪儿装岗位包
  useEffect(() => {
    let cancelled = false;
    void invoke('campaign:getRuntimeDescriptor', { campaignId })
      .then(async (view) => {
        if (cancelled) return;
        setRuntimeState({ campaignId, view });
        // 基线题型（自我介绍）不依赖岗位包，先摆上；包声明的题型取回来再合并
        setExamForms(practiceExamForms(null));
        const ref = view?.descriptor.rolePack;
        if (!ref) return;
        // 题型声明随岗位包分发：按 descriptor pin 的精确版本取一份，界面只当不透明声明用
        const pack = await invoke('plugin:getRolePack', { id: ref.id, version: ref.version });
        if (cancelled || !pack) return;
        setExamForms(practiceExamForms(pack));
      })
      .catch(() => {
        if (!cancelled) setRuntimeState({ campaignId, view: null });
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, inventoryVersion]);

  const loadedRuntime = runtimeState?.campaignId === campaignId ? runtimeState : null;
  const runtimeLoaded = loadedRuntime !== null;
  const runtime = loadedRuntime?.view ?? null;

  // 换 Campaign 或题型时把上一场清干净。渲染期比对而不是放进 effect：effect 里同步
  // setState 会先渲染一帧旧题目再被清掉，用户能看见那一闪
  if (scope !== storageKey) {
    setScope(storageKey);
    setSession(null);
    setAnswer('');
    setEvaluation(null);
    setScoredAnswer('');
    // 面试语言按 (备考, 题型) 记：换一场备考不该继承上一场的语言选择
    setLanguageChoice(window.localStorage.getItem(languageKey) ?? '');
  }

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return;
    void invoke('practice:getSession', { sessionId: stored })
      .then((next) => {
        if (next) setSession(next);
        else window.localStorage.removeItem(storageKey);
      })
      .catch(() => undefined);
  }, [storageKey]);

  useTaskResult<PracticeSession>(createKey, (next) => {
    window.localStorage.setItem(storageKey, next.id);
    setSession(next);
    setAnswer('');
    setEvaluation(null);
    setScoredAnswer('');
  });

  useTaskResult<{ sessionId: string }>(turnKey, (turn) => reload(turn.sessionId));

  useTaskResult<PracticeEvaluation>(evaluateKey, (next) => {
    setEvaluation(next);
    reload(next.sessionId);
  });

  const view = derivePracticeView(session);

  const start = (): void => {
    if (!examForm) return;
    void runTask(createKey, () =>
      invoke('practice:createSession', { campaignId, examForm, language }),
    ).catch(() => undefined);
  };

  const followUp = (): void => {
    if (!session || !answer.trim()) return;
    void runTask(turnKey, () =>
      invoke('practice:nextTurn', { sessionId: session.id, answerMd: answer.trim(), language }),
    ).catch(() => undefined);
  };

  const evaluate = (): void => {
    if (!session || !answer.trim()) return;
    const submitted = answer.trim();
    setScoredAnswer(submitted);
    void runTask(evaluateKey, () =>
      invoke('practice:evaluate', { sessionId: session.id, answerMd: submitted, language }),
    ).catch(() => undefined);
  };

  // 面试语言：默认取岗位意图里的面试语言（岗位面板里设的那条），用户在这里改过就以
  // (备考, 题型) 为准。会话不记语言，出题 / 追问 / 评分每次都带上当前值。
  const language = normalizeInterviewLanguage(
    languageChoice || runtime?.roleProfile?.interviewLanguage || DEFAULT_INTERVIEW_LANGUAGE,
  );
  const setLanguage = (value: string): void => {
    setLanguageChoice(value);
    window.localStorage.setItem(languageKey, value);
  };

  const latestAnswerTurn = view?.turns.filter((turn) => turn.speaker === 'candidate').at(-1);
  // 切页面回来时 scoredAnswer 已经没了，退回会话里最后一次作答，引文照样能切
  const citationSource = scoredAnswer || latestAnswerTurn?.contentMd || '';
  const summary = evaluation ? summarizeEvaluation(evaluation, citationSource) : null;
  const busy = createTask.running || turnTask.running || evaluateTask.running;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        {leading}
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-[var(--color-muted)]">题型</span>
          <select
            value={examForm}
            onChange={(e) => setExamFormChoice(e.target.value)}
            disabled={examForms.length === 0}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          >
            {examForms.map((form) => (
              <option key={form.id} value={form.id}>
                {form.label}
              </option>
            ))}
          </select>
        </label>
        {/* 面试语言：0.6.x 只给自我介绍（别的题型按包的中文正文走），所以跟着题型出现 */}
        {examFormTakesLanguage(examForm) && (
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <span className="text-xs text-[var(--color-muted)]">面试语言</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            >
              {INTERVIEW_LANGUAGE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          disabled={!campaignId || !examForm || busy || !runtime}
          onClick={start}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {createTask.running ? '出题中…' : session ? '换一题' : '开始练习'}
        </button>
      </div>

      {runtimeLoaded && !runtime && (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
          这场备考还没有解析出岗位包，题型与评分维度无从展开。先在「设置 → 插件」装好岗位包，
          再回到「备考 → 岗位与证据」补上岗位信息。
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {view && session && (
        <section className="space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-muted)]">
            <span className="rounded bg-sky-900/40 px-2 py-0.5 text-sky-300">
              {session.protocol}
            </span>
            <span>岗位包 {session.rolePackVersion}</span>
            <span>追问 {view.followUpsAsked}/{session.maxFollowUps}</span>
            <span>策略 {session.followUpStrategy}</span>
            {view.closed && <span className="text-emerald-400">本轮已结束</span>}
          </div>

          <div>
            <h4 className="text-xs font-medium text-[var(--color-muted)]">题目</h4>
            <div className="mt-1">
              <MarkdownContent text={normalizeDisplayText(view.questionMd)} />
            </div>
          </div>

          {view.turns.length > 1 && (
            <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
              <h4 className="text-xs font-medium text-[var(--color-muted)]">过程</h4>
              {view.turns.slice(1).map((turn) => (
                <div key={turn.id} className="text-xs">
                  <span className="text-[10px] text-[var(--color-muted)]">
                    {turn.speaker === 'interviewer' ? '面试官' : '你'}
                  </span>
                  <MarkdownContent text={normalizeDisplayText(turn.contentMd)} />
                </div>
              ))}
            </div>
          )}

          {!view.closed && (
            <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
              <h4 className="text-xs font-medium text-[var(--color-muted)]">你的回答</h4>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={10}
                placeholder="按题目要求作答；提交追问会让面试官接着问下去，提交评分则结束本轮"
                className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <VoiceInputButton currentText={answer} onTextChange={setAnswer} />
                <button
                  type="button"
                  disabled={busy || !answer.trim() || !view.canFollowUp}
                  onClick={followUp}
                  title={
                    view.canFollowUp ? undefined : '本题的追问轮数已经用完，直接提交评分即可'
                  }
                  className="ml-auto rounded border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-40"
                >
                  {turnTask.running ? '追问中…' : `提交并追问（还剩 ${view.followUpsLeft} 轮）`}
                </button>
                <button
                  type="button"
                  disabled={busy || !answer.trim() || !view.canEvaluate}
                  onClick={evaluate}
                  className="rounded bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-40"
                >
                  {evaluateTask.running ? '评分中…' : '提交评分'}
                </button>
              </div>
            </div>
          )}

          {evaluation && summary && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xl font-semibold text-[var(--color-accent)]">
                  {summary.totalLabel}
                </span>
                {summary.needsRePractice && (
                  <span className="rounded bg-amber-900/40 px-2 py-0.5 text-[10px] text-amber-200">
                    建议复练
                  </span>
                )}
                {evaluation.mastery && (
                  <span className="text-[10px] text-[var(--color-muted)]">
                    考点掌握度已更新为 {Math.round(evaluation.mastery.mastery * 100)}%
                  </span>
                )}
              </div>

              {summary.criticalMisses.length > 0 && (
                <p className="rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-200">
                  关键维度触底：
                  {summary.criticalMisses.map((score) => score.label).join('、')}
                  。这几条单独就够让面试挂掉，优先复练。
                </p>
              )}

              {summary.ungroundedDimensionIds.length > 0 && (
                <p className="text-xs text-amber-300">
                  有 {summary.ungroundedDimensionIds.length} 个维度的引文和你的作答对不上，
                  下面已逐条标出。
                </p>
              )}

              <ul className="space-y-2">
                {sortScoresByWeight(evaluation.scores).map((score) => (
                  <DimensionScoreCard
                    key={score.dimensionId}
                    score={score}
                    answerMd={citationSource}
                  />
                ))}
              </ul>

              <div>
                <h4 className="text-xs text-[var(--color-muted)]">整体反馈</h4>
                <div className="mt-1 text-sm">
                  <MarkdownContent text={normalizeDisplayText(evaluation.feedbackMd)} />
                </div>
              </div>

              {evaluation.improvedScriptMd && (
                <div>
                  <h4 className="text-xs text-[var(--color-muted)]">改进稿</h4>
                  <div className="mt-1 text-sm text-emerald-300">
                    <MarkdownContent text={normalizeDisplayText(evaluation.improvedScriptMd)} />
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
