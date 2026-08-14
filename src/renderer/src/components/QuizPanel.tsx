import { useState } from 'react';
import { VoiceInputButton } from './VoiceInputButton';
import type { QuizSubmitResult } from '@shared/ipc';
import { invoke } from '../ipc';
import { runTask, useTask, useTaskResult } from '../ipc/taskStore';

/**
 * 考我：出题与评分都记在按考点取的任务 key 上。
 * 切到别的学习模式或别的考点会卸载这个面板，回来时按钮仍显示进行中，
 * 期间跑完的题目/评分也会补上。
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

  const questionKey = `quiz:question:${nodeId}`;
  const submitKey = `quiz:submit:${nodeId}`;
  const questionTask = useTask(questionKey);
  const submitTask = useTask(submitKey);
  const loading = questionTask.running || submitTask.running;
  const error = questionTask.error ?? submitTask.error;

  useTaskResult<string>(questionKey, (q) => {
    setQuestion(q);
    setResult(null);
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

  const submit = (): void => {
    if (!question || !answer.trim()) return;
    const asked = question;
    const said = answer.trim();
    void runTask(submitKey, () =>
      invoke('quiz:submit', { nodeId, question: asked, userAnswer: said }),
    ).catch(() => undefined);
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">考我 · {nodeName}</h3>

      {!question && !result && (
        <button
          type="button"
          onClick={start}
          disabled={loading}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {questionTask.running ? '出题中…' : '开始出题'}
        </button>
      )}

      {question && !result && (
        <>
          <div className="rounded border border-[var(--color-border)] bg-black/20 p-3 text-sm">
            {question}
          </div>
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

      {result && (
        <div className="space-y-3 text-sm">
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
