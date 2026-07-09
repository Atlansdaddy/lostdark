import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// wAIver dev/build config. Kept intentionally lean — one codebase, PC→phone.
// NOTE: vite.config.mjs SHADOWS this file (Vite resolves .mjs before .ts) —
// keep the two in sync, or delete one.
export default defineConfig({
  resolve: {
    // three/examples/jsm can drag in a second copy of three; one instance only.
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three'],
  },
  server: {
    host: true, // expose on LAN so we can test on a real phone (the ≥30fps gate)
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        // Two separate apps: the game, and the Animator Studio tool page.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        studio: fileURLToPath(new URL('./studio.html', import.meta.url)),
      },
    },
  },
});
