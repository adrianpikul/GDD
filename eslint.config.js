import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/consistent-type-imports': 'error' }
  },
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  prettier
);
