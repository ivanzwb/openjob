import { useEffect, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { VoiceInputButton } from './VoiceInputButton';
import type { QuizAnswerResult, QuizSubmitResult } from '@shared/ipc';
import { normalizeDisplayText } from '@shared/lib/markdownDisplay';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

/**
 * 考我：出题、参考答案与评分都记在按考点取的任务 key 上。
 * 题目与推荐答案缓存在 knowledge_node 上，两端同步；切考点再回来仍显示保存的题。
 */
export function QuizPanel({
  nodeId,
  nodeName,
  onDone,
}: {
  nodeId: string;
  nodeName: string;
  onDone?: () => void;
}): React.JSX.Element {
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<QuizSubmitResult | null>(null);
  const [recommended, setRecommended] = useState('');
  const [editingRecommended, setEditingRecommended] = useState(false);
  const [savedToScripts, setSavedToScripts] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const questionKey = `quiz:question:${nodeId}`;
  const answerKey = `quiz:answer:${nodeId}`;
  const submitKey = `quiz:submit:${nodeId}`;
  const questionTask = useTask(questionKey);
  const answerTask = useTask(answerKey);
  const submitTask = useTask(submitKey);
  const loading = questionTask.running || submitTask.running;
  const error = questionTask.error ?? answerTask.error ?? submitTask.error;

  useEffect(() => {
    let cancelled = false;
    void invoke('quiz:draft', { nodeId })
      .then((draft) => {
        if (cancelled) return;
        if (draft.questionMd) setQuestion(draft.questionMd);
        if (draft.recommendedAnswerMd) setRecommended(draft.recommendedAnswerMd);
        setDraftLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setDraftLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  useTaskResult<string>(questionKey, (q) => {
    setQuestion(q);
    setResult(null);
    setAnswer('');
    setRecommended('');
    setEditingRecommended(false);
    setSavedToScripts(false);
  });
  useTaskResult<QuizAnswerResult>(answerKey, (res) => {
    setRecommended(res.recommendedAnswerMd);
    setEditingRecommended(false);
    setSavedToScripts(false);
  });
  useTaskResult<QuizSubmitResult>(submitKey, (res) => {
    setResult(res);
    onDone?.();
  });

  const start = (): void => {
    void runTask(questionKey, async () => {
      const q = await invoke('quiz:question', { nodeId });
      return q.question;
    }).catch(() => undefined);
  };

  const generateRecommended = (): void => {
    if (!question) return;
    const asked = question;
    void runTask(answerKey, () => invoke('quiz:answer', { nodeId, question: asked })).catch(
      () => undefined,
    );
  };

  const saveRecommendedDraft = (): void => {
    void invoke('quiz:updateDraft', { nodeId, recommendedAnswerMd: recommended }).then(() => {
      setEditingRecommended(false);
    });
  };

  const saveRecommendedToScripts = (): void => {
    const text = recommended.trim();
    if (!text) return;
    void invoke('speech:saveFromQuiz', { nodeId, contentMd: text }).then(() => {
      setEditingRecommended(false);
      setSavedToScripts(true);
    });
  };

  const submit = (): void => {
    if (!question || !answer.trim()) return;
    const asked = question;
    const said = answer.trim();
    void runTask(submitKey, () =>
      invoke('quiz:submit', { nodeId, question: asked, userAnswer: said }),
    ).catch(() => undefined);
  };

  if (!draftLoaded) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">考我 · {nodeName}</h3>
        <p className="text-sm text-[var(--color-muted)]">加载中…</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">考我 · {nodeName}</h3>

      <button
        type="button"
        onClick={start}
        disabled={loading}
        className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
      >
        {questionTask.running ? '出题中…' : question ? '重新出题' : '开始出题'}
      </button>
      <p className="text-xs text-[var(--color-muted)]">
        已生成的题目与推荐答案会自动保存；再次进入会直接显示，只有点「重新出题」才会换题。
      </p>

      {question && (
        <div className="rounded border border-[var(--color-border)] bg-black/20 p-3 text-sm select-text">
          {question}
        </div>
      )}

      {question && !result && (
        <>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={5}
            placeholder="口述你的回答（可点「语音口述」）…"
            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
          <VoiceInputButton currentText={answer} onTextChange={setAnswer} />
          <button
            type="button"
            onClick={submit}
            disabled={loading || !answer.trim()}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            {submitTask.running ? '评分中…' : '提交答案'}
          </button>
        </>
      )}

      {question && (
        <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-[var(--color-muted)]">推荐答案</h4>
            <div className="flex flex-wrap gap-3 text-xs">
              <button
                type="button"
                disabled={answerTask.running}
                onClick={generateRecommended}
                className="text-sky-400 hover:underline disabled:opacity-40"
              >
                {answerTask.running ? '生成中…' : recommended ? '重新生成' : '生成推荐答案'}
              </button>
              {recommended && (
                <button
                  type="button"
                  onClick={() => setEditingRecommended((v) => !v)}
                  className="text-sky-400 hover:underline"
                >
                  {editingRecommended ? '预览' : '编辑'}
                </button>
              )}
            </div>
          </div>
          {recommended ? (
            <>
              {editingRecommended ? (
                <textarea
                  value={recommended}
                  onChange={(e) => {
                    setRecommended(e.target.value);
                    setSavedToScripts(false);
                  }}
                  rows={10}
                  className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
                />
              ) : (
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                  <MarkdownContent text={normalizeDisplayText(recommended)} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {editingRecommended && (
                  <button type="button" onClick={saveRecommendedDraft} className="text-sky-400 hover:underline">
                    保存
                  </button>
                )}
                <button
                  type="button"
                  onClick={saveRecommendedToScripts}
                  className="text-sky-400 hover:underline"
                >
                  加入话术库
                </button>
                {savedToScripts && <span className="text-emerald-400">已加入话术库</span>}
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">
              答不上来可以先要一份参考答案，改成自己的说法后加入话术库。
            </p>
          )}
        </div>
      )}

      {result && (
        <div className="space-y-3 border-t border-[var(--color-border)] pt-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold text-[var(--color-accent)]">
              {result.attempt.score}/5
            </span>
            <span className="text-xs text-[var(--color-muted)]">
              掌握度更新为 {result.masteryUpdated.toFixed(1)}
            </span>
          </div>
          <div>
            <h4 className="text-xs text-[var(--color-muted)]">反馈</h4>
            <p className="mt-1 whitespace-pre-wrap">{result.attempt.feedbackMd}</p>
          </div>
          {result.attempt.improvedScriptMd && (
            <div>
              <h4 className="text-xs text-[var(--color-muted)]">改进话术</h4>
              <p className="mt-1 whitespace-pre-wrap text-emerald-300">
                {result.attempt.improvedScriptMd}
              </p>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
