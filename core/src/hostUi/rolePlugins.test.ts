import { describe, expect, it } from 'vitest';
import { installedWith } from '../plugins/__fixtures__/installed';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { SOFTWARE_ENGINEERING_ROLE_PACK_ID } from '@plugins/softwareEngineering';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from '../plugins/builtin/sourceRepository';
import { buildCapabilityView, buildDescriptor, buildRuntimeView, CAMPAIGN_ID } from './__fixtures__/runtime';
import {
  buildCapabilityRows,
  draftFromRuntime,
  enabledCapabilityIds,
  isDraftDirty,
  listPluginOptions,
  pluginStatusNotice,
  reconcileCapabilitySelection,
  reconciliationNotices,
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
    expect(installedCapabilityIds).toContain(SOURCE_REPOSITORY_CAPABILITY_ID);
    expect(listPluginOptions(installed, 'industry-pack')).toEqual([]);
  });
});

describe('draftFromRuntime', () => {
  it('已有 descriptor 时表单初值全部来自它，勾选状态就是当前生效的能力', () => {
    const runtime = buildRuntimeView({ profile: { level: '高级', location: '上海' } });

    expect(draftFromRuntime(runtime, rolePackOptions)).toEqual({
      rolePackId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
      level: '高级',
      industryPackId: '',
      location: '上海',
      interviewLanguage: 'zh',
      capabilityIds: [SOURCE_REPOSITORY_CAPABILITY_ID],
    });
  });

  /** 留空会让确认按钮永远点不动，用户也就没有办法把 descriptor 建起来 */
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
    industryPackId: '',
    location: '  ',
    interviewLanguage: 'en',
    capabilityIds: [SOURCE_REPOSITORY_CAPABILITY_ID],
  };

  it('走这条路径的每一次写入都是用户按下确认，userConfirmed 恒为 true', () => {
    expect(toSetRoleProfileInput(CAMPAIGN_ID, draft)).toEqual({
      campaignId: CAMPAIGN_ID,
      roleFamily: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
      rolePackId: SOFTWARE_ENGINEERING_ROLE_PACK_ID,
      level: '高级',
      industryPackId: null,
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

  /** 自动识别出来的岗位还没被确认过，确认按钮不能是灰的 */
  it('岗位未经用户确认时始终算待提交', () => {
    const unconfirmed = buildRuntimeView({ profile: { userConfirmed: false } });
    expect(isDraftDirty(draftFromRuntime(unconfirmed, rolePackOptions), unconfirmed)).toBe(true);
  });

  it('完全没有 descriptor 时，选了岗位包就算待提交', () => {
    expect(isDraftDirty({ ...clean, rolePackId: '' }, null)).toBe(false);
    expect(isDraftDirty(clean, null)).toBe(true);
  });
});

/**
 * capabilityIds 只能往上加。
 *
 * 岗位包把 source-repository 声明成了可选依赖，resolver 会自动展开它；用户取消勾选再
 * 保存，descriptor 里它照样是启用的。复选框自己弹回去而不给任何说法，是这一版最容易
 * 出现的谎——所以提交完成后按 descriptor 回校一遍，把差异说清楚。
 */
describe('reconcileCapabilitySelection', () => {
  const descriptor = buildDescriptor();

  it('岗位包依赖强制打开的能力会被指出来', () => {
    expect(enabledCapabilityIds(descriptor)).toContain(SOURCE_REPOSITORY_CAPABILITY_ID);

    const reconciliation = reconcileCapabilitySelection([], descriptor);

    expect(reconciliation.forcedOn).toEqual([SOURCE_REPOSITORY_CAPABILITY_ID]);
    expect(reconciliation.rejected).toEqual([]);
    expect(reconciliationNotices(reconciliation, (id) => id)).toEqual([
      `${SOURCE_REPOSITORY_CAPABILITY_ID}：岗位包把它声明为依赖，本次仍然启用，无法单独关闭`,
    ]);
  });

  it('勾了却没能启用时带上 resolver 给的原因', () => {
    const reconciliation = reconcileCapabilitySelection(
      [SOURCE_REPOSITORY_CAPABILITY_ID, 'not-installed'],
      descriptor,
    );

    expect(reconciliation.forcedOn).toEqual([]);
    expect(reconciliation.rejected).toEqual([
      { id: 'not-installed', reason: '解析后没有进入运行配置，可能是版本不兼容' },
    ]);
  });

  it('descriptor 明确停用某项能力时原样转述停用原因', () => {
    const withDisabled = {
      ...descriptor,
      capabilities: [
        { id: 'analytics-case', enabled: false as const, disabledReason: 'plugin-not-found: 插件未安装' },
      ],
    };

    expect(reconcileCapabilitySelection(['analytics-case'], withDisabled).rejected).toEqual([
      { id: 'analytics-case', reason: 'plugin-not-found: 插件未安装' },
    ]);
  });

  it('勾选与生效完全一致时没有任何需要解释的差异', () => {
    expect(
      reconcileCapabilitySelection([SOURCE_REPOSITORY_CAPABILITY_ID], descriptor),
    ).toEqual({ forcedOn: [], rejected: [] });
  });
});

describe('buildCapabilityRows', () => {
  const descriptor = buildDescriptor();

  it('桌面端装齐插件时逐条显示为可用，并带上 descriptor 固定的版本', () => {
    const rows = buildCapabilityRows({
      descriptor,
      view: buildCapabilityView(descriptor),
      installed,
    });

    // 只针对 descriptor 真的启用了的那条断言；本机还装着别的能力插件，
    // 它们没进这场备考，状态本就不该是「可用」。
    const row = rows.find((item) => item.id === SOURCE_REPOSITORY_CAPABILITY_ID);
    expect(row).toMatchObject({
      id: SOURCE_REPOSITORY_CAPABILITY_ID,
      enabledInCampaign: true,
      disabledReason: null,
      localMode: 'full',
      installedLocally: true,
    });
    expect(row!.version).toBeTruthy();
    expect(row!.displayName).not.toBe(row!.id);
  });

  /** 同一份 descriptor 在手机上是只读的：降级由 client view 说了算，不由界面猜 */
  it('平台只支持查看时如实标成只读并给出说明', () => {
    const rows = buildCapabilityRows({
      descriptor,
      view: buildCapabilityView(descriptor, 'mobile'),
      installed,
    });

    const row = rows.find((item) => item.id === SOURCE_REPOSITORY_CAPABILITY_ID);
    expect(row).toMatchObject({ localMode: 'view-only', enabledInCampaign: true });
    expect(row!.localDetail).toBeTruthy();
  });

  it('本机装了但这场备考没启用的插件也要列出来，否则用户没有入口把它加进来', () => {
    const rows = buildCapabilityRows({
      descriptor: { ...descriptor, capabilities: [] },
      view: null,
      installed,
    });

    expect([...rows.map((row) => row.id)].sort()).toEqual([...installedCapabilityIds].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        enabledInCampaign: false,
        version: null,
        localMode: null,
        installedLocally: true,
      });
    }
  });

  it('descriptor 记着但本机没装的插件同样要显示——那正是最该被看见的降级', () => {
    const rows = buildCapabilityRows({
      descriptor: {
        ...descriptor,
        capabilities: [{ id: 'analytics-case', version: '1.0.0', enabled: true }],
      },
      view: null,
      installed: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'analytics-case',
      displayName: 'analytics-case',
      enabledInCampaign: true,
      installedLocally: false,
    });
  });

  it('没有 descriptor 时只剩本机清单，不凭空造出启用状态', () => {
    const rows = buildCapabilityRows({ descriptor: null, view: null, installed });
    expect(rows.every((row) => !row.enabledInCampaign)).toBe(true);
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
