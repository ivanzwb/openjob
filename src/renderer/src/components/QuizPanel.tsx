import { useState } from 'react';
import type { QuizSubmitResult } from '@shared/ipc';
import { invoke } from '../ipc';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const q = await invoke('quiz:question', { nodeId });
      setQuestion(q.question);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!question || !answer.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke('quiz:submit', {
        nodeId,
        question,
        userAnswer: answer.trim(),
      });
      setResult(res);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">考我 · {nodeName}</h3>

      {!question && !result && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={loading}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {loading ? '出题中…' : '开始出题'}
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
            placeholder="口述你的回答（打字模拟口述）…"
            className="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading || !answer.trim()}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {loading ? '评分中…' : '提交答案'}
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
