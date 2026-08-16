import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import { env, pipeline } from '@huggingface/transformers';
import type { AutomaticSpeechRecognitionPipeline, ProgressInfo } from '@huggingface/transformers';
import type { SttStatus } from '@shared/ipc';
import { emit } from '../ipc/bridge';

/**
 * 本地离线语音转写（Whisper via transformers.js，WASM 后端）。
 *
 * 设计要点：
 * - 模型懒加载：首次 transcribe 时才下载/加载 whisper-base（q8，约 73MB），
 *   平时不占内存，状态经 `stt:status` 事件推给渲染进程。
 * - 国内下载：gh-proxy 代理 HF 请求；Xet 大文件重定向被代理拦截返回 403，
 *   响应体含真实 CDN URL，提取后直连（已实证可跑通）。
 * - 模型缓存到 userData/stt-models，二次启动离线可用。
 * - 转写串行执行（单一 pipeline 实例，避免并发推理冲突）。
 */

const MODEL_ID = 'Xenova/whisper-base';
const MODEL_DTYPE = 'q8';
const HF_PREFIX = 'https://huggingface.co/';
const PROXY_PREFIX = 'https://gh-proxy.com/';

const nativeFetch = globalThis.fetch;

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let currentStatus: SttStatus = { state: 'idle' };
/** 串行队列：上一次转写完成后才执行下一次 */
let transcribeQueue: Promise<unknown> = Promise.resolve();

function setStatus(status: SttStatus): void {
  currentStatus = status;
  emit('stt:status', status);
}

export function getSttStatus(): SttStatus {
  return currentStatus;
}

/** 一次性配置 transformers.js 运行环境（wasm 路径 / 缓存 / 国内下载代理） */
function configureEnv(): void {
  const require = createRequire(import.meta.url);
  const transformersDir = dirname(require.resolve('@huggingface/transformers'));
  const ortRequire = createRequire(join(transformersDir, 'noop.js'));
  let ortWebDist = dirname(ortRequire.resolve('onnxruntime-web'));

  if (app.isPackaged) {
    // 打包后 node_modules 在 asar 内，file:// 读不到 asar 虚拟路径；
    // asarUnpack 会把 wasm/mjs 落到 app.asar.unpacked，这里改写指向实体文件
    ortWebDist = ortWebDist.replace('app.asar', 'app.asar.unpacked');
  }

  // wasm 属性本身只读，但其 wasmPaths 字段可变；transformers 运行时必会初始化该对象
  const wasmFlags = env.backends.onnx.wasm;
  if (wasmFlags) {
    wasmFlags.wasmPaths = {
      mjs: pathToFileURL(join(ortWebDist, 'ort-wasm-simd-threaded.mjs')).href,
      wasm: pathToFileURL(join(ortWebDist, 'ort-wasm-simd-threaded.wasm')).href,
    };
  }

  // 模型缓存在用户数据目录，二次启动离线可用
  env.cacheDir = join(app.getPath('userData'), 'stt-models');
  env.allowRemoteModels = true;
  env.remoteHost = HF_PREFIX;
  // 关闭 wasm 预缓存探测：Node 下 file:// 的探测会报 undici 不支持，纯噪音
  env.useWasmCache = false;

  // 国内下载：HF 请求走 gh-proxy；403（Xet 重定向被拦截）时提取真实 CDN 直连
  env.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    if (!urlStr.startsWith(HF_PREFIX)) return nativeFetch(input, init);

    const res = await nativeFetch(PROXY_PREFIX + urlStr, init);
    if (res.status === 403) {
      const body = await res.text();
      const line = body.split('\n').find((l) => l.includes('Redirect to a disallowed URL'));
      if (line) {
        const xetUrl = line.replace('Redirect to a disallowed URL was blocked: ', '').trim();
        return nativeFetch(xetUrl, init);
      }
    }
    return res;
  };
}

/** 获取（或首次懒加载）Whisper pipeline，失败可重试 */
function getPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (pipelinePromise) return pipelinePromise;

  configureEnv();
  setStatus({ state: 'loading' });

  pipelinePromise = pipeline('automatic-speech-recognition', MODEL_ID, {
    dtype: MODEL_DTYPE,
    progress_callback: (p: ProgressInfo) => {
      // 整体下载进度 0-100（progress_total），换算成 0-1 推给 UI
      if (p.status === 'progress_total') {
        setStatus({ state: 'loading', progress: p.progress / 100 });
      }
    },
  })
    .then((p) => {
      setStatus({ state: 'ready' });
      return p;
    })
    .catch((err: unknown) => {
      // 失败置空，允许下一次 transcribe 重新加载
      pipelinePromise = null;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ state: 'error', error: message });
      throw err;
    });

  return pipelinePromise;
}

/**
 * 转写一段 16kHz 单声道 Float32 PCM 音频。
 * 串行排队执行；模型未加载时先触发下载/加载。
 */
export function transcribe(audio: Float32Array): Promise<string> {
  const run = transcribeQueue.then(async () => {
    const transcriber = await getPipeline();
    const result = await transcriber(audio, { language: 'chinese' });
    return typeof result === 'string' ? result : result.text;
  });
  // 队列吞掉错误（调用方拿到 rejection），避免卡住后续请求
  transcribeQueue = run.catch(() => undefined);
  return run;
}