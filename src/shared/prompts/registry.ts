/**
 * Prompt 注册表：系统里所有 LLM prompt 的唯一事实源。
 *
 * 目的：
 * 1. 收拢散落在 main/mobile 的内联 prompt，消除 main/shared 的重复副本
 * 2. 每个 prompt 有稳定 id 与版本列表，支持 AB 实验（换版本只改注册表，不动调用点）
 * 3. 调用方只说「我要哪个 prompt」，不直接持有文本
 *
 * 版本约定：`promptId@vN`。新增版本时在 versions 数组里追加并写清 note；
 * 未开启实验时永远取 versions[0]（行为与改注册表前完全一致）。
 */

import type { ExplanationTier } from '@shared/enums';
import {
  EXPAND_SYSTEM,
  INTEL_SYSTEM,
  JD_SYSTEM,
  REPORT_EXTRACT_SYSTEM,
  RESUME_SYSTEM,
  crossAnalyzeSystem,
} from '../diagnosis/prompts';
import {
  answerSystemForType,
  caseSystemForType,
  scoreSystemForType,
  type MockInterviewKind,
  type MockInterviewLanguage,
  type MockInterviewType,
} from '../design/prompts';
import {
  RESUME_OPTIMIZE_SYSTEM,
  RESUME_POLISH_SYSTEM,
  RESUME_STRUCTURE_SYSTEM,
} from '../resume/prompts';
import { QUIZ_QUESTION_SYSTEM, QUIZ_SCORE_SYSTEM } from './quiz';
import {
  EXPLAIN_ELABORATE_SYSTEM,
  EXPLAIN_REWRITE_SYSTEM,
  buildExplainFallbackSystem,
  buildExplainGenerateSystem,
} from './explain';
import { COMPRESS_SYSTEM } from './compress';
import { MATCH_SYSTEM } from './ingest';
import { REPO_SUMMARY_SYSTEM, buildRepoAnalyzeSystem } from './repo';

export interface PromptVersion {
  /** 版本 id，形如 'quiz.question@v1' */
  id: string;
  /** 版本说明：本次改了什么（AB 实验标签用） */
  note?: string;
  /** 静态文本版本 */
  text?: string;
  /** 动态构建版本（explain 按档位、design 按题型等运行时才能确定的拼接） */
  build?: (params: Record<string, string | undefined>) => string;
}

export interface PromptEntry {
  /** promptId，如 'quiz.question' */
  id: string;
  versions: PromptVersion[];
}

export interface ResolvedPrompt {
  promptId: string;
  versionId: string;
  text: string;
}

/** AB 实验配置：promptId → 是否开启 + 新版流量占比 */
export interface PromptExperiment {
  /** 是否开启分流（false 时所有调用取 v1） */
  enabled: boolean;
  /** 分到新版的流量占比 0-1，默认 0.5；其余流量走 v1 */
  split?: number;
}

export type PromptExperimentConfig = Record<string, PromptExperiment>;

