import { describe, expect, it } from 'vitest';
import { installedWith } from '../plugins/__fixtures__/installed';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import {
  SOURCE_REPOSITORY_CAPABILITY_ID,
  SOFTWARE_ENGINEERING_ROLE_PACK_ID,
} from '@plugins/softwareEngineering';
import { buildCapabilityView, buildDescriptor, buildRuntimeView, CAMPAIGN_ID } from './__fixtures__/runtime';
import {
  draftFromRuntime,
  isDraftDirty,
  listPluginOptions,
  pluginStatusNotice,
  toSetRoleProfileInput,
} from './rolePlugins';
import type { RoleProfileDraft } from './rolePlugins';

/** 岗位包由用户安装，这里模拟一台把三个官方包都装上的机器 */
const installed = installedWith(...DISTRIBUTED_ROLE_PACKS);
const rolePackOptions = listPluginOptions(installed, 'role-pack');
/** 同岗位包一样按性质推导，避免每加一个能力插件就要回来补清单。 */
const installedCapabilityIds = installed
  .filter((plugin) => plugin.type === 'capability')
  .map((plugin) => plugin.id);

describe('listPluginOptions', () => {
  /**
   * 断言「按类型筛选 + 按显示名排序」这两条性质，而不是抄一份岗位包清单过来。
   * 用例名说的就是界面不需要认识任何一个具体岗位包，可它原先枚举了全部内置包，
   * 于是每加一个包都要回来改一次——那句话在用例里反而是假的。
   */
  it('按类型筛出可选插件，界面不需要认识任何一个具体岗位包', () => {
    const installedRolePackIds = installed
      .filter((plugin) => plugin.type === 'role-pack')
      .map((plugin) => plugin.id);

    expect(rolePackOptions.map((option) => option.id).sort()).toEqual(
      [...installedRolePackIds].sort(),
    );
    // 下拉框按显示名排序，用户每次打开看到的顺序才是同一个
    const names = rolePackOptions.map((option) => option.displayName);
    expect(names).toEqual([...names].sort());

    expect(listPluginOptions(installed, 'capability').map((option) => option.id).sort()).toEqual(
      [...installedCapabilityIds].sort(),
    );
    // 能力不是独立的包：清单里每个能力条目都来自某个岗位包的内嵌声明，
    // 所以能力 id 的集合恰好等于三个包声明的能力并集
    const declaredCapabilityIds = DISTRIBUTED_ROLE_PACKS.flatMap((pack) =>
      (pack.capabilities ?? []).map((declaration) => declaration.id),
    );
    expect(installedCapabilityIds.length).toBeGreaterThan(0);
    expect(new Set(installedCapabilityIds)).toEqual(new Set(declaredCapabilityIds));
    // 行业变体是岗位包内的字段：能力条目上不会出现这一项
    expect(
      listPluginOptions(installed, 'capability').every(
        (option) => option.industryVariants === undefined,
      ),
    ).toBe(true);
  });
});

describe('draftFromRuntime', () => {
  it('已有 descriptor 时表单初值全部来自它，勾选状态就是当前生效的能力', () => {
    const runtime = buildRuntimeView({ profile: { level: '高级', location: '上海' } });

    expect(draftFromRuntime(runtime, rolePackOptions)).toEqual({
      rolePackId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
      level: '高级',
      industryVariantId: '',
      location: '上海',
      interviewLanguage: 'zh',
      capabilityIds: [SOURCE_REPOSITORY_CAPABILITY_ID],
    });
  });

  /** 留空会让用户无从把 descriptor 建起来；这个默认值由界面按「用户是否动过」决定要不要写 */
  it('没有 descriptor 时退回本机第一个岗位包，而不是留空', () => {
    // 断言「第一个」而不是某个具体岗位包：新增内置岗位包不该让这条用例需要改写
    expect(draftFromRuntime(null, rolePackOptions)).toMatchObject({
      rolePackId: rolePackOptions[0]?.id,
      level: '',
      capabilityIds: [],
    });
    expect(rolePackOptions.length).toBeGreaterThan(1);
  });

  it('一个岗位包都没装时给空值，交给界面显示为不可提交', () => {
    expect(draftFromRuntime(null, []).rolePackId).toBe('');
  });
});

