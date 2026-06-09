import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const cleanCodeRules = {
  complexity: ['warn', { max: 12 }],
  'max-depth': ['warn', 4],
  'max-lines': [
    'warn',
    {
      max: 500,
      skipBlankLines: true,
      skipComments: true,
    },
  ],
  'max-lines-per-function': [
    'warn',
    {
      max: 80,
      skipBlankLines: true,
      skipComments: true,
    },
  ],
  'max-len': ['warn', { code: 160, tabWidth: 2 }],
  'max-params': ['warn', 5],
  'max-statements': ['warn', 40],
};

const strictBaselineRules = {
  curly: ['error', 'all'],
  'dot-notation': 'error',
  'no-nested-ternary': 'error',
  'no-var': 'error',
};

const firstPassSwitchRules = {
  'default-case': ['error', { commentPattern: '^no default$' }],
};

// 首轮接入阶段只把可疑代码形态标为 warning，避免历史复杂度债务直接阻断 CI。
const firstPassBaselineRules = {
  'no-empty': 'warn',
  'no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
  'no-useless-assignment': 'warn',
  'no-useless-escape': 'warn',
  'prefer-const': 'warn',
};

// TypeScript 文件使用 @typescript-eslint 的 unused-vars，避免核心 no-unused-vars 误判类型导入。
const firstPassTypeScriptBaselineRules = {
  'no-unused-vars': 'off',
  '@typescript-eslint/no-empty-object-type': 'warn',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/prefer-as-const': 'warn',
};

// 需要类型信息的 TS 规则先限制在已有 tsconfig 覆盖的源码范围内。
const typeAwareTypeScriptRules = {
  '@typescript-eslint/prefer-optional-chain': 'warn',
};

const typeAwareSourceEntries = [
  ['plugins/message-bridge/src/**/*.ts', './plugins/message-bridge/tsconfig.json'],
  ['packages/bridge-runtime-sdk/src/**/*.ts', './packages/bridge-runtime-sdk/tsconfig.json'],
  ['packages/skill-qrcode-auth/src/**/*.ts', './packages/skill-qrcode-auth/tsconfig.json'],
  ['packages/skill-plugin-cli/src/**/*.ts', './packages/skill-plugin-cli/tsconfig.json'],
];

const typeAwareSourceConfigs = typeAwareSourceEntries.map(([files, project]) => ({
  files: [files],
  languageOptions: {
    parserOptions: {
      project,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: typeAwareTypeScriptRules,
}));

// 脚本和测试允许较长流程编排，但仍保留 unused、prefer-const 等基础问题检查。
const relaxedGeneratedAndFixtureRules = {
  complexity: 'off',
  'max-depth': 'off',
  'max-lines': 'off',
  'max-lines-per-function': 'off',
  'max-params': 'off',
  'max-statements': 'off',
};

const nodeRuntimeGlobals = {
  ...globals.node,
  WebSocket: 'readonly',
};

export default defineConfig([
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  {
    ignores: [
      'integration/**',
      '**/.tmp/**',
      '**/bundle/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/release/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['plugins/**/*.{js,mjs,cjs}', 'packages/**/*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: nodeRuntimeGlobals,
      sourceType: 'module',
    },
    rules: {
      ...js.configs.recommended.rules,
      ...strictBaselineRules,
      ...firstPassSwitchRules,
      ...firstPassBaselineRules,
      ...cleanCodeRules,
    },
  },
  // CJS 只覆盖模块类型差异，其余 JS 规则继续从上一段配置继承。
  {
    files: ['plugins/**/*.cjs', 'packages/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  // 推荐 TS 配置负责 parser 和 TS 专属基础规则；下一段只补仓库级 warning baseline。
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['plugins/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.ts'],
  })),
  {
    files: ['plugins/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: nodeRuntimeGlobals,
    },
    rules: {
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      ...strictBaselineRules,
      ...firstPassSwitchRules,
      ...firstPassTypeScriptBaselineRules,
      ...cleanCodeRules,
    },
  },
  ...typeAwareSourceConfigs,
  {
    files: [
      'plugins/**/scripts/**/*.{js,mjs,cjs,ts}',
      'plugins/**/tests/**/*.{js,mjs,cjs,ts}',
      'packages/**/scripts/**/*.{js,mjs,cjs,ts}',
      'packages/**/tests/**/*.{js,mjs,cjs,ts}',
      'scripts/**/*.{js,mjs,cjs,ts}',
    ],
    rules: relaxedGeneratedAndFixtureRules,
  },
]);
