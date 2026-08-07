import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechRecognition({
  onTranscript,
  lang = 'zh-CN',
}: {
  onTranscript: (text: string) => void;
  lang?: string;
}): {
  supported: boolean;
  listening: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => void;
} {
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('当前环境不支持语音识别');
      return;
    }

    if (listening) {
      stop();
      return;
    }

    setError(null);
    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i]?.[0]?.transcript ?? '';
      }
      if (text.trim()) onTranscript(text);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setError(event.error === 'not-allowed' ? '请允许麦克风权限' : event.error);
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [lang, listening, onTranscript, stop]);

  return { supported, listening, error, toggle, stop };
}
