import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(process.cwd(), 'src', 'db', 'migrations');
const outFile = join(process.cwd(), 'src', 'db', 'migrations', 'bundle.ts');

const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const parts = files.map((file) => {
  const sql = readFileSync(join(srcDir, file), 'utf8');
  return JSON.stringify(sql);
});

const content = `/** 自动生成：npm run db:bundle */\nexport const MIGRATIONS: string[] = [\n${parts.join(',\n')}\n];\n`;
writeFileSync(outFile, content, 'utf8');
console.log(`已写入 ${files.length} 个迁移到 ${outFile}`);
