/**
 * 「界面只消费 descriptor」的静态守卫。
 *
 * 这条约束靠人记不住。它每次被突破的样子都很无辜：某个岗位的按钮文案不对，最快的修法
 * 就是 `if (campaign.roleTitle.includes('前端'))`；某个题型没跑起来，最快的修法就是把
 * `'se.system-design'` 直接写进 tsx。两处都能跑通，代价要到接入第二个岗位包时才显现
 * ——那时 resolver 解出来的配置和界面自己认定的岗位开始各说各话，而用户看到的是界面
 * 那一套，实际执行的是 descriptor 那一套。
 *
 * 所以这里直接扫渲染进程源码，扫描口径刻意收窄到「拿岗位字符串和字面量比对」：
 * 两个运行期值互相比较（例如比对表单选中项与已生效配置）不是判断岗位，拦下来只会逼着
 * 后来的人绕开这条规则。
 *
 * 做法照搬 src/main/practice/mastery.test.ts 里的唯一写入方守卫。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listBuiltInPlugins } from '../plugins/clientView';
import { DISTRIBUTED_ROLE_PACKS } from '@plugins';
import { softwareEngineeringRolePack } from '@plugins/softwareEngineering';
import { SOURCE_REPOSITORY_CAPABILITY_ID } from '../plugins/builtin/sourceRepository';

const RENDERER_DIR = join(__dirname, '..', '..', 'renderer', 'src');

interface RendererSource {
  path: string;
  text: string;
}

function rendererSources(dir: string = RENDERER_DIR): RendererSource[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rendererSources(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [{ path, text: readFileSync(path, 'utf8') }];
  });
}

const SOURCES = rendererSources();

function relative(path: string): string {
  return path.slice(RENDERER_DIR.length + 1).replace(/\\/g, '/');
}

function offenders(matches: (text: string) => boolean): string[] {
  return SOURCES.filter((source) => matches(source.text)).map((source) => relative(source.path));
}

/** 界面上代表「这是哪个岗位」的字段。它们只许被显示，不许被拿来分支 */
const ROLE_FIELD = '(?:roleTitle|role_title|roleFamily|rolePackId)';
const STRING_LITERAL = String.raw`['"\`]`;

const ROLE_STRING_BRANCHES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: `roleTitle === '…'`,
    pattern: new RegExp(String.raw`\b${ROLE_FIELD}\s*(?:===|!==|==|!=)\s*${STRING_LITERAL}`),
  },
  {
    label: `'…' === roleTitle`,
    pattern: new RegExp(String.raw`${STRING_LITERAL}\s*(?:===|!==|==|!=)\s*(?:[\w$]+\.)*${ROLE_FIELD}\b`),
  },
  {
    label: `roleTitle.includes('…')`,
    pattern: new RegExp(
      String.raw`\b${ROLE_FIELD}\s*(?:\.\s*(?:toLowerCase|toUpperCase|trim|normalize)\s*\(\s*\)\s*)*\.\s*(?:includes|startsWith|endsWith|match|search|indexOf)\s*\(\s*${STRING_LITERAL}`,
    ),
  },
  {
    label: `/…/.test(roleTitle)`,
    pattern: new RegExp(String.raw`/[^\n/]+/[a-z]*\s*\.\s*test\s*\(\s*(?:[\w$]+\.)*${ROLE_FIELD}\b`),
  },
  {
    label: `SOME_SET.has(roleTitle)`,
    pattern: new RegExp(String.raw`\.\s*(?:has|includes|indexOf)\s*\(\s*(?:[\w$]+\.)*${ROLE_FIELD}\s*[,)]`),
  },
  {
    label: `LOOKUP[roleTitle]`,
    pattern: new RegExp(String.raw`\[\s*(?:[\w$]+\.)*${ROLE_FIELD}\s*\]`),
  },
  {
    label: `switch (roleTitle)`,
    pattern: new RegExp(String.raw`\bswitch\s*\(\s*[^)]*\b${ROLE_FIELD}\b`),
  },
];

