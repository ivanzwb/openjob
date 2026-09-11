import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
  // 迁移只在开发期生成，运行时由主进程按打包后的路径加载
  strict: true,
  verbose: true,
});
