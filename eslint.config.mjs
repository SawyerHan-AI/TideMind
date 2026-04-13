import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,

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
