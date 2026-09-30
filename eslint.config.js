import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'unused-imports': unusedImports },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['error', {
        vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_',
        caughtErrors: 'all', caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { Buffer: 'readonly', console: 'readonly', process: 'readonly' } },
  },
);
