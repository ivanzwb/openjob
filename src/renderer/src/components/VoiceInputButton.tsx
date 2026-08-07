import { useSpeechRecognition } from '../ipc/useSpeechRecognition';

export function VoiceInputButton({
  onTranscript,
  append = true,
  currentText = '',
  onTextChange,
}: {
  onTranscript?: (text: string) => void;
  append?: boolean;
  currentText?: string;
  onTextChange?: (text: string) => void;
}): React.JSX.Element | null {
  const { supported, listening, error, toggle } = useSpeechRecognition({
    onTranscript: (chunk) => {
      if (onTextChange) {
        const next = append ? `${currentText}${chunk}` : chunk;
        onTextChange(next);
      }
      onTranscript?.(chunk);
    },
  });

  if (!supported) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        className={`rounded border px-2 py-1 text-xs ${
          listening
            ? 'border-red-800 bg-red-950/40 text-red-300'
            : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]'
        }`}
      >
        {listening ? '停止口述' : '语音口述'}
      </button>
      {listening && <span className="text-xs text-amber-400">正在听…</span>}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
