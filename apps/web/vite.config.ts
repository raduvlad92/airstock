import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dashboard (ADR 0010). One entry, built into the Worker's static assets under /app/assets.
 * No HTML is emitted: the Worker serves the shell page itself, with the session check and CSP.
 * File names are fixed so the shell can name them; the asset headers make browsers revalidate.
 */
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: '../worker/public/app',
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    target: 'es2022',
    rolldownOptions: {
      input: { app: 'src/main.tsx' },
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        // The one stylesheet (cssCodeSplit: false) is named for the shell; other files keep theirs.
        assetFileNames: (info) =>
          info.names.includes('style.css') ? 'assets/app.css' : 'assets/[name][extname]',
      },
    },
  },
  // `pnpm --filter @airstock/web dev` next to `wrangler dev` (port 8787).
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/shopify': 'http://localhost:8787',
      '/assets': 'http://localhost:8787',
    },
  },
});
