import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite configuration.
 *
 * Tailwind v4 is wired in as a Vite plugin, so there is no tailwind.config.js
 * or postcss.config.js — the plugin scans the source files itself.
 *
 * The dev server proxies /api to the Express backend. That means the browser
 * only ever talks to one origin during development, which sidesteps CORS
 * entirely while developing. `VITE_API_URL` still exists for deployments where
 * the API lives somewhere else.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
