/**
 * 隔离 userData 的构建：配置、密钥、插件、可选夹具库。
 *
 * 每个用例/文件一份，放在 `e2e/.runs/<name>` 下（已 gitignore）。构造时**不启动应用**，
 * 所以断言失败时可以把这份目录留着复盘。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DESKTOP_DIR, REPO_ROOT } from './app';

export const RUNS_DIR = join(REPO_ROOT, 'e2e', '.runs');
export const BUNDLED_PLUGIN_DIR = join(DESKTOP_DIR, 'resources', 'default-plugins');
export const SOFTWARE_ENGINEERING = 'software-engineering';
export const SE_VERSION = '1.0.0';

export interface EnvOptions {
  /** 桩服务器地址；不给就写一个不可达的地址，用于「没有可用模型」的用例 */
  llmBaseUrl?: string;
  searchEndpoint?: string;
  /** 预置哪些插件（默认软件工程包） */
  plugins?: Array<{ id: string; version: string }>;
  /**
   * 装完插件后是否把「随包分发的默认插件」挡住。
   * 默认在 plugins 为空时挡住——不然启动时的自动安装会把人手布下的空目录填上。
   */
  dismissBundled?: boolean;
  theme?: 'light' | 'dark';
  /** 附带的额外文件（相对 userData 的路径 → 内容） */
  extraFiles?: Record<string, string>;
}

export interface Env {
  name: string;
  userData: string;
  configFile: string;
  secretsFile: string;
  pluginsDir: string;
}

