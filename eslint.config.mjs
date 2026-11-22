import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.wrangler/**', 'test-results/**', 'playwright-report/**', 'join-kit/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
