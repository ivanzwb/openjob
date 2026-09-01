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
import { toSimplified } from '../stt/simplify';

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
 *
 * @param onTranscript 转写完成后回调
 * @param prompt 转写引导词（whisper initial prompt）：按页面类型传领域关键词，
 *               既提高领域的识别率，也让解码器偏向输出常用简体词
 */
export function useSpeechRecognition(
  onTranscript: (text: string) => void,
  prompt?: string,
): {
  supported: boolean;
  state: SpeechState;
  isRecording: () => boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<SpeechState>({ state: 'idle' });
  const onTranscriptRef = useRef(onTranscript);
  // prompt 走 ref：controller 只在挂载时建一次，页面传关键词变了也能跟上
  const promptRef = useRef(prompt);
  // PCM 分块累积走 ref：录音中每 buffer 一次都 setState 会让 UI 卡顿
  const pcmChunksRef = useRef<PcmChunk[]>([]);
  const streamRef = useRef<AudioStream | null>(null);
  const controllerRef = useRef<SpeechCaptureController | null>(null);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  // useAudioStream 内部已订阅 onBuffer 与 isStreaming，这里只提供回调。
  // isStreaming 这个 React state 故意不用：它比点停止晚一帧，正是 stop 被吞掉的根因
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
        const { promise } = context.transcribeData(
          audio,
          promptRef.current
            ? { language: 'zh', prompt: promptRef.current }
            : { language: 'zh' },
        );
        const { result } = await promise;
        // whisper 多语言中文模型输出天然偏繁体，转写后统一转简体
        return toSimplified(result);
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

  // 点按切换需要同步判据：React state 慢一帧，连点第二下读 state 会拿到旧值
  const isRecording = useCallback(() => controllerRef.current?.isRecording() ?? false, []);

  return { supported: true, state, isRecording, start, stop };
}

export type { SpeechState };