describe('渲染进程只消费 descriptor', () => {
  it('扫到了渲染进程源码，否则后面的断言都是空跑', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.map((source) => relative(source.path))).toContain('App.tsx');
  });

  it.each(ROLE_STRING_BRANCHES)('没有按岗位字符串分支：$label', ({ pattern }) => {
    expect(offenders((text) => pattern.test(text))).toEqual([]);
  });

  /**
   * 能力插件与岗位包在这里区别对待。宿主功能本来就按能力门控，界面知道
   * `source-repository` 这个 ID 是本分；岗位包是数据，界面一旦 import 进来，
   * 就等于把「这个岗位有哪些题型」抄了一份到渲染进程。
   */
  it('不从内置插件里 import 岗位包，能力插件的 ID 常量除外', () => {
    const imports = /from\s+['"]([^'"]*plugins\/builtin\/[^'"]*)['"]/g;

    // 按插件类型推导可放行的目录，而不是写死 sourceRepository 一个路径。
    // 规则本身允许「任何能力插件的 ID 常量」，写死一个路径会让第二个能力插件
    // 撞上一条与注释自相矛盾的断言——role-play 就是这么撞上的。
    const allowedDirs = listBuiltInPlugins()
      .filter((plugin) => plugin.type === 'capability')
      .map((plugin) => plugin.id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()));
    expect(allowedDirs.length).toBeGreaterThan(1);

    expect(
      offenders((text) =>
        [...text.matchAll(imports)].some(
          ([, path]) => !allowedDirs.some((dir) => path.endsWith(`/${dir}`)),
        ),
      ),
    ).toEqual([]);
  });

  it('不把官方岗位包的 ID 写成字面量', () => {
    // 岗位包已经移出基础包，改由用户安装。界面照样不许认得它们的 ID：
    // 装了哪几个岗位包是本机的事，界面按 descriptor 渲染就行。
    const rolePackIds = DISTRIBUTED_ROLE_PACKS.map((pack) => pack.manifest.id);

    expect(rolePackIds.length).toBeGreaterThan(0);
    for (const id of rolePackIds) {
      expect(offenders((text) => text.includes(`'${id}'`) || text.includes(`"${id}"`))).toEqual([]);
    }
  });

  /**
   * 题型、量规和能力项的 ID 都由岗位包声明。抄进界面之后换一个岗位包就是静默失效：
   * `practice:createSession` 会报 unknown-format，而错在几百行之外的一个字符串。
   *
   * 新增岗位包时把它加进这份清单——漏加只会削弱守卫，不会让用例变红。
   */
  it('不把岗位包声明的题型、量规、能力项 ID 写成字面量', () => {
    const declaredIds = [
      ...softwareEngineeringRolePack.interviewFormats.map((format) => format.id),
      ...softwareEngineeringRolePack.rubrics.map((rubric) => rubric.id),
      ...softwareEngineeringRolePack.competencyTemplates.map((competency) => competency.id),
    ];

    const leaked = declaredIds.filter(
      (id) => offenders((text) => text.includes(`'${id}'`) || text.includes(`"${id}"`)).length > 0,
    );

    expect(leaked).toEqual([]);
  });

  /** ID 漂移一次，门控就会静默失效成「永远不可用」，而界面上只是少了一个入口 */
  it('能力 ID 走共享常量，不在界面里重抄一遍字面量', () => {
    // 逐个能力插件检查，新增插件自动纳入
    for (const plugin of listBuiltInPlugins().filter((item) => item.type === 'capability')) {
      expect(
        offenders((text) => text.includes(`'${plugin.id}'`) || text.includes(`"${plugin.id}"`)),
        `${plugin.id} 的 ID 被写成了字面量`,
      ).toEqual([]);
    }

    expect(offenders((text) => text.includes(`'${SOURCE_REPOSITORY_CAPABILITY_ID}'`))).toEqual([]);
    expect(
      offenders((text) => text.includes('SOURCE_REPOSITORY_CAPABILITY_ID')).length,
    ).toBeGreaterThan(0);
  });
});
