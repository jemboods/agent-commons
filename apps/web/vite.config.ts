import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const DEFAULT_BASE_PATH = '/agent-commons/';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.VITE_BASE_PATH ?? DEFAULT_BASE_PATH,
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
