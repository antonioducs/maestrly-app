import { defineConfig } from 'vitest/config'
// Components are rendered with react-dom/server: no browser, no DOM globals, so the tests stay
// fast and prove the markup that both applications will ship.
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] }, esbuild: { jsx: 'automatic' } })
