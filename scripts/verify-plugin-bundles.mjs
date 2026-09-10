/**
 * 校验打包产物真的装得上。
 *
 * 打包脚本产出的包如果验签不过，用户看到的是「内容与签名不符」——一条指向「有人改了包」
 * 的线索，而真实原因是发布流程自己出的错。这个脚本就是拦住那种情况：用应用侧同一套校验
 * 与验签代码，逐个过一遍产物。
 *
 * 用法：node scripts/verify-plugin-bundles.mjs [dist-plugins]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const DIR = resolve(process.argv[2] ?? 'dist-plugins');
const ROOT = process.cwd();

const server = await createServer({
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  resolve: { alias: { '@core': resolve(ROOT, 'core/src') } },
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});

try {
  const contract = await server.ssrLoadModule('core/src/plugins/package/contract.ts');
  const signature = await server.ssrLoadModule('desktop/src/main/plugins/package/signature.ts');
  const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));

  let failed = 0;
  for (const entry of index.plugins) {
    const files = JSON.parse(readFileSync(join(DIR, entry.file), 'utf8')).files;
    const issues = contract.validatePluginPackage(files);
    const trust = signature.classifyPackageTrust(files, [index.publicKey]);
    // 这里的"信任"只意味着「内容与 index.json 里那把公钥签的时候一致」。装到用户机器上
    // 算不算第一方，取决于基础包内置的密钥，不是这个脚本能判的
    const ok = issues.length === 0 && trust === 'first-party';
    if (!ok) failed += 1;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${entry.id.padEnd(24)} ${ok ? '签名与清单公钥一致' : trust}` +
        (issues.length > 0 ? `  ${issues.map((i) => `${i.path}: ${i.message}`).join('；')}` : ''),
    );
  }

  // 反向确认校验真的在起作用：改一个字节必须被判成篡改，否则上面的 OK 说明不了任何事
  const sample = JSON.parse(readFileSync(join(DIR, index.plugins[0].file), 'utf8')).files;
  const key = 'pack.json' in sample ? 'pack.json' : 'contributions.json';
  sample[key] = `${sample[key]} `;
  const tampered = signature.classifyPackageTrust(sample, [index.publicKey]);
  console.log(`\n改一个字节 → ${tampered}`);
  if (tampered !== 'tampered') failed += 1;

  if (failed > 0) {
    console.error(`\n${failed} 个产物不可用`);
    process.exitCode = 1;
  } else {
    console.log(`\n${index.plugins.length} 个产物格式合法，签名与清单公钥一致`);
  }
} finally {
  await server.close();
}
