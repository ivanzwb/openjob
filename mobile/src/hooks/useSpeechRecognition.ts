import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requestRecordingPermissionsAsync,
  useAudioStream,
  type AudioStream,
} from 'expo-audio';
import { ensureModel, isModelReady } from '../stt/model';
import { SpeechCaptureController, type SpeechState } from '../stt/captureController';
import {
  loadWhisperContext,
  releaseWhisperContext,
  retainWhisperContext,
} from '../stt/whisperContext';
import { type PcmChunk, pcmChunksToWhisperBuffer } from '../stt/pcm';

/** 录音用 16kHz 单声道 int16 —— whisper 原生输入格式 */
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const ENCODING = 'int16' as const;
/** 最短有效录音：约 0.2 秒 */
const MIN_SAMPLES = SAMPLE_RATE / 5;

/**
 * 手机端本地语音口述：expo-audio 实时 PCM 流 → whisper.cpp 本地转写。
 * 完全离线，不依赖网络或云端识别。
 *
 * 启停时序全部交给 SpeechCaptureController，这里只把原生能力接上去。
 */
export function useSpeechRecognition(onTranscript: (text: string) => void): {
  supported: boolean;
  state: SpeechState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<SpeechState>({ state: 'idle' });
  const onTranscriptRef = useRef(onTranscript);
  // PCM 分块累积走 ref：录音中每 buffer 一次都 setState 会让 UI 卡顿
  const pcmChunksRef = useRef<PcmChunk[]>([]);
  const streamRef = useRef<AudioStream | null>(null);
  const controllerRef = useRef<SpeechCaptureController | null>(null);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  // useAudioStream 内部已订阅 onBuffer 与 isStreaming，这里只提供回调。
  // isStreaming 这个 React state 故意不用：它比松手晚一帧，正是 stop 被吞掉的根因
  const { stream } = useAudioStream({
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

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    retainWhisperContext();
    const controller = new SpeechCaptureController({
      requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
      isModelReady,
      downloadModel: async (onProgress) => {
        await ensureModel(({ percent }) => onProgress(percent));
      },
      loadContext: async () => {
        await loadWhisperContext();
      },
      startStream: async () => {
        const audioStream = streamRef.current;
        if (!audioStream) throw new Error('录音流尚未就绪');
        pcmChunksRef.current = [];
        await audioStream.start();
      },
      stopStream: () => {
        streamRef.current?.stop();
      },
      takeAudio: () => {
        const chunks = pcmChunksRef.current;
        pcmChunksRef.current = [];
        // whisper.rn transcribeData(ArrayBuffer) 要求 int16 PCM（mono 16kHz），不能传 float32
        const audio = pcmChunksToWhisperBuffer(chunks, SAMPLE_RATE);
        return audio ? { audio, sampleCount: audio.byteLength / 2 } : null;
      },
      transcribe: async (audio) => {
        const context = await loadWhisperContext();
        const { promise } = context.transcribeData(audio, { language: 'zh' });
        const { result } = await promise;
        return result;
      },
      onState: setState,
      onTranscript: (text) => onTranscriptRef.current(text),
      minSamples: MIN_SAMPLES,
    });
    controllerRef.current = controller;
    // 模型已经躺在本地时提前加载上下文，按下麦克风才能立刻开录；
    // 模型不在本地则原地不动，绝不因为进了页面就替用户下模型
    void controller.prepare();

    return () => {
      controllerRef.current = null;
      controller.dispose();
      releaseWhisperContext();
    };
  }, []);

  const start = useCallback(async () => {
    await controllerRef.current?.start();
  }, []);

  const stop = useCallback(async () => {
    await controllerRef.current?.stop();
  }, []);

  return { supported: true, state, start, stop };
}

export type { SpeechState };
