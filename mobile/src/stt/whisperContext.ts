import { initWhisper, releaseAllWhisper, type WhisperContext } from 'whisper.rn/index';
import { ensureModel } from './model';

/**
 * 全进程共用一个 whisper 上下文。
 *
 * base 模型驻留原生内存上百 MB，而语音按钮同时挂着好几个（追问、考点学习、方案设计…），
 * 各自初始化一份会把手机吃爆；whisper.rn 又只给了 releaseAllWhisper 这种全局释放，
 * 各自持有句柄时谁先卸载就把别人的上下文一起废掉，剩下的按钮拿着野句柄去转写。
 * 所以这里按引用计数集中持有：还有按钮挂着就不释放，全都卸载了才还给系统。
 */
let context: WhisperContext | null = null;
let loading: Promise<WhisperContext> | null = null;
let holders = 0;
/** 释放一次加一，用来判断加载途中上下文是不是已经被弃用 */
let generation = 0;

export function retainWhisperContext(): void {
  holders += 1;
}

export function releaseWhisperContext(): void {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return;
  generation += 1;
  context = null;
  loading = null;
  void releaseAllWhisper();
}

/** 上下文是否已经在内存里：预热过就不必再等加载 */
export function isWhisperContextLoaded(): boolean {
  return context !== null;
}

/**
 * 加载并缓存上下文。模型必须已在本地——调用前先用 isModelReady() 判断，
 * 否则 ensureModel 会顺手去下 56.9MB。
 */
export function loadWhisperContext(): Promise<WhisperContext> {
  if (context) return Promise.resolve(context);
  if (loading) return loading;

  const gen = generation;
  const pending = (async () => {
    const model = await ensureModel();
    const loaded = await initWhisper({ filePath: model.uri });
    // 加载途中最后一个按钮卸载了：这份上下文没人要，别留在缓存里占内存
    if (gen !== generation) {
      void releaseAllWhisper();
      throw new Error('语音识别已释放');
    }
    context = loaded;
    return loaded;
  })();

  loading = pending;
  void pending.catch(() => undefined).then(() => {
    if (loading === pending) loading = null;
  });
  return pending;
}
