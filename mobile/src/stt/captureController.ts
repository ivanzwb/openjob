/** 与桌面端同构的状态机：idle → recording → transcribing → done/error */
export type SpeechState =
  | { state: 'idle' }
  | { state: 'downloading'; percent: number }
  | { state: 'recording' }
  | { state: 'transcribing' }
  | { state: 'error'; error: string };

/** 点停止时取走的这一段录音 */
export interface CapturedAudio {
  /** whisper.rn 要求的 int16 单声道字节流 */
  audio: ArrayBuffer;
  sampleCount: number;
}

export interface SpeechCaptureDeps {
  requestPermission: () => Promise<boolean>;
  isModelReady: () => boolean;
  downloadModel: (onProgress: (percent: number) => void) => Promise<void>;
  loadContext: () => Promise<void>;
  startStream: () => Promise<void>;
  stopStream: () => void;
  takeAudio: () => CapturedAudio | null;
  transcribe: (audio: ArrayBuffer) => Promise<string>;
  onState: (state: SpeechState) => void;
  onTranscript: (text: string) => void;
  /** 短于这个样本数就当没说话 */
  minSamples: number;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 语音口述的启停时序。
 *
 * 从 React 里拆出来，是因为出问题的正是「开始」与「停止」这对异步调用的交错：
 * 点停时启动链往往还没跑完，拿 React state 当守卫会读到上一帧的旧值，于是 stop
 * 被整个丢掉——流停不下来、状态永远卡在 recording。这里一律用同步字段判断，
 * 顺便也能脱开原生模块单测。
 */
export class SpeechCaptureController {
  private readonly deps: SpeechCaptureDeps;
  private startPromise: Promise<void> | null = null;
  private contextPromise: Promise<void> | null = null;
  private contextReady = false;
  /** stream.start() 已落定：点停止必须真的去停流 */
  private capturing = false;
  private downloading = false;
  private stopRequested = false;
  private stopping = false;
  private startFailed = false;
  private disposed = false;

  constructor(deps: SpeechCaptureDeps) {
    this.deps = deps;
  }

  private emit(next: SpeechState): void {
    if (this.disposed) return;
    this.deps.onState(next);
  }

  private loadContext(): Promise<void> {
    if (this.contextReady) return Promise.resolve();
    if (this.contextPromise) return this.contextPromise;

    const pending = this.deps.loadContext().then(() => {
      this.contextReady = true;
    });
    this.contextPromise = pending;
    void pending.catch(() => undefined).then(() => {
      // 失败就把坑清掉，下次点开始还能重来一遍
      if (this.contextPromise === pending) this.contextPromise = null;
    });
    return pending;
  }

  /**
   * 预热：模型已经在本地时提前把上下文加载好，按下麦克风就能立刻开录。
   * 模型不在本地一律什么都不做——为了少等一两秒替用户下 56.9MB 是不能接受的。
   */
  async prepare(): Promise<void> {
    if (this.disposed || this.contextReady || this.contextPromise) return;
    if (!this.deps.isModelReady()) return;
    // 预热失败不该打扰用户：真按下麦克风时会重试一次并如实报错
    await this.loadContext().catch(() => undefined);
  }

  start(): Promise<void> {
    if (this.disposed || this.capturing || this.stopping) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.stopRequested = false;
    this.startFailed = false;
    const pending = this.runStart().finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  /** 同步判据：当前是否正在录音。React state 慢一帧，点按切换的第二下用它判断 */
  isRecording(): boolean {
    return this.capturing;
  }

  private async runStart(): Promise<void> {
    try {
      const granted = await this.deps.requestPermission();
      if (this.stopRequested || this.disposed) return;
      if (!granted) {
        this.fail('未获得麦克风权限，请在系统设置中允许');
        return;
      }

      if (!this.deps.isModelReady()) {
        this.downloading = true;
        this.emit({ state: 'downloading', percent: 0 });
        try {
          await this.deps.downloadModel((percent) => {
            if (!this.stopRequested) this.emit({ state: 'downloading', percent });
          });
        } finally {
          this.downloading = false;
        }
        if (this.stopRequested || this.disposed) {
          this.emit({ state: 'idle' });
          return;
        }
      }

      // 过了这一行麦克风就已经开了，后面不能再中途 return：
      // stopRequested 交给 stop() 处理，它正等着这个 promise
      await this.deps.startStream();
      // 同步置位，stop() 才有一个不会滞后一帧的守卫可用
      this.capturing = true;
      this.emit({ state: 'recording' });
      // 开录途中组件被卸载，没人会来 stop 了，这里必须自己关掉
      if (this.disposed) {
        this.capturing = false;
        this.deps.stopStream();
        return;
      }

      // 上下文没预热时加载要花一两秒，挡在开录前面等于把用户前半句话吞掉；
      // 放到开录之后并行做，点停止转写前再等它就行
      void this.loadContext().catch(() => undefined);
    } catch (err) {
      this.fail(errorMessage(err));
    }
  }

  private fail(error: string): void {
    this.startFailed = true;
    this.emit({ state: 'error', error });
  }

  async stop(): Promise<void> {
    if (this.disposed || this.stopping) return;
    this.stopRequested = true;
    const pending = this.startPromise;

    // 下载 56.9MB 途中点停止：等它下完再收尾会把人晾在那儿几十秒。这时还没开录、
    // 没有流要释放，直接静默收场；下载留着跑完，下次点开始就不用再等一遍
    if (pending && this.downloading) {
      this.emit({ state: 'idle' });
      return;
    }
    // 点停止时启动链常常还没落定，必须等它，否则这一次 stop 就凭空消失了
    if (pending) await pending;

    if (!this.capturing) {
      // 权限/加载失败已经报过更具体的原因，别拿「准备中」盖掉
      if (this.startFailed) return;
      // 压根没录到过音：点按模式下这是「点了开始又点了停止」的取消动作，
      // 静默回到 idle，不让用户觉得多按一下就做错了什么
      this.emit({ state: 'idle' });
      return;
    }

    this.stopping = true;
    this.capturing = false;
    try {
      this.deps.stopStream();
      this.emit({ state: 'transcribing' });

      const captured = this.deps.takeAudio();
      if (!captured) {
        this.emit({ state: 'error', error: '未录到声音，请再试一次' });
        return;
      }
      if (captured.sampleCount < this.deps.minSamples) {
        this.emit({ state: 'error', error: '录音太短，请多说一会儿' });
        return;
      }

      await this.loadContext();
      const text = (await this.deps.transcribe(captured.audio)).trim();
      if (text) this.deps.onTranscript(text);
      this.emit({ state: 'idle' });
    } catch (err) {
      this.emit({ state: 'error', error: errorMessage(err) });
    } finally {
      this.stopping = false;
    }
  }

  /** 卸载时流还开着一定要关掉，否则麦克风会一直亮着 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.capturing) return;
    this.capturing = false;
    try {
      this.deps.stopStream();
    } catch {
      // 原生对象可能已被回收，这里没有可补救的动作
    }
  }
}