/** 全部 prompt 的登记处：新增/改版只动这里，调用点永远说 promptId */
export const PROMPT_REGISTRY: Record<string, PromptEntry> = {
  // ── 诊断（文本来自 shared/diagnosis/prompts，原本就是双端唯一事实源）──
  'diagnosis.jd': {
    id: 'diagnosis.jd',
    versions: [{ id: 'diagnosis.jd@v1', text: JD_SYSTEM, note: '初始版本' }],
  },
  'diagnosis.resume': {
    id: 'diagnosis.resume',
    versions: [{ id: 'diagnosis.resume@v1', text: RESUME_SYSTEM, note: '初始版本' }],
  },
  'diagnosis.crossAnalyze': {
    id: 'diagnosis.crossAnalyze',
    versions: [
      { id: 'diagnosis.crossAnalyze@v1', text: crossAnalyzeSystem(), note: '初始版本' },
    ],
  },
  'diagnosis.expand': {
    id: 'diagnosis.expand',
    versions: [{ id: 'diagnosis.expand@v1', text: EXPAND_SYSTEM, note: '初始版本' }],
  },
  'diagnosis.intel': {
    id: 'diagnosis.intel',
    versions: [{ id: 'diagnosis.intel@v1', text: INTEL_SYSTEM, note: '初始版本' }],
  },
  'diagnosis.extractQuestions': {
    id: 'diagnosis.extractQuestions',
    versions: [
      { id: 'diagnosis.extractQuestions@v1', text: REPORT_EXTRACT_SYSTEM, note: '初始版本' },
    ],
  },
  'diagnosis.matchQuestions': {
    id: 'diagnosis.matchQuestions',
    versions: [{ id: 'diagnosis.matchQuestions@v1', text: MATCH_SYSTEM, note: '初始版本' }],
  },

  // ── 讲解（原 main/explain 与 mobile/explainGen 各自内联，收拢为 shared）──
  'explain.generate': {
    id: 'explain.generate',
    versions: [
      {
        id: 'explain.generate@v1',
        build: (p) => buildExplainGenerateSystem(p.tier as ExplanationTier, p.instruction),
        note: '初始版本',
      },
    ],
  },
  'explain.fallback': {
    id: 'explain.fallback',
    versions: [
      {
        id: 'explain.fallback@v1',
        build: (p) => buildExplainFallbackSystem(p.instruction),
        note: '初始版本',
      },
    ],
  },
  'explain.elaborate': {
    id: 'explain.elaborate',
    versions: [
      { id: 'explain.elaborate@v1', text: EXPLAIN_ELABORATE_SYSTEM, note: '初始版本' },
    ],
  },
  'explain.rewrite': {
    id: 'explain.rewrite',
    versions: [
      { id: 'explain.rewrite@v1', text: EXPLAIN_REWRITE_SYSTEM, note: '初始版本' },
    ],
  },

  // ── 考我（两端同文本，收拢为 shared）──
  'quiz.question': {
    id: 'quiz.question',
    versions: [{ id: 'quiz.question@v1', text: QUIZ_QUESTION_SYSTEM, note: '初始版本' }],
  },
  'quiz.score': {
    id: 'quiz.score',
    versions: [{ id: 'quiz.score@v1', text: QUIZ_SCORE_SYSTEM, note: '初始版本' }],
  },

  // ── 模拟面试（文本来自 shared/design/prompts，按题型运行时选择）──
  'design.case': {
    id: 'design.case',
    versions: [
      {
        id: 'design.case@v1',
        build: (p) => caseSystemForType(p.type as MockInterviewType),
        note: '初始版本',
      },
    ],
  },
  'design.score': {
    id: 'design.score',
    versions: [
      {
        id: 'design.score@v1',
        build: (p) =>
          scoreSystemForType(
            p.type as MockInterviewKind,
            (p.language as MockInterviewLanguage | undefined) ?? 'zh',
          ),
        note: '初始版本',
      },
    ],
  },
  'design.answer': {
    id: 'design.answer',
    versions: [
      {
        id: 'design.answer@v1',
        build: (p) =>
          answerSystemForType(
            p.type as MockInterviewKind,
            (p.language as MockInterviewLanguage | undefined) ?? 'zh',
          ),
        note: '初始版本',
      },
    ],
  },

  // ── 简历（文本来自 shared/resume/prompts）──
  'resume.optimize': {
    id: 'resume.optimize',
    versions: [{ id: 'resume.optimize@v1', text: RESUME_OPTIMIZE_SYSTEM, note: '初始版本' }],
  },
  'resume.structure': {
    id: 'resume.structure',
    versions: [{ id: 'resume.structure@v1', text: RESUME_STRUCTURE_SYSTEM, note: '初始版本' }],
  },
  'resume.polish': {
    id: 'resume.polish',
    versions: [{ id: 'resume.polish@v1', text: RESUME_POLISH_SYSTEM, note: '初始版本' }],
  },

  // ── 上下文压缩（原 main/llm/compress 内联）──
  'compress.forContext': {
    id: 'compress.forContext',
    versions: [{ id: 'compress.forContext@v1', text: COMPRESS_SYSTEM, note: '初始版本' }],
  },

  // ── 仓库（原 main/repo/repository 与 main/llm/index startChat 内联）──
  'repo.summary': {
    id: 'repo.summary',
    versions: [{ id: 'repo.summary@v1', text: REPO_SUMMARY_SYSTEM, note: '初始版本' }],
  },
  'repo.analyze': {
    id: 'repo.analyze',
    versions: [
      {
        id: 'repo.analyze@v1',
        build: (p) =>
          buildRepoAnalyzeSystem(p.url ?? '', p.summaryMd ?? '（无）', p.repoMapMd ?? ''),
        note: '初始版本',
      },
    ],
  },
};

/**
 * 稳定分流：同一 promptId + 同一指纹永远分到同一组。
 * djb2 哈希取模——换指纹/换 promptId 才可能跳组，设备固定则组固定。
 */
export function stableVariant(promptId: string, fingerprint: string, groupCount: number): number {
  const key = `${promptId}\u0000${fingerprint}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
  }
  return hash % groupCount;
}

/**
 * 取指定 prompt 当前生效的版本文本。
 *
 * @param promptId 注册表条目 id
 * @param params build 版本所需的参数（text 版本忽略）
 * @param experiment 实验配置：enabled 且有 ≥2 个版本时按 stableVariant 分流
 * @param fingerprint 分流指纹（设备 id 等稳定标识），仅在 experiment.enabled 时使用
 */
export function resolvePrompt(
  promptId: string,
  params?: Record<string, string | undefined>,
  experiment?: PromptExperiment,
  fingerprint?: string,
): ResolvedPrompt {
  const entry = PROMPT_REGISTRY[promptId];
  if (!entry) {
    throw new Error(`未注册的 prompt：${promptId}，请在 src/shared/prompts/ 下登记`);
  }

  let version = entry.versions[0]!;
  const wantExperiment =
    experiment?.enabled && entry.versions.length >= 2 && fingerprint !== undefined;
  if (wantExperiment) {
    const split = experiment.split ?? 0.5;
    const group = stableVariant(promptId, fingerprint, 100);
    const useNew = group < split * 100;
    version = useNew ? entry.versions[entry.versions.length - 1]! : entry.versions[0]!;
  }

  const text = version.build ? version.build(params ?? {}) : version.text;
  if (text === undefined) {
    throw new Error(`prompt ${version.id} 既没有 text 也没有 build`);
  }

  return { promptId, versionId: version.id, text };
}