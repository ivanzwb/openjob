import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { PromptExperiment, PromptExperimentConfig } from '@shared/prompts/registry';

/**
 * Prompt AB 实验开关。持久化到 <userData>/experiments.json。
 *
 * 刻意独立于 config.json：
 * 1. 实验配置是「调试/灰度」语义，不该出现在同步给手机的 app_setting 里；
 * 2. 结构简单（promptId → { enabled, split }），不值得进主配置的深合并。
 *
 * 不写不读都静默：文件缺失/损坏按「全部关闭」处理，实验永远是可选的旁路。
 */

let cache: PromptExperimentConfig | null = null;

function file(): string {
  return join(app.getPath('userData'), 'experiments.json');
}

function sanitize(loaded: unknown): PromptExperimentConfig {
  if (!loaded || typeof loaded !== 'object') return {};
  const out: PromptExperimentConfig = {};
  for (const [promptId, raw] of Object.entries(loaded as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const exp = raw as Partial<PromptExperiment>;
    out[promptId] = {
      enabled: exp.enabled === true,
      ...(typeof exp.split === 'number' && exp.split > 0 && exp.split < 1
        ? { split: exp.split }
        : {}),
    };
  }
  return out;
}

export function getExperiments(): PromptExperimentConfig {
  if (cache) return cache;
  try {
    if (existsSync(file())) {
      cache = sanitize(JSON.parse(readFileSync(file(), 'utf8')));
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

export function getExperiment(promptId: string): PromptExperiment | undefined {
  return getExperiments()[promptId];
}

/** 写入实验配置并刷新缓存。返回合并后的完整配置。 */
export function updateExperiments(next: PromptExperimentConfig): PromptExperimentConfig {
  const merged = { ...getExperiments(), ...next };
  cache = merged;
  writeFileSync(file(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}