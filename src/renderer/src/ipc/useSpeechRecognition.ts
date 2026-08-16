import { useCallback, useEffect, useRef, useState } from 'react';
import type { SttStatus } from '@shared/ipc';
import { invoke, onEvent } from './index';

/**
 * 本地离线语音口述：getUserMedia 采集 16kHz 单声道 PCM → IPC 主进程 Whisper 转写。
 * 替代已失效的 Web Speech API（依赖 Google 云端，Electron 下必现 network 错误）。
 * 首次转写会触发模型懒加载，进度经 stt:status 事件推送。
 */

const TARGET_RATE = 16000;
const CHUNK_SIZE = 4096;

function getSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** 用 OfflineAudioContext 把任意采样率重采样到 16kHz */
async function resampleTo16k(
  chunks: Float32Array[],
  fromRate: number,
): Promise<Float32Array> {
  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  const offline = new OfflineAudioContext(
    1,
    Math.ceil((totalLen * TARGET_RATE) / fromRate),
    TARGET_RATE,
  );
  const buffer = offline.createBuffer(1, totalLen, fromRate);
  const data = buffer.getChannelData(0);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** 拼接多个 Float32 分片为单个 Float32Array */
function concatChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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
  /** 正在转写中（本地模型推理，按钮应禁用并提示） */
  transcribing: boolean;
  error: string | null;
  /** 主进程模型加载/下载状态 */
  status: SttStatus | null;
  toggle: () => void;
  stop: () => void;
} {
  const [supported] = useState(getSupported);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SttStatus | null>(null);

  const onTranscriptRef = useRef(onTranscript);
  const langRef = useRef(lang);
  // ref 更新放到 effect 里，避免渲染期间写 ref（react-hooks/refs）
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    langRef.current = lang;
  });

  const listeningRef = useRef(false);
  const transcribingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(TARGET_RATE);

  // 订阅主进程模型状态（懒加载触发后才有推送）
  useEffect(() => {
    return onEvent('stt:status', (s) => setStatus(s));
  }, []);

  // 卸载时释放资源
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  const stop = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);

    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);

    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (chunks.length === 0) return;

    // 转写是异步的，先标记再串行执行（避免 stop 被连续调用时重复转写）
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    setTranscribing(true);
    void (async () => {
      try {
        const rate = sampleRateRef.current;
        const audio =
          rate === TARGET_RATE
            ? concatChunks(chunks)
            : await resampleTo16k(chunks, rate);
        const { text } = await invoke('stt:transcribe', { audio });
        if (text.trim()) onTranscriptRef.current(text.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        transcribingRef.current = false;
        setTranscribing(false);
      }
    })();
  }, []);

  const start = useCallback(async () => {
    if (listeningRef.current || transcribingRef.current) return;
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? '请允许麦克风权限'
          : name === 'NotFoundError'
            ? '未检测到麦克风'
            : '无法访问麦克风',
      );
      return;
    }

    const ctx = new AudioContext({ sampleRate: TARGET_RATE });
    sampleRateRef.current = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(CHUNK_SIZE, 1, 1);
    node.onaudioprocess = (e) => {
      if (listeningRef.current) chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(node);
    node.connect(ctx.destination);

    streamRef.current = stream;
    audioContextRef.current = ctx;
    nodeRef.current = node;
    chunksRef.current = [];
    listeningRef.current = true;
    setListening(true);
  }, []);

  const toggle = useCallback(() => {
    if (transcribingRef.current) return;
    if (listeningRef.current) {
      stop();
    } else {
      void start();
    }
  }, [start, stop]);

  return { supported, listening, transcribing, error, status, toggle, stop };
}