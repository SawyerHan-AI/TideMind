import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // 与 client/electron.vite.config.ts 的 main 配段对齐:生产侧 client 进程把
      // src/ 编译产物 ../dist 当作 "@server" 模块根。测试里没有 dist,直接指向
      // TypeScript 源,让 vitest 自带的 transformer 处理 .ts。
      // /\.js$/ 仅作用在 import 末尾的 .js 后缀:Node ESM 风格的 ".js" 在 src/ 下
      // 实际上对应 ".ts",别名替换后剥掉,让 vite resolver 顺利落到源文件。
      '@server': resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
      },
    },
  },
});
