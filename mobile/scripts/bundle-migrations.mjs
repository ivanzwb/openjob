import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(process.cwd(), 'src', 'db', 'migrations');
const outFile = join(process.cwd(), 'src', 'db', 'migrations', 'bundle.ts');

const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const parts = files.map((file) => {
  // 行尾必须归一成 LF：Windows 上 core.autocrlf 让工作区是 CRLF，而 JSON.stringify
  // 会把 \r\n 变成字符串字面量的内容（转义序列不是换行，autocrlf 之后再也管不到），
  // 于是 bundle 里烘着 CRLF、git 里的 .sql 是 LF，两边永久对不上。
  // 症状只在 Linux 上现形：本地全绿，CI 报「有迁移没重新打包」。
  const sql = readFileSync(join(srcDir, file), 'utf8').replace(/\r\n/g, '\n');
  return JSON.stringify(sql);
});

const content = `/** 自动生成：npm run db:bundle */\nexport const MIGRATIONS: string[] = [\n${parts.join(',\n')}\n];\n`;
writeFileSync(outFile, content, 'utf8');
console.log(`已写入 ${files.length} 个迁移到 ${outFile}`);
