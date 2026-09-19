/**
 * 移动端的代码插件来源：从缓存岗位包里取 mobile/ 那份实现，键要剥掉平台前缀。
 *
 * 手机端不再假定 codeAssets['main.js']——包内是按平台平铺的，桌面端拿 desktop/，
 * 移动端拿 mobile/，剥前缀后两端同构（插件源码里的 webviewPath 仍是 ui/xxx.html）。
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { RolePack } from '@core/plugins/types';
import { listMobilePluginRuntimes } from './pluginRuntimeLocal';

/**
 * `listCachedRolePacks` 那条链会经 `../remote/rpc` 把 react-native 的原生模块拖进来，node 里
 * 解析不了 Flow 源码。这一组只喂缓存行、不需要真转发，照 rolePackLocal.test.ts 的做法挡掉。
 */
vi.mock('../remote/rpc', () => ({ invokeRemote: () => Promise.resolve({ result: null }) }));

/** listCachedRolePacks 只走 getAllSync 一条查询；用最小的 fake 注入缓存行。 */
function dbWith(packs: RolePack[]): SQLiteDatabase {
  return {
    getAllSync: () => packs.map((pack) => ({ pack_json: JSON.stringify(pack) })),
  } as unknown as SQLiteDatabase;
}

function packWithCode(input: {
  main?: string;
  mobile?: string;
  codeAssets?: Record<string, string>;
}): RolePack {
  return {
    manifest: {
      id: 'demo-code',
      version: '1.0.0',
      type: 'role-pack',
      displayName: '演示代码包',
      description: '移动端代码插件用例',
      compatibility: { core: '^1.0.0', schema: 1 },
      permissions: ['filesystem:workspace'],
      ...(input.main !== undefined ? { main: input.main } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      api: '^1.0',
    },
    codeAssets: input.codeAssets,
  } as unknown as RolePack;
}

describe('listMobilePluginRuntimes', () => {
  it('取 mobile/ 那份实现，资产键剥掉 mobile/ 前缀', () => {
    const pack = packWithCode({
      main: 'desktop/main.js',
      mobile: 'mobile/main.js',
      codeAssets: {
        'desktop/main.js': 'exports.activate = () => {}; // desktop',
        'desktop/ui/repositories.html': '<p>desktop</p>',
        'mobile/main.js': 'exports.activate = () => {}; // mobile',
        'mobile/ui/repositories.html': '<p>mobile</p>',
      },
    });

    const runtimes = listMobilePluginRuntimes(dbWith([pack]));

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.mainSource).toContain('// mobile');
    expect(Object.keys(runtimes[0]!.uiAssets)).toEqual(['ui/repositories.html']);
    expect(runtimes[0]!.uiAssets['ui/repositories.html']).toBe('<p>mobile</p>');
  });

  it('只提供 desktop 实现的包在移动端不上屏，且不报错', () => {
    const pack = packWithCode({
      main: 'desktop/main.js',
      codeAssets: {
        'desktop/main.js': 'exports.activate = () => {};',
        'desktop/ui/repositories.html': '<p>desktop</p>',
      },
    });

    expect(listMobilePluginRuntimes(dbWith([pack]))).toEqual([]);
  });

  it('纯声明式岗位包（无代码资产）不产生运行时', () => {
    expect(listMobilePluginRuntimes(dbWith([packWithCode({})]))).toEqual([]);
  });
});
