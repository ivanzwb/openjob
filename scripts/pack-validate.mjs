/**
 * pack validate：本地自证一个岗位包是合法的。
 *
 * 作者改完包不需要理解 resolver、签名或应用启动流程——这条命令用与打包
 * （pack-plugins.mjs）完全相同的 vite ssrLoadModule 机制加载包，跑同一套
 * 契约校验（defineRolePack 已经就地跑过 validateRolePack，这里再显式过一遍
 * 是为了让「从 scripts/distributed-role-packs 加载」这条分发路径也被覆盖），
 * 并打印包的插入点清单供人眼核对。
 *
 * 用法：
 *   node scripts/pack-validate.mjs [pluginId ...]   # 缺省校验全部分发岗位包
 *
 * 退出码：任一包失败即非零，可直接挂进 CI。
 */
import { resolve } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const ROOT = process.cwd();

async function main() {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    // 与 pack-plugins.mjs 保持一致：打包与校验共用同一条加载路径
    resolve: {
      alias: [
        { find: '@core', replacement: resolve(ROOT, 'core/src') },
        { find: /^@plugins$/, replacement: resolve(ROOT, 'scripts/distributed-role-packs.ts') },
        { find: /^@plugins\//, replacement: `${resolve(ROOT, 'plugins')}/` },
      ],
    },
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });

  let failed = false;
  try {
    const { validateRolePack } = await server.ssrLoadModule('core/src/plugins/contracts.ts');
    const { DISTRIBUTED_ROLE_PACKS } = await server.ssrLoadModule(
      'scripts/distributed-role-packs.ts',
    );

    const packs = args.length === 0
      ? DISTRIBUTED_ROLE_PACKS
      : DISTRIBUTED_ROLE_PACKS.filter((pack) => args.includes(pack.manifest.id));
    if (packs.length === 0) {
      console.error(`没有匹配的岗位包：${args.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    for (const pack of packs) {
      const { manifest, promptFragments } = pack;
      const issues = validateRolePack(pack);
      const label = `${manifest.id}@${manifest.version}`;
      if (issues.length > 0) {
        failed = true;
        console.error(`✗ ${label}`);
        for (const issue of issues) {
          console.error(`    ${issue.path}: ${issue.message} (${issue.code})`);
        }
        continue;
      }

      const bySlot = new Map();
      for (const fragment of promptFragments) {
        const source = fragment.ref ?? fragment.file;
        bySlot.set(fragment.slot, [
          ...(bySlot.get(fragment.slot) ?? []),
          fragment.formatId ? `${fragment.formatId} ← ${source}` : `← ${source}`,
        ]);
      }
      console.log(`✓ ${label}「${manifest.displayName}」`);
      console.log(
        `    能力 ${pack.competencyTemplates.length} · 题型 ${pack.interviewFormats.length} · ` +
          `量规 ${pack.rubrics.length} · 任务 ${pack.taskTemplates.length} · 片段 ${promptFragments.length}` +
          ` · 简历模块 ${(pack.resumeModules ?? []).length}`,
      );
      for (const [slot, entries] of [...bySlot.entries()].sort()) {
        for (const entry of entries) {
          console.log(`    ${slot.padEnd(18)} ${entry}`);
        }
      }
    }
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    await server.close();
  }
  if (failed) process.exitCode = 1;
}

await main();
