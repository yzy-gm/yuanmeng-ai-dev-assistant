import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['coverage/**', 'node_modules/**', 'out/**', 'outputs/**', 'work/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly'
      }
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/integrations/**/*.ts', 'src/extension/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:sea', message: 'Node 20-only APIs cannot enter the extension graph.' },
            { name: 'node:sqlite', message: 'Node 20-only APIs cannot enter the extension graph.' },
            { name: 'node:test', message: 'Use Vitest outside the packaged extension graph.' }
          ],
          patterns: [
            {
              group: ['**/cli/**', '../cli/**', '../../cli/**'],
              message: 'Extension/core code cannot import the standalone CLI graph.'
            }
          ]
        }
      ]
    }
  }
);
