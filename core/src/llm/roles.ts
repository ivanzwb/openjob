/**
 * LLM 角色的归属与汇总。
 *
 * 角色分两类：
 *
 * 1. **基础角色**（BASE_LLM_ROLES）：基础 Agent 自己的链路（大纲、讲解、出题、简历优化），
 *    任何岗位都可能用到，所以说明文案也写在基础包里；
 * 2. **岗位角色**：由岗位包在自己的能力声明里声明（CapabilityDeclaration.llmRoles），
 *    角色名与用途说明一起归包所有——基础包不认识「软件开发岗位用什么角色」。
 *
 * 这里只做搬运与去重：合成一份「本机有效的角色清单」给设置页与运行时查。角色 → 档位
 * 的映射落在 core/src/config.ts 的 llm.roles，未声明的角色一律落 main 档。
 */
import { BASE_LLM_ROLES, type BaseLlmRole } from '../enums';

/** 岗位包在能力声明里声明的角色。 */
export interface LlmRoleDeclaration {
  /** 运行时角色名，也是 llm.roles 映射的 key；如 codeAgent */
  name: string;
  /** 设置页展示的用途说明；由声明它的包提供，基础包不代写 */
  hint?: string;
}

/** 某个已安装包为某个能力声明的角色。 */
export interface LlmRoleContribution {
  role: LlmRoleDeclaration;
  /** 声明它的插件 id，用于在设置页标出来源 */
  pluginId: string;
}

/** 设置页展示所需的一条角色。 */
export interface LlmRoleView {
  name: string;
  hint: string | null;
  /** 基础角色为 null；岗位角色为声明它的插件 id */
  sourcePluginId: string | null;
}

/**
 * 角色名的形状。
 *
 * 同时用于岗位包声明期的契约校验：名字会进 config.json 当 key、会进审计记录，
 * 所以不接受空白、标点与路径字符。
 */
export const LLM_ROLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export function isValidLlmRoleName(name: unknown): name is string {
  return typeof name === 'string' && LLM_ROLE_NAME_PATTERN.test(name);
}

/** 基础角色的用途说明。原来写死在设置页里，随角色定义一起挪到基础包里。 */
export const BASE_LLM_ROLE_HINTS: Record<BaseLlmRole, string> = {
  outline: '生成知识图谱大纲，需要结构化能力，用量小',
  explain: '生成三档讲解，调用最频繁，是成本大头',
  quiz: '出题与评分，需要稳定的评判尺度',
  resumeOptimize: '简历定向优化：仅基于母版改写表述与结构，不编造事实',
};

/**
 * 合成有效角色清单：基础角色在前（按 BASE_LLM_ROLES 的顺序），包声明的角色按名字排序在后面。
 *
 * 同名以基础角色为准——包声明的角色不能顶替基础角色的说明与归属。
 */
export function collectLlmRoles(
  declared: readonly LlmRoleContribution[] = [],
): LlmRoleView[] {
  const base: LlmRoleView[] = BASE_LLM_ROLES.map((name) => ({
    name,
    hint: BASE_LLM_ROLE_HINTS[name],
    sourcePluginId: null,
  }));

  const seen = new Set<string>(BASE_LLM_ROLES);
  const extra: LlmRoleView[] = [];
  for (const item of declared) {
    if (seen.has(item.role.name)) continue;
    seen.add(item.role.name);
    extra.push({
      name: item.role.name,
      hint: item.role.hint ?? null,
      sourcePluginId: item.pluginId,
    });
  }

  extra.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return [...base, ...extra];
}
