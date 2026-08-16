import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestRecordingPermissionsAsync,
  useAudioStream,
} from 'expo-audio';
import { initWhisper, releaseAllWhisper, type WhisperContext } from 'whisper.rn';
import { ensureModel, isModelReady } from '../stt/model';

/** 与桌面端同构的状态机：idle → recording → transcribing → done/error */
export type SpeechState =
  | { state: 'idle' }
  | { state: 'downloading'; percent: number }
  | { state: 'recording' }
  | { state: 'transcribing' }
  | { state: 'error'; error: string };

/** 录音用 16kHz 单声道 int16 —— whisper 原生输入格式，无需重采样 */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const ENCODING = 'int16' as const;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 手机端本地语音口述：expo-audio 实时 PCM 流 → whisper.cpp 本地转写。
 * 完全离线，不依赖网络或云端识别。
 */
export function useSpeechRecognition(onTranscript: (text: string) => void): {
  supported: boolean;
  state: SpeechState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<SpeechState>({ state: 'idle' });
  const onTranscriptRef = useRef(onTranscript);
  const whisperRef = useRef<WhisperContext | null>(null);
  // PCM 分块累积走 ref：录音中每 buffer 一次都 setState 会让 UI 卡顿
  const pcmChunksRef = useRef<ArrayBuffer[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // 卸载时释放 whisper 上下文（原生内存）
  useEffect(() => {
    return () => {
      void releaseAllWhisper();
    };
  }, []);

  // useAudioStream 内部已订阅 onBuffer 与 isStreaming，这里只提供回调
  const { stream, isStreaming } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    encoding: ENCODING,
    onBuffer: (buffer) => {
      pcmChunksRef.current.push(buffer.data);
    },
  });

  const start = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      // 1. 权限
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setState({ state: 'error', error: '未获得麦克风权限，请在系统设置中允许' });
        return;
      }

      // 2. 模型：未就绪先下载（56.9MB，带进度）
      if (!isModelReady()) {
        setState({ state: 'downloading', percent: 0 });
        await ensureModel(({ percent }) => setState({ state: 'downloading', percent }));
      }

      // 3. 加载 whisper 上下文（懒加载，只做一次）
      if (!whisperRef.current) {
        const model = await ensureModel();
        whisperRef.current = await initWhisper({ filePath: model.uri });
      }

      // 4. 开始录音
      pcmChunksRef.current = [];
      setState({ state: 'recording' });
      await stream.start();
    } catch (err) {
      setState({ state: 'error', error: errorMessage(err) });
    } finally {
      busyRef.current = false;
    }
  }, [stream]);

  const stop = useCallback(async () => {
    if (!isStreaming) return;
    try {
      stream.stop();
      setState({ state: 'transcribing' });

      // 合并 PCM 分块为单个 Float32Array（whisper transcribeData 要求）
      const chunks = pcmChunksRef.current;
      const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.byteLength / 2, 0);
      const pcm = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of chunks) {
        const int16 = new Int16Array(chunk);
        for (let i = 0; i < int16.length; i++) {
          pcm[offset++] = int16[i] / 32768;
        }
      }

      if (!whisperRef.current) {
        setState({ state: 'error', error: '语音识别未初始化' });
        return;
      }

      const { promise } = whisperRef.current.transcribeData(pcm.buffer, {
        language: 'zh',
      });
      const { result } = await promise;
      const text = result.trim();
      if (text) onTranscriptRef.current(text);
      setState({ state: 'idle' });
    } catch (err) {
      setState({ state: 'error', error: errorMessage(err) });
    }
  }, [isStreaming, stream]);

  return { supported: true, state, start, stop };
}