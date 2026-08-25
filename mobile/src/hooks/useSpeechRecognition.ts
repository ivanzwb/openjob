import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestRecordingPermissionsAsync,
  useAudioStream,
} from 'expo-audio';
import { initWhisper, releaseAllWhisper, type WhisperContext } from 'whisper.rn/index';
import { ensureModel, isModelReady } from '../stt/model';
import { type PcmChunk, pcmChunksToWhisperBuffer } from '../stt/pcm';

/** 与桌面端同构的状态机：idle → recording → transcribing → done/error */
export type SpeechState =
  | { state: 'idle' }
  | { state: 'downloading'; percent: number }
  | { state: 'recording' }
  | { state: 'transcribing' }
  | { state: 'error'; error: string };

/** 录音用 16kHz 单声道 int16 —— whisper 原生输入格式 */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const ENCODING = 'int16' as const;
/** 最短有效录音：约 0.2 秒 */
const MIN_SAMPLES = SAMPLE_RATE / 5;

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
  const pcmChunksRef = useRef<PcmChunk[]>([]);
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
      pcmChunksRef.current.push({
        data: buffer.data,
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
      });
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

      // whisper.rn transcribeData(ArrayBuffer) 要求 int16 PCM（mono 16kHz），不能传 float32
      const audioBuffer = pcmChunksToWhisperBuffer(pcmChunksRef.current, SAMPLE_RATE);
      if (!audioBuffer) {
        setState({ state: 'error', error: '未录到声音，请按住麦克风再试' });
        return;
      }

      const sampleCount = audioBuffer.byteLength / 2;
      if (sampleCount < MIN_SAMPLES) {
        setState({ state: 'error', error: '录音太短，请按住多说一会儿' });
        return;
      }

      if (!whisperRef.current) {
        setState({ state: 'error', error: '语音识别未初始化' });
        return;
      }

      const { promise } = whisperRef.current.transcribeData(audioBuffer, {
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
