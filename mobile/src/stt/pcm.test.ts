import { describe, expect, it } from 'vitest';
import { mergeInt16PcmChunks, pcmChunksToWhisperBuffer, resampleInt16, toMonoInt16 } from './pcm';

describe('pcm', () => {
  it('mergeInt16PcmChunks 按顺序拼接', () => {
    const a = new Int16Array([1, 2]).buffer;
    const b = new Int16Array([3, 4]).buffer;
    const merged = mergeInt16PcmChunks([
      { data: a, sampleRate: 16000, channels: 1 },
      { data: b, sampleRate: 16000, channels: 1 },
    ]);
    expect(Array.from(merged)).toEqual([1, 2, 3, 4]);
  });

  it('toMonoInt16 多声道平均', () => {
    const stereo = new Int16Array([10, 20, 30, 40]);
    expect(Array.from(toMonoInt16(stereo, 2))).toEqual([15, 35]);
  });

  it('resampleInt16 降采样', () => {
    const src = new Int16Array([0, 1000, 0, -1000]);
    const out = resampleInt16(src, 32000, 16000);
    expect(out.length).toBe(2);
  });

  it('pcmChunksToWhisperBuffer 输出 int16 字节流', () => {
    const buf = pcmChunksToWhisperBuffer([
      {
        data: new Int16Array([100, -100]).buffer,
        sampleRate: 16000,
        channels: 1,
      },
    ]);
    expect(buf).not.toBeNull();
    expect(new Int16Array(buf!).length).toBe(2);
  });
});
