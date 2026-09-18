import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// Tailwind serves the shared chat components (@maestrly/chat-ui); the application's own styles stay plain CSS.
// The shared package ships TypeScript sources only, so the main process must bundle it: left as an
// external, the packaged app failed to load `@maestrly/chat-ui/model-meta` from the asar and never
// opened a window. Everything else stays external, exactly as before.
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ['@maestrly/chat-ui'] })] },
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { plugins: [react(), tailwindcss()] },
});
