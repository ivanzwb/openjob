import { describe, expect, it } from 'vitest';
import { PROMPT_REGISTRY } from '@core/prompts/registry';
import { validateRolePack } from '@core/plugins/contracts';
import {
  activatePluginRuntime,
  createEventHub,
  type PluginRuntimeModule,
  type PluginRuntimeServices,
} from '@core/plugins/pluginRuntime/host';
import type { CampaignRuntimeDescriptor } from '@core/plugins/types';
import {
  SOFTWARE_ENGINEERING_PROMPT_REFS,
  SOFTWARE_ENGINEERING_ROLE_PACK_ID,
  softwareEngineeringRolePack,
} from './index';
import { activate as desktopActivate } from './desktop/main';
import { activate as mobileActivate } from './mobile/main';

function leafStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(leafStrings);
}

/** 最小可用运行时服务：两端入口只注册页面与桥方法，不碰宿主任何服务。 */
function runtimeServices(): PluginRuntimeServices {
  return {
    campaign: { getDescriptor: async () => null as CampaignRuntimeDescriptor | null },
    storage: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    },
    data: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
      count: async () => 0,
    },
  };
}

/** 用最小运行时激活某一端入口（desktop/main.ts / mobile/main.ts），拿到页面与桥方法声明。 */
function activateEntry(activate: PluginRuntimeModule['activate']) {
  return activatePluginRuntime({
    pluginId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
    version: softwareEngineeringRolePack.manifest.version,
    module: { activate },
    services: runtimeServices(),
    hub: createEventHub(),
  });
}

describe('softwareEngineeringRolePack contract', () => {
  it('passes the T01 RolePack validator', () => {
    expect(validateRolePack(softwareEngineeringRolePack)).toEqual([]);
  });

  it('keeps the stable runtime identity and role-pack permission boundary', () => {
    // 版本随包内容走，不在这里写死字面量：内容换代就该升版本，否则已装的同 id 同版本
    // 会被当成同一份包沿用旧内容
    expect(softwareEngineeringRolePack.manifest).toMatchObject({
      id: 'software-engineering',
      type: 'role-pack',
      compatibility: { core: '^1.0.0', schema: 23 },
      // 本包页面自己用到的通用原语（工作区 + 远端拉取 + 话术库）与基础问答。权限 = 内嵌
      // source-repository 声明的并集；该声明不声明任何工具，所以权限里没有工具带来的项。
      permissions: ['filesystem:workspace', 'library:write', 'llm:complete', 'network:fetch'],
      dependencies: [],
    });
  });

  it('源码能力声明它用到的 LLM 角色：角色名与用途都归本包所有', () => {
    const repo = softwareEngineeringRolePack.capabilities.find(
      (declaration) => declaration.id === 'source-repository',
    );

    expect(repo?.llmRoles).toEqual([{ name: 'codeAgent', hint: expect.any(String) }]);
  });

  it('references registered prompts without embedding prompt bodies', () => {
    const documentedRefs = leafStrings(SOFTWARE_ENGINEERING_PROMPT_REFS);
    // 插入点 B 目前是迁移期：片段全部用显式 ref 引用宿主注册表
    const activeRefs = softwareEngineeringRolePack.promptFragments
      .map((fragment) => fragment.ref)
      .filter((ref): ref is string => ref !== undefined);

    expect(activeRefs.length).toBeGreaterThan(0);
    for (const ref of activeRefs) {
      expect(documentedRefs).toContain(ref);
    }

    for (const promptId of [...documentedRefs, ...activeRefs]) {
      expect(PROMPT_REGISTRY[promptId], `missing prompt registry key: ${promptId}`).toBeDefined();
      expect(promptId).toMatch(/^[a-z][A-Za-z]*(?:\.[A-Za-z][A-Za-z]*)+$/);
      expect(promptId).not.toContain('\n');
    }
  });

  it('两端入口各注册「源码」页，deactivate 后撤干净', () => {
    for (const activate of [desktopActivate, mobileActivate]) {
      const active = activateEntry(activate);
      expect(active.pages).toEqual([
        {
          pluginId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
          fullId: `${SOFTWARE_ENGINEERING_ROLE_PACK_ID}:source-repository`,
          id: 'source-repository',
          title: '源码',
          webviewPath: 'ui/repositories.html',
        },
      ]);
      active.deactivate();
      expect(active.pages).toEqual([]);
    }
  });

  it('桥自注册：桌面声明页面用到的全部通用原语，手机只读同一份数据', () => {
    // 「源码」页编排的全是通用原语：工作区（浏览 / 读 / glob / grep / 符号 / 远端拉取）、
    // 本包声明的数据集合读写、基础流式问答，以及建索引用的受控补全。声明只决定「能不能到网关」。
    const desktop = activateEntry(desktopActivate);
    expect(desktop.bridgeMethods).toEqual([
      'workspace.fetch',
      'workspace.delete',
      'workspace.glob',
      'workspace.list',
      'workspace.read',
      'workspace.grep',
      'workspace.symbols',
      'data.list',
      'data.get',
      'data.put',
      'data.delete',
      'llm.complete',
      'agent.ask',
      // 用户的话术库：存 / 取都按本包自己的来源类型（code-ref），宿主不认识
      'library.saveSnippet',
      'library.listSnippets',
      // 标记面：本包自己的目标类型（code-mark）写进宿主跨功能的标记汇总，并取回 / 删掉
      'library.annotate',
      'library.listAnnotations',
      'library.deleteAnnotation',
    ]);

    // 手机端几乎只能读：数据集合、配对桌面的工作区读侧、基础问答、话术库存（落进同步库）与
    // 标记读侧；标记写 / 删不声明
    const mobile = activateEntry(mobileActivate);
    expect(mobile.bridgeMethods).toEqual([
      'data.list',
      'workspace.list',
      'workspace.read',
      'agent.ask',
      'library.saveSnippet',
      'library.listSnippets',
      'library.listAnnotations',
    ]);
  });

  it('声明代码位置标记的路由：code-mark 由本包的「源码」页承接', () => {
    // 宿主按 manifest.annotationTargets 把汇总面板里包自己起的 kind 路由回承接页面；
    // pageId 必须是两端入口都注册过的那一个（见上面的「两端入口各注册源码页」用例）。
    expect(softwareEngineeringRolePack.manifest.annotationTargets).toEqual([
      { kind: 'code-mark', label: '代码位置', pageId: 'source-repository' },
    ]);
  });

  it('桌面页调用到的标记/话术原语都在声明里（声明 == 调用面）', () => {
    // 页面里写标记改走 library.annotate，读回走 library.listAnnotations；两者都必须声明
    const desktop = activateEntry(desktopActivate);
    expect(desktop.bridgeMethods).toContain('library.annotate');
    expect(desktop.bridgeMethods).toContain('library.listAnnotations');
    desktop.deactivate();
  });

  it('数据集合随包声明：登记表、问答历史与索引产物都在 manifest 里', () => {
    // 代码位置标记不再放在本包自己的集合里（改走宿主的标记原语 library.annotate）
    expect(
      (softwareEngineeringRolePack.manifest.dataCollections ?? []).map((item) => item.name),
    ).toEqual([
      'repositories',
      'code-refs',
      'repository-files',
      'qa-history',
      'repository-indexes',
    ]);
  });
});
