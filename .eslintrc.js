module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    // TypeScript handles these
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    // Allow explicit any in specific cases
    '@typescript-eslint/no-explicit-any': 'warn',

    // Enforce consistent type imports
    '@typescript-eslint/consistent-type-imports': 'error',

    // Allow async functions without await (for interface compliance)
    '@typescript-eslint/require-await': 'off',

    // Reasonable line length
    'max-len': ['warn', { code: 100, ignoreStrings: true, ignoreTemplateLiterals: true }],

    // Consistent quotes
    quotes: ['error', 'single', { avoidEscape: true }],

    // Semicolons required
    semi: ['error', 'always'],

    // Trailing commas for cleaner diffs
    'comma-dangle': ['error', 'always-multiline'],
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.js'],
};
