// @ts-check
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'renderer/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // `any` is acceptable in catch blocks and IPC boundary code
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused vars are errors except for variables prefixed with _
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
);
