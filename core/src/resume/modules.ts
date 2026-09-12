/**
 * 插入点 D 的装配与回填。
 *
 * 抽取只问模型「岗位包声明了、且无法从旧字段派生」的模块——工程包的
 * tech-stack / drillable-tech-topics 都能从 skills / projects 派生，
 * 所以工程岗位的解析 Prompt 与返回结构一个字都不变。
 * 派生发生在解析之后（含读到旧缓存 parse 的场合），展示端永远拿得到数据。
 */

import type { ResumeModuleDefinition, ResumeModuleKind } from '../plugins/types';
import type { ResumeParsed } from '../entities';

/** 模型返回的简历解析结果：通用字段 + 可选的岗位模块容器 */
export type ResumeParsedResponse = ResumeParsed & {
  modules?: Record<string, { schemaVersion: number; data: unknown }>;
};

/** 需要模型抽取的模块：有 deriveFrom 的从旧字段回填，不进 Prompt */
export function modulesNeedingExtraction(
  modules: ResumeModuleDefinition[],
): ResumeModuleDefinition[] {
  return modules.filter((module) => module.deriveFrom === undefined && module.instruction);
}

/**
 * 组进 diagnosis.resume 用户消息的模块抽取段。
 * 用正面表述描述「抽什么」，不罗列禁项——把别的岗位题型写进指令等于先让模型想一遍。
 * 没有需要抽取的模块时返回 null，用户消息保持原文，行为与未挂模块的岗位完全一致。
 */
export function buildResumeModulesUserSection(
  modules: ResumeModuleDefinition[],
): string | null {
  const needed = modulesNeedingExtraction(modules);
  if (needed.length === 0) return null;

  const lines = [
    '## 附加抽取（岗位简历模块）',
    '除基础字段外，在返回 JSON 的 modules 字段里按以下键补充抽取结果，键缺了就用空数组：',
  ];
  for (const module of needed) {
    const shape =
      module.kind === 'list' ? '字符串数组' : module.kind === 'text' ? '一段文字' : '键值对象';
    lines.push(
      `- "${module.id}"（schemaVersion ${module.schemaVersion}，${shape}）：${module.instruction}`,
    );
  }
  return lines.join('\n');
}

/** 按声明类型把模型给的任意值收敛成可渲染的数据；认不出的返回 null */
function normalizeModuleData(
  kind: ResumeModuleKind,
  data: unknown,
): unknown | null {
  if (kind === 'text') {
    return typeof data === 'string' && data.trim() ? data.trim() : null;
  }
  if (kind === 'list') {
    if (!Array.isArray(data)) return null;
    const items = data.filter((item): item is string => typeof item === 'string' && !!item.trim());
    return items.length > 0 ? items : null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const entries = Object.entries(data as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function deriveFromLegacy(
  deriveFrom: 'skills' | 'drillableTopics',
  parsed: ResumeParsed,
): string[] {
  if (deriveFrom === 'skills') return parsed.skills ?? [];
  return (parsed.projects ?? []).flatMap((project) => project.drillableTopics ?? []);
}

/**
 * 组装模块容器：模型抽到的优先，缺的按 deriveFrom 从旧字段回填。
 * 只保留声明过的模块（模型多给的键丢弃），未知 schemaVersion 原样保留交给展示端降级。
 * 一个模块都组不出来时返回 undefined，ResumeParsed 保持旧形态。
 */
export function assembleResumeModules(
  parsed: ResumeParsed,
  declared: ResumeModuleDefinition[],
): ResumeParsed['modules'] {
  if (declared.length === 0) return undefined;
  const extracted = parsed.modules ?? {};
  const result: NonNullable<ResumeParsed['modules']> = {};

  for (const module of declared) {
    const raw = extracted[module.id];
    if (raw !== undefined) {
      // 模型回显的 schemaVersion 不可信，以包声明为准；数据按声明类型收敛
      const data = normalizeModuleData(module.kind, raw.data);
      if (data !== null) {
        result[module.id] = { schemaVersion: module.schemaVersion, data };
      }
      continue;
    }
    if (module.deriveFrom === undefined) continue;
    const data = deriveFromLegacy(module.deriveFrom, parsed);
    if (data.length > 0) {
      result[module.id] = { schemaVersion: module.schemaVersion, data };
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
