/**
 * 岗位包作者工具：defineRolePack 装配入口 + prompts/ 片段文件加载器。
 *
 * **Node 专用，不放 core**：core 同时被 electron-vite 和 Metro 编译，运行时
 * 代码不许碰 I/O。这个模块只被岗位包的 index.ts 引用，而包只会在两处被加载——
 * 测试（vitest node 环境）与打包脚本——永远进不了应用运行时。
 *
 * 作者体验的契约：
 * 1. 在 `prompts/` 下放一个带 frontmatter（slot / 可选 formatId）的 markdown
 *    文件，就是贡献一条片段，index.ts 不用改一行；
 * 2. defineRolePack 就地做契约校验与交叉引用检查，错误带字段路径，
 *    不必理解 resolver 才能发现自己包写错了；
 * 3. 片段 file 与迁移期 ref 互斥，正文由加载器内联进 RolePack——
 *    分发信封（pack.json）因此是自包含的，手机端拿到就能用。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';

import { PluginContractError, validateRolePack } from '@core/plugins/contracts';
import {
  PROMPT_SLOTS,
  type PromptFragment,
  type ResumeModuleDefinition,
  type RolePack,
} from '@core/plugins/types';
import { scanPluginSources } from '@core/plugins/codePlugin/scan';
import { assertPluginFragmentSafe } from '@core/prompts/composer';

export class PackAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackAuthoringError';
  }
}

/** 包根目录：index.ts 里传 `packRoot(import.meta.url)`。 */
export function packRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL('.', importMetaUrl));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FRONTMATTER_KEYS = ['slot', 'formatId'] as const;

/**
 * 解析一个片段文件。frontmatter 只认 `slot` 与可选 `formatId` 两个键，
 * 正文（去掉 frontmatter 后首尾空白）整体作为片段文本，不做任何改写。
 */
export function parsePromptFragmentFile(relPath: string, raw: string): PromptFragment {
  // 函数声明 + 显式 never 返回类型：让 TS 在 `if (!x) fail(...)` 之后收窄 x
  function fail(message: string): never {
    throw new PackAuthoringError(`${relPath}: ${message}`);
  }
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) fail('缺少 frontmatter（--- 包裹的 slot / formatId 声明）');

  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) fail(`frontmatter 行不合法：「${trimmed}」（应为 key: value）`);
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      fail(`未知 frontmatter 键：「${key}」，只支持 ${FRONTMATTER_KEYS.join(' / ')}`);
    }
    if (!value) fail(`frontmatter 键「${key}」的值不能为空`);
    values.set(key, value);
  }

  const slot = values.get('slot');
  if (!slot) fail('frontmatter 缺少 slot');
  if (!(PROMPT_SLOTS as readonly string[]).includes(slot)) {
    fail(`slot「${slot}」不在允许清单：${PROMPT_SLOTS.join(' / ')}`);
  }
  const formatId = values.get('formatId');
  if (formatId !== undefined && !formatId) fail('formatId 不能为空');

  const text = raw.slice(match[0].length).trim();
  if (!text) fail('片段正文为空');

  return {
    slot: slot as PromptFragment['slot'],
    ...(formatId !== undefined ? { formatId } : {}),
    file: relPath.split('\\').join('/'),
    text,
  };
}

function walkMarkdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      found.push(full);
    } else {
      throw new PackAuthoringError(
        `${full}: prompts/ 目录只允许 .md 片段文件，其他文件请放到别处`,
      );
    }
  }
  return found;
}

/**
 * 扫描岗位包的 prompts/ 目录，返回带正文的片段列表。
 * 目录不存在视为「本包不贡献片段」（迁移期只写 ref 的包），显式指定的路径不存在才报错。
 */
export function loadPromptFragments(
  root: string,
  promptsDir?: string,
  explicit = false,
): PromptFragment[] {
  const dir = promptsDir ? (isAbsolute(promptsDir) ? promptsDir : join(root, promptsDir)) : join(root, 'prompts');
  if (!existsSync(dir)) {
    if (explicit) {
      throw new PackAuthoringError(`promptsDir 不存在：${dir}`);
    }
    return [];
  }
  return walkMarkdownFiles(dir).map((full) => {
    const relPath = relative(root, full).split('\\').join('/');
    return parsePromptFragmentFile(relPath, readFileSync(full, 'utf8'));
  });
}

