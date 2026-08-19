import antfu from '@antfu/eslint-config'
import prettier from 'eslint-config-prettier'

export default antfu(
  {
    // Only the local web app (and a few root tooling files) is linted here.
    ignores: [
      'pnpm-workspace.yaml',
      'vendor/**',
      'research/**',
      'temp/**',
      '**/dist/**',
      'apps/proxy/**',
    ],
    markdown: false,
  },
  prettier,
  {
    rules: {
      'antfu/consistent-chaining': 'off',
      'antfu/consistent-list-newline': 'off',
      'antfu/if-newline': 'off',

      'jsdoc/require-param-description': 'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-template-description': 'off',
      'jsdoc/require-throws-description': 'off',
      'jsdoc/require-yields-description': 'off',

      'jsonc/comma-dangle': 'off',

      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-imports': 'off',

      'ts/no-redeclare': ['error', { ignoreDeclarationMerge: true }],

      'yaml/plain-scalar': 'off',
    },
  },
)
