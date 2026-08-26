import { describe, expect, it, vi } from 'vitest';
import {
  SpeechCaptureController,
  type SpeechCaptureDeps,
  type SpeechState,
} from './captureController';

/** 手动落定的 promise，用来把「松手时启动链还没跑完」这个时序摆出来 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function silence(sampleCount: number): ArrayBuffer {
  return new Int16Array(sampleCount).buffer;
}

function setup(overrides: Partial<SpeechCaptureDeps> = {}): {
  controller: SpeechCaptureController;
  deps: SpeechCaptureDeps;
  states: SpeechState[];
  transcripts: string[];
} {
  const states: SpeechState[] = [];
  const transcripts: string[] = [];
  const deps: SpeechCaptureDeps = {
    requestPermission: vi.fn(async () => true),
    isModelReady: vi.fn(() => true),
    downloadModel: vi.fn(async () => undefined),
    loadContext: vi.fn(async () => undefined),
    startStream: vi.fn(async () => undefined),
    stopStream: vi.fn(),
    takeAudio: vi.fn(() => ({ audio: silence(8000), sampleCount: 8000 })),
    transcribe: vi.fn(async () => '你好'),
    onState: (state) => states.push(state),
    onTranscript: (text) => transcripts.push(text),
    minSamples: 3200,
    ...overrides,
  };
  return { controller: new SpeechCaptureController(deps), deps, states, transcripts };
}

describe('SpeechCaptureController', () => {
  it('正常按住再松开会转写并回到 idle', async () => {
    const { controller, deps, states, transcripts } = setup();

    await controller.start();
    expect(states.at(-1)).toEqual({ state: 'recording' });

    await controller.stop();
    expect(deps.stopStream).toHaveBeenCalledTimes(1);
    expect(transcripts).toEqual(['你好']);
    expect(states.at(-1)).toEqual({ state: 'idle' });
  });

  it('stream.start() 还没落定就松手：流仍会被停掉，不会卡在 recording', async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const { controller, deps, states, transcripts } = setup({
      startStream: vi.fn(() => {
        started.resolve();
        return gate.promise;
      }),
    });

    const starting = controller.start();
    // 麦克风已经在开了，这时候松手是最容易把 stop 丢掉的时序
    await started.promise;
    const stopping = controller.stop();
    gate.resolve();
    await Promise.all([starting, stopping]);

    expect(deps.stopStream).toHaveBeenCalledTimes(1);
    expect(transcripts).toEqual(['你好']);
    expect(states.at(-1)).toEqual({ state: 'idle' });
  });

  it('权限还没批下来就松手：不开录，也不怪用户按太短', async () => {
    const gate = deferred<boolean>();
    const { controller, deps, states } = setup({
      requestPermission: vi.fn(() => gate.promise),
    });

    const starting = controller.start();
    const stopping = controller.stop();
    gate.resolve(true);
    await Promise.all([starting, stopping]);

    expect(deps.startStream).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      state: 'error',
      error: '语音识别还在准备，请稍后再按住说话',
    });
  });

  it('真的录到音但太短才说「录音太短」', async () => {
    const { controller, states } = setup({
      takeAudio: vi.fn(() => ({ audio: silence(100), sampleCount: 100 })),
    });

    await controller.start();
    await controller.stop();

    expect(states.at(-1)).toEqual({ state: 'error', error: '录音太短，请按住多说一会儿' });
  });

  it('一次录音都没有时不提示太短', async () => {
    const { controller, states } = setup({ takeAudio: vi.fn(() => null) });

    await controller.start();
    await controller.stop();

    expect(states.at(-1)).toEqual({ state: 'error', error: '未录到声音，请按住麦克风再试' });
  });

  it('权限被拒后松手不会盖掉更具体的报错', async () => {
    const { controller, deps, states } = setup({
      requestPermission: vi.fn(async () => false),
    });

    await controller.start();
    await controller.stop();

    expect(deps.stopStream).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      state: 'error',
      error: '未获得麦克风权限，请在系统设置中允许',
    });
  });

  it('模型不在本地时 prepare 不下载也不加载', async () => {
    const { controller, deps } = setup({ isModelReady: vi.fn(() => false) });

    await controller.prepare();

    expect(deps.downloadModel).not.toHaveBeenCalled();
    expect(deps.loadContext).not.toHaveBeenCalled();
  });

  it('预热过之后按下麦克风不再等上下文加载', async () => {
    const { controller, deps } = setup();

    await controller.prepare();
    expect(deps.loadContext).toHaveBeenCalledTimes(1);

    await controller.start();
    expect(deps.startStream).toHaveBeenCalledTimes(1);
    // 预热已经就绪，开录这一路不该再触发一次加载
    expect(deps.loadContext).toHaveBeenCalledTimes(1);
  });

  it('未预热时先开录，上下文加载不挡在录音前面', async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const { controller, states } = setup({
      loadContext: vi.fn(() => {
        order.push('loadContext');
        return gate.promise;
      }),
      startStream: vi.fn(async () => {
        order.push('startStream');
      }),
    });

    await controller.start();
    expect(order).toEqual(['startStream', 'loadContext']);
    expect(states.at(-1)).toEqual({ state: 'recording' });

    const stopping = controller.stop();
    gate.resolve();
    await stopping;
    expect(states.at(-1)).toEqual({ state: 'idle' });
  });

  it('连按两次只开一路流', async () => {
    const { controller, deps } = setup();

    await Promise.all([controller.start(), controller.start()]);

    expect(deps.startStream).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(deps.stopStream).toHaveBeenCalledTimes(1);
  });

  it('下载中途松手不必等下载完，且不会去开录', async () => {
    const gate = deferred<void>();
    const { controller, deps, states } = setup({
      isModelReady: vi.fn(() => false),
      downloadModel: vi.fn(() => gate.promise),
    });

    const starting = controller.start();
    await Promise.resolve();
    await controller.stop();
    expect(states.at(-1)).toEqual({ state: 'idle' });

    gate.resolve();
    await starting;
    expect(deps.startStream).not.toHaveBeenCalled();
  });

  it('录音中卸载会释放流', async () => {
    const { controller, deps } = setup();

    await controller.start();
    controller.dispose();

    expect(deps.stopStream).toHaveBeenCalledTimes(1);
  });

  it('开录途中卸载也会释放流', async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const { controller, deps } = setup({
      startStream: vi.fn(() => {
        started.resolve();
        return gate.promise;
      }),
    });

    const starting = controller.start();
    await started.promise;
    controller.dispose();
    gate.resolve();
    await starting;

    expect(deps.stopStream).toHaveBeenCalledTimes(1);
  });

  it('转写失败后还能重新开始下一次录音', async () => {
    const { controller, deps, states } = setup({
      transcribe: vi.fn(async () => {
        throw new Error('转写炸了');
      }),
    });

    await controller.start();
    await controller.stop();
    expect(states.at(-1)).toEqual({ state: 'error', error: '转写炸了' });

    await controller.start();
    expect(deps.startStream).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual({ state: 'recording' });
  });
});