export function makeEnv(name: string, options: EnvOptions = {}): Env {
  const userData = join(RUNS_DIR, name, 'userData');
  rmSync(join(RUNS_DIR, name), { recursive: true, force: true });
  mkdirSync(userData, { recursive: true });

  const plugins = options.plugins ?? [{ id: SOFTWARE_ENGINEERING, version: SE_VERSION }];

  writeFileSync(
    join(userData, 'config.json'),
    `${JSON.stringify(config(options), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(userData, 'secrets.json'),
    // encrypted: false 是应用支持的形态（safeStorage 不可用时的回落），
    // 所以测试不需要碰系统密钥链就能预置 API Key
    JSON.stringify(
      {
        entries: {
          'llm.default': Buffer.from('e2e-key', 'utf8').toString('base64'),
          'search.bocha': Buffer.from('e2e-search-key', 'utf8').toString('base64'),
        },
        encrypted: false,
      },
      null,
      2,
    ),
    'utf8',
  );

  const pluginsDir = join(userData, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  for (const plugin of plugins) installBundledPlugin(pluginsDir, plugin.id, plugin.version);

  // 一个都不装的场景：随包分发的默认插件会在启动时装进来，用卸载记录把它挡住
  const dismiss = options.dismissBundled ?? plugins.length === 0;
  if (dismiss) {
    writeFileSync(
      join(userData, 'dismissed-plugins.json'),
      `${JSON.stringify({ dismissed: [SOFTWARE_ENGINEERING] }, null, 2)}\n`,
      'utf8',
    );
  }

  for (const [relative, content] of Object.entries(options.extraFiles ?? {})) {
    const target = join(userData, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  return {
    name,
    userData,
    configFile: join(userData, 'config.json'),
    secretsFile: join(userData, 'secrets.json'),
    pluginsDir,
  };
}

/**
 * 把随包分发的产物解出来铺进 plugins/<id>@<version>/，与安装入口落盘形状一致。
 *
 * 随包只带默认那一个岗位包（prepare-default-plugins 只铺它），其余包在 dist-plugins/ 下——
 * 需要多个包同时在场的用例（跨岗位页、存量盘面）从那里取。
 */
export function installBundledPlugin(pluginsDir: string, id: string, version: string): void {
  const candidates = [
    join(BUNDLED_PLUGIN_DIR, `${id}@${version}.ojb`),
    join(REPO_ROOT, 'dist-plugins', `${id}@${version}.ojb`),
  ];
  const bundle = candidates.find((path) => existsSync(path));
  if (!bundle) {
    throw new Error(
      `找不到插件产物 ${id}@${version}：${candidates.join(' / ')}（先跑 pnpm pack:plugins）`,
    );
  }
  const target = join(pluginsDir, `${id}@${version}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const parsed = JSON.parse(gunzipSync(readFileSync(bundle)).toString('utf8')) as {
    files: Record<string, string>;
  };
  for (const [file, content] of Object.entries(parsed.files)) {
    writeFileSync(join(target, file), content, 'utf8');
  }
}

/** 把随包分发的产物读成「包内文件 → 内容」，用于篡改后再布下去 */
export function readBundleFiles(bundlePath: string): Record<string, string> {
  const parsed = JSON.parse(gunzipSync(readFileSync(bundlePath)).toString('utf8')) as {
    files: Record<string, string>;
  };
  return parsed.files;
}

export function bundledBundlePath(id: string, version: string): string {
  return join(BUNDLED_PLUGIN_DIR, `${id}@${version}.ojb`);
}

/** 改掉包内某个文件再封回 .ojb：签名与内容对不上，扫描应当把它判成「被篡改」 */
export function tamperBundle(id: string, version: string, file = 'pack.json'): Buffer {
  const files = { ...readBundleFiles(bundledBundlePath(id, version)) };
  files[file] = `${files[file] ?? ''} `;
  return gzipSync(Buffer.from(JSON.stringify({ files }), 'utf8'));
}

/** 把任意 .ojb 摊成 plugins 目录里的一份包（用于篡改/陌生签名等用例） */
export function layDownBundle(pluginsDir: string, fileName: string, raw: Buffer): void {
  const target = join(pluginsDir, fileName.replace(/\.ojb$/, ''));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const parsed = JSON.parse(gunzipSync(raw).toString('utf8')) as { files: Record<string, string> };
  for (const [file, content] of Object.entries(parsed.files)) {
    writeFileSync(join(target, file), content, 'utf8');
  }
}

function config(options: EnvOptions): Record<string, unknown> {
  const unreachable = 'http://127.0.0.1:1/v1';
  return {
    version: 1,
    llm: {
      providers: [
        {
          id: 'default',
          label: 'E2E stub',
          baseUrl: options.llmBaseUrl ?? unreachable,
          apiKeyRef: 'llm.default',
        },
      ],
      tiers: {
        main: { providerId: 'default', model: 'e2e-model' },
        cheap: { providerId: 'default', model: 'e2e-model' },
      },
      roles: { explain: 'cheap' },
      embedding: { providerId: 'default', model: 'e2e-embed' },
    },
    search: {
      providers: {
        bocha: {
          endpoint: options.searchEndpoint ?? 'http://127.0.0.1:1/search',
          apiKeyRef: 'search.bocha',
          enabled: true,
        },
        tavily: { apiKeyRef: 'search.tavily', enabled: false, country: '' },
      },
      routing: [{ match: { lang: 'zh' }, provider: 'bocha' }],
      defaultProvider: 'bocha',
      domainCredibility: { 'example.com': 3, 'docs.example.dev': 4 },
      cacheTtlDays: { companyIntel: 7, interviewReports: 3, techDocs: 30 },
      techDocStaleDays: 540,
    },
    priority: {
      probExp: 1,
      gapExp: 1,
      costExp: 1,
      coverageBoost: { deepDive: 1.2, gap: 1.1, landmine: 1.1, extra: 0.8 },
      targetMastery: { deepDive: 5, gap: 3, landmine: 4, extra: 2 },
    },
    update: { feedUrl: '', checkOnStartup: false },
    ui: { theme: options.theme ?? 'light' },
  };
}

/** 把副本里的 config.json 改掉（用例中途改 provider 之类的场景） */
export function patchConfig(env: Env, patch: (config: Record<string, unknown>) => void): void {
  const current = JSON.parse(readFileSync(env.configFile, 'utf8')) as Record<string, unknown>;
  patch(current);
  writeFileSync(env.configFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

/** 复制一份已有的 userData（夹具库）到新的用例目录 */
export function copyEnv(from: Env, name: string): Env {
  const userData = join(RUNS_DIR, name, 'userData');
  rmSync(join(RUNS_DIR, name), { recursive: true, force: true });
  mkdirSync(join(RUNS_DIR, name), { recursive: true });
  cpSync(from.userData, userData, { recursive: true });
  return {
    name,
    userData,
    configFile: join(userData, 'config.json'),
    secretsFile: join(userData, 'secrets.json'),
    pluginsDir: join(userData, 'plugins'),
  };
}
