import { useCallback, useEffect, useState } from 'react';
import { EXAM_FORMS, type ExamForm } from '@shared/enums';
import { MOCK_INTERVIEW_TYPE_LABELS, type CampaignRuntimeView } from '@shared/ipc';
import type { PracticeDimensionScore, PracticeEvaluation, PracticeSession } from '@shared/practice';
import {
  derivePracticeView,
  sliceAnswerCitation,
  sortScoresByWeight,
  summarizeEvaluation,
} from '@shared/hostUi';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { MarkdownContent } from './MarkdownContent';
import { VoiceInputButton } from './VoiceInputButton';
import { invoke } from '../ipc';
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
 * 题型只给核心枚举里的旧 ExamForm，由岗位包自己映射成它声明的题型 ID。界面因此不需要
 * 知道任何一个岗位包定义了哪些题型——把 `se.system-design` 之类的 ID 抄进来能跑通，
 * 但换一个岗位包就是静默失效：createSession 报 unknown-format，而错在界面里的一个字符串。
 *
 * 会话 ID 落 localStorage：出题、追问、评分都是分钟级的模型调用，中途切页面回来时
 * 让用户重新出题等于把刚才那几分钟连同作答一起丢掉。
 */
export function PracticeRunner({ campaignId }: { campaignId: string }): React.JSX.Element {
  const [examForm, setExamForm] = useState<ExamForm>('concept');
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [answer, setAnswer] = useState('');
  const [evaluation, setEvaluation] = useState<PracticeEvaluation | null>(null);
  const [scoredAnswer, setScoredAnswer] = useState('');
  // 连同它属于哪场备考一起存：换 Campaign 时上一场的结论自动作废，不必先同步清一次
  const [runtimeState, setRuntimeState] = useState<{
    campaignId: string;
    view: CampaignRuntimeView | null;
  } | null>(null);

  const storageKey = `openjob:practice:${campaignId}:${examForm}`;
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
  // 与其让用户点下去再吃一个 role-pack-unavailable，不如先说清楚该去哪儿确认岗位
  useEffect(() => {
    void invoke('campaign:getRuntimeDescriptor', { campaignId })
      .then((view) => setRuntimeState({ campaignId, view }))
      .catch(() => setRuntimeState({ campaignId, view: null }));
  }, [campaignId]);

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
    void runTask(createKey, () =>
      invoke('practice:createSession', { campaignId, legacyExamForm: examForm }),
    ).catch(() => undefined);
  };

  const followUp = (): void => {
    if (!session || !answer.trim()) return;
    void runTask(turnKey, () =>
      invoke('practice:nextTurn', { sessionId: session.id, answerMd: answer.trim() }),
    ).catch(() => undefined);
  };

  const evaluate = (): void => {
    if (!session || !answer.trim()) return;
    const submitted = answer.trim();
    setScoredAnswer(submitted);
    void runTask(evaluateKey, () =>
      invoke('practice:evaluate', { sessionId: session.id, answerMd: submitted }),
    ).catch(() => undefined);
  };

  const latestAnswerTurn = view?.turns.filter((turn) => turn.speaker === 'candidate').at(-1);
  // 切页面回来时 scoredAnswer 已经没了，退回会话里最后一次作答，引文照样能切
  const citationSource = scoredAnswer || latestAnswerTurn?.contentMd || '';
  const summary = evaluation ? summarizeEvaluation(evaluation, citationSource) : null;
  const busy = createTask.running || turnTask.running || evaluateTask.running;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-xs text-[var(--color-muted)]">题型</span>
          <select
            value={examForm}
            onChange={(e) => setExamForm(e.target.value as ExamForm)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
          >
            {EXAM_FORMS.map((form) => (
              <option key={form} value={form}>
                {MOCK_INTERVIEW_TYPE_LABELS[form]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!campaignId || busy || !runtime}
          onClick={start}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {createTask.running ? '出题中…' : session ? '换一题' : '开始练习'}
        </button>
      </div>

      {runtimeLoaded && !runtime ? (
        <p className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
          这场备考还没有确认岗位，题型与评分维度无从展开。先去「备考 →
          岗位与证据」确认岗位包，再回来练习。
        </p>
      ) : (
        <p className="text-xs text-[var(--color-muted)]">
          题型交给岗位包映射成它自己声明的面试形式，追问轮数与评分维度也由岗位包决定。
          评分会逐维度给出量规锚点和它引用的你的原话。
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
