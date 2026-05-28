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
  'max-params': ['warn', 5],
  'max-statements': ['warn', 40],
};

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

const relaxedGeneratedAndFixtureRules = {
  complexity: 'off',
  'max-depth': 'off',
  'max-lines': 'off',
  'max-lines-per-function': 'off',
  'max-params': 'off',
  'max-statements': 'off',
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
    files: ['plugins/**/*.{js,mjs,cjs}', 'packages/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
    rules: {
      ...js.configs.recommended.rules,
      ...firstPassBaselineRules,
      ...cleanCodeRules,
    },
  },
  {
    files: ['plugins/**/*.cjs', 'packages/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['plugins/**/*.ts', 'packages/**/*.ts'],
  })),
  {
    files: ['plugins/**/*.ts', 'packages/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      ...firstPassTypeScriptBaselineRules,
      ...cleanCodeRules,
    },
  },
  {
    files: [
      'plugins/**/scripts/**/*.{js,mjs,cjs,ts}',
      'plugins/**/tests/**/*.{js,mjs,cjs,ts}',
      'packages/**/scripts/**/*.{js,mjs,cjs,ts}',
      'packages/**/tests/**/*.{js,mjs,cjs,ts}',
    ],
    rules: relaxedGeneratedAndFixtureRules,
  },
]);
