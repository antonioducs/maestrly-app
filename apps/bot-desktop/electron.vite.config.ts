import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// Tailwind serves the shared chat components (@maestrly/chat-ui); the application's own styles stay plain CSS.
export default defineConfig({ main: {}, preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } }, renderer: { plugins: [react(), tailwindcss()] } });
