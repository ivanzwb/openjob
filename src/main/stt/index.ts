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
 * - 国内下载：gh-proxy / hf-mirror 多源回退；Xet 大文件重定向被代理拦截返回 403，
 *   响应体含真实 CDN URL，提取后仍须走同一套回退（否则 CDN 直连常遇 http3 403）。
 * - env.fetch 须手动跟重定向：默认 fetch 跟到 cdn-lfs*.hf.co 时不再经过本包装器。
 * - 模型缓存到 userData/stt-models，二次启动离线可用。
 * - 转写串行执行（单一 pipeline 实例，避免并发推理冲突）。
 */

const MODEL_ID = 'Xenova/whisper-base';
const MODEL_DTYPE = 'q8';
const HF_PREFIX = 'https://huggingface.co/';
const PROXY_PREFIX = 'https://gh-proxy.com/';
const HF_MIRROR_PREFIX = 'https://hf-mirror.com/';

const nativeFetch = globalThis.fetch;
const MAX_REDIRECT_HOPS = 12;

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let currentStatus: SttStatus = { state: 'idle' };
/** 串行队列：上一次转写完成后才执行下一次 */
let transcribeQueue: Promise<unknown> = Promise.resolve();

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setStatus(status: SttStatus): void {
  currentStatus = status;
  emit('stt:status', status);
}

export function getSttStatus(): SttStatus {
  return currentStatus;
}

function isHfRelatedUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co');
  } catch {
    return false;
  }
}

/** 把 hub resolve 或 CDN 快照 URL 翻成 hf-mirror 直链 */
function hfMirrorResolveUrl(urlStr: string): string | null {
  const hub = urlStr.match(/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+?)(?:\?|$)/);
  if (hub) return `${HF_MIRROR_PREFIX}${hub[1]}/resolve/${hub[2]}/${hub[3]}`;

  const cdn = urlStr.match(/hf\.co\/repos\/[^/]+\/[^/]+\/([^/]+\/[^/]+)\/snapshots\/[^/]+\/(.+?)(?:\?|$)/);
  if (cdn) return `${HF_MIRROR_PREFIX}${cdn[1]}/resolve/main/${cdn[2]}`;

  return null;
}

function candidatesFor(urlStr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string): void => {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };

  if (urlStr.startsWith(HF_PREFIX)) {
    push(`${PROXY_PREFIX}${urlStr}`);
    push(`${HF_MIRROR_PREFIX}${urlStr.slice(HF_PREFIX.length)}`);
    push(urlStr);
  } else if (isHfRelatedUrl(urlStr)) {
    const mirror = hfMirrorResolveUrl(urlStr);
    if (mirror) push(mirror);
    push(urlStr);
  } else {
    push(urlStr);
  }
  return out;
}

function extractFollowUpUrl(body: string): string | null {
  const xetLine = body.split('\n').find((l) => l.includes('Redirect to a disallowed URL'));
  if (xetLine) {
    return xetLine.replace('Redirect to a disallowed URL was blocked: ', '').trim();
  }
  const match = body.match(/https:\/\/[^\s"'<>]+/);
  return match?.[0] ?? null;
}

async function fetchWithFallbacks(urlStr: string, init?: RequestInit, hop = 0): Promise<Response> {
  if (hop > MAX_REDIRECT_HOPS) {
    throw new Error('下载本地语音模型失败：重定向次数过多');
  }

  const manualInit: RequestInit = { ...init, redirect: 'manual' };
  const failures: string[] = [];

  for (const candidate of candidatesFor(urlStr)) {
    try {
      const res = await nativeFetch(candidate, manualInit);

      if (res.status === 403) {
        const body = await res.text();
        const followUp = extractFollowUpUrl(body);
        if (followUp) {
          return fetchWithFallbacks(followUp, init, hop + 1);
        }
        failures.push(`${candidate}: HTTP 403`);
        continue;
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return res;
        const next = new URL(location, candidate).href;
        return fetchWithFallbacks(next, init, hop + 1);
      }

      return res;
    } catch (err) {
      failures.push(`${candidate}: ${asErrorMessage(err)}`);
    }
  }

  throw new Error(`下载本地语音模型失败，请检查网络或代理。${failures.join('；')}`);
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

  env.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    if (!isHfRelatedUrl(urlStr) && !urlStr.startsWith(HF_PREFIX)) {
      return nativeFetch(input, init);
    }
    return fetchWithFallbacks(urlStr, init);
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
      const message = asErrorMessage(err);
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
