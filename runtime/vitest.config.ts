import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试文件放在 test/ 目录，命名 *.test.ts
    include: ['test/**/*.test.ts'],
    // 不并发跑（部分测试涉及 better-sqlite3 单例）
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // 用 esbuild 处理 TS + .js 扩展名的 ESM import
    // 在 src/ 里写 import './foo.js' 时，vitest 会自动找到 ./foo.ts
    server: {
      deps: {
        inline: [/better-sqlite3/],
      },
    },
  },
});