describe('toSetRoleProfileInput', () => {
  const draft: RoleProfileDraft = {
    rolePackId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
    level: ' 高级 ',
    industryVariantId: '',
    location: '  ',
    interviewLanguage: 'en',
    capabilityIds: [SOURCE_REPOSITORY_CAPABILITY_ID],
  };

  it('走这条路径的每一次写入都由用户的选择触发，userConfirmed 恒为 true', () => {
    expect(toSetRoleProfileInput(CAMPAIGN_ID, draft)).toEqual({
      campaignId: CAMPAIGN_ID,
      roleFamily: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
      rolePackId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
      level: '高级',
      industryVariantId: null,
      location: null,
      interviewLanguage: 'en',
      confidence: 1,
      userConfirmed: true,
      capabilityIds: [SOURCE_REPOSITORY_CAPABILITY_ID],
    });
  });

  it('空白的级别与城市写成 null，不落一行只有空格的记录', () => {
    const input = toSetRoleProfileInput(CAMPAIGN_ID, { ...draft, level: '   ' });
    expect(input.level).toBeNull();
    expect(input.location).toBeNull();
  });
});

describe('isDraftDirty', () => {
  const runtime = buildRuntimeView();
  const clean = draftFromRuntime(runtime, rolePackOptions);

  it('与当前生效配置一致时没有待提交内容', () => {
    expect(isDraftDirty(clean, runtime)).toBe(false);
  });

  it('级别、城市、语言、能力勾选任一改动都算待提交', () => {
    expect(isDraftDirty({ ...clean, level: '资深' }, runtime)).toBe(true);
    expect(isDraftDirty({ ...clean, location: '北京' }, runtime)).toBe(true);
    expect(isDraftDirty({ ...clean, interviewLanguage: 'en' }, runtime)).toBe(true);
    expect(isDraftDirty({ ...clean, capabilityIds: [] }, runtime)).toBe(true);
  });

  it('能力勾选只比集合，不比顺序', () => {
    const many = { ...clean, capabilityIds: ['a', 'b'] };
    const runtimeWithTwo = buildRuntimeView();
    expect(isDraftDirty(many, runtimeWithTwo)).toBe(true);
    expect(isDraftDirty({ ...clean, capabilityIds: [...clean.capabilityIds] }, runtime)).toBe(false);
  });

  /**
   * 选中即生效之后，确认与否不再是「有没有待提交」的判据：读路径自动解析出的那份
   * 未确认配置，只要表单与它一致就不该再触发写入，否则防抖写入会无休止重跑。
   */
  it('岗位未经用户确认，只要表单与它一致就不算待提交', () => {
    const unconfirmed = buildRuntimeView({ profile: { userConfirmed: false } });
    expect(isDraftDirty(draftFromRuntime(unconfirmed, rolePackOptions), unconfirmed)).toBe(false);
  });

  it('未确认的岗位画像改了值照样算待提交', () => {
    const unconfirmed = buildRuntimeView({ profile: { userConfirmed: false } });
    expect(
      isDraftDirty({ ...draftFromRuntime(unconfirmed, rolePackOptions), level: '资深' }, unconfirmed),
    ).toBe(true);
  });

  it('完全没有 descriptor 时，选了岗位包就算待提交', () => {
    expect(isDraftDirty({ ...clean, rolePackId: '' }, null)).toBe(false);
    expect(isDraftDirty(clean, null)).toBe(true);
  });
});

describe('pluginStatusNotice', () => {
  it('一切正常时不占版面', () => {
    const descriptor = buildDescriptor();
    expect(pluginStatusNotice(buildCapabilityView(descriptor).rolePack)).toBeNull();
    expect(pluginStatusNotice(null)).toBeNull();
  });

  it('降级时给出面向用户的说明', () => {
    expect(
      pluginStatusNotice({
        id: 'x',
        version: '1.0.0',
        installed: false,
        mode: 'view-only',
        reason: 'plugin-not-installed',
        detail: '本机未安装该插件，只能查看历史结果',
      }),
    ).toBe('本机未安装该插件，只能查看历史结果');
  });
});
