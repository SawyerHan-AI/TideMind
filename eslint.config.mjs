import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Type-aware 规则只对被 tsconfig.json include 的文件开启（目前是 src/**）。
  // tests/、scripts/、vitest.config.ts、client/、pro/ 都不在主 tsconfig 里，
  // 若也挂 project: true 会导致 parser 报 "file not in any of the provided projects"。
  // 未来要给这些区域加 type-aware lint，可以为它们各自指定自己的 tsconfig。
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Detached promises 是反复踩的坑（未捕获 rejection、错过 await 等）。
      // 先用 'warn' 不阻塞 CI，让存量问题暴露出来；清理干净后升级为 'error'。
      // TODO: upgrade to 'error' after initial cleanup
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
    },
  },

  // 开源代码禁止 import pro/ 目录
  {
    files: ['src/**/*.ts', 'client/src/**/*.ts', 'client/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/pro/*', '**/pro/**', '../pro/*', '../pro/**', '../../pro/*', '../../pro/**'],
          message: '开源代码不允许直接 import pro/ 下的闭源模块。请通过 plugin-loader 或 feature-registry 动态加载。',
        }],
      }],
    },
  },

  // plugin-loader 和 feature-registry 豁免（它们使用动态 import，不会被此规则检查）
  // pro/ 目录内的代码可以 import 任何东西
  {
    files: ['pro/**/*.ts', 'pro/**/*.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // 忽略构建产物和依赖
  {
    ignores: ['dist/**', 'client/dist/**', 'client/out/**', 'node_modules/**', 'client/node_modules/**'],
  },
];