/** 代码资产上限：入口 + Webview 资源是逻辑代码，不是分发媒体的渠道 */
const CODE_ASSET_MAX_LENGTH = 2_000_000;

/** 读入 manifest.main 声明的代码资产并跑隔离扫描；违规在装配期就拦下 */
function loadCodeAssets(root: string): Record<string, string> | undefined {
  const mainPath = join(root, 'main.js');
  if (!existsSync(mainPath)) return undefined;
  const assets: Record<string, string> = { 'main.js': readFileSync(mainPath, 'utf8') };
  const uiDir = join(root, 'ui');
  if (existsSync(uiDir)) {
    for (const entry of readdirSync(uiDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory()) {
        throw new PackAuthoringError(`ui/ 目前不支持子目录：ui/${entry.name}`);
      }
      assets[`ui/${entry.name}`] = readFileSync(join(uiDir, entry.name), 'utf8');
    }
  }
  for (const [path, text] of Object.entries(assets)) {
    if (text.length > CODE_ASSET_MAX_LENGTH) {
      throw new PackAuthoringError(`${path}: 代码资产超过 ${CODE_ASSET_MAX_LENGTH} 字符上限`);
    }
    for (const violation of scanPluginSources({ [path]: text })) {
      throw new PackAuthoringError(`${violation.path}: 静态隔离扫描未通过——${violation.reason}`);
    }
  }
  return assets;
}

export interface DefineRolePackInput extends Omit<RolePack, 'promptFragments' | 'resumeModules'> {
  /** 包根目录，用于定位 prompts/ 与计算片段的相对路径。 */
  root: string;
  /**
   * 显式片段（迁移期 ref 引用宿主 promptId 时用）。与 promptsDir 扫描结果合并，
   * 合并后的去重与交叉引用交给 validateRolePack。
   */
  promptFragments?: PromptFragment[];
  /** 片段目录，默认 root/prompts；显式传入但不存在时直接报错。 */
  promptsDir?: string;
  /** 插入点 D：简历模块声明，缺省为空。 */
  resumeModules?: ResumeModuleDefinition[];
}

/** 简历模块抽取指令的长度上限：指令只描述「抽什么」，长文本属于 Prompt 片段 */
const RESUME_MODULE_INSTRUCTION_LIMIT = 2000;

/** 读入 extractionPromptFile 并对每条指令跑 Prompt 片段的静态安全检查。 */
function loadResumeModules(root: string, modules: ResumeModuleDefinition[]): ResumeModuleDefinition[] {
  return modules.map((module) => {
    if (module.extractionPromptFile === undefined) {
      const instruction = module.instruction;
      if (instruction !== undefined) {
        assertPluginFragmentSafe(
          instruction,
          `简历模块 ${module.id} 的抽取指令`,
          RESUME_MODULE_INSTRUCTION_LIMIT,
        );
      }
      return module;
    }
    const full = isAbsolute(module.extractionPromptFile)
      ? module.extractionPromptFile
      : join(root, module.extractionPromptFile);
    const text = readFileSync(full, 'utf8').trim();
    if (!text) {
      throw new PackAuthoringError(`${module.extractionPromptFile}: 指令文件内容为空`);
    }
    assertPluginFragmentSafe(
      text,
      `简历模块 ${module.id} 的指令文件 ${module.extractionPromptFile}`,
      RESUME_MODULE_INSTRUCTION_LIMIT,
    );
    const { extractionPromptFile, ...rest } = module;
    return { ...rest, instruction: text, extractionPromptFile };
  });
}

/**
 * 岗位包唯一装配入口：扫描片段文件 → 组装 RolePack → 就地契约校验。
 * 任何契约或交叉引用错误在这里带着字段路径抛出，不等运行期 resolver。
 */
export function defineRolePack(input: DefineRolePackInput): RolePack {
  const { root, promptsDir, promptFragments, resumeModules, ...pack } = input;
  const fragments = [
    ...loadPromptFragments(root, promptsDir, promptsDir !== undefined),
    ...(promptFragments ?? []),
  ];
  const result: RolePack = {
    ...pack,
    promptFragments: fragments,
    resumeModules: loadResumeModules(root, resumeModules ?? []),
    // 代码入口声明了就必带资产（隔离扫描内联前完成）；纯声明式包无此字段
    codeAssets: loadCodeAssets(root),
  };
  const issues = validateRolePack(result);
  if (issues.length > 0) {
    throw new PluginContractError(issues);
  }
  return result;
}
