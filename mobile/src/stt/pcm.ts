/** expo-audio 流式 PCM 分块（int16、小端、可能多声道） */
export type PcmChunk = {
  data: ArrayBuffer;
  sampleRate: number;
  channels: number;
};

/** 合并分块为连续 int16 样本（小端） */
export function mergeInt16PcmChunks(chunks: PcmChunk[]): Int16Array {
  const sampleCount = chunks.reduce((sum, c) => sum + c.data.byteLength / 2, 0);
  const out = new Int16Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    const int16 = new Int16Array(chunk.data);
    out.set(int16, offset);
    offset += int16.length;
  }
  return out;
}

/** 立体声等多声道 → 单声道（各声道平均） */
export function toMonoInt16(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += samples[i * channels + c];
    }
    mono[i] = Math.round(sum / channels);
  }
  return mono;
}

/** 线性插值重采样（whisper 要求 16kHz） */
export function resampleInt16(
  samples: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLen = Math.max(1, Math.round(samples.length * (toRate / fromRate)));
  const out = new Int16Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const s0 = samples[idx] ?? 0;
    const s1 = samples[idx + 1] ?? s0;
    out[i] = Math.round(s0 + frac * (s1 - s0));
  }
  return out;
}

/** 录音分块 → whisper.rn transcribeData 所需的 16kHz 单声道 int16 ArrayBuffer */
export function pcmChunksToWhisperBuffer(
  chunks: PcmChunk[],
  targetRate = 16000,
): ArrayBuffer | null {
  if (chunks.length === 0) return null;
  const { sampleRate, channels } = chunks[chunks.length - 1];
  let samples = mergeInt16PcmChunks(chunks);
  samples = toMonoInt16(samples, channels);
  samples = resampleInt16(samples, sampleRate, targetRate);
  if (samples.length === 0) return null;
  // 独立拷贝，避免 TypedArray 视图 offset 导致 JSI 读到错误字节范围
  const copy = new ArrayBuffer(samples.byteLength);
  new Int16Array(copy).set(samples);
  return copy;
}
