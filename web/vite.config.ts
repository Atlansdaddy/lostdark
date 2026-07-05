import { defineConfig } from 'vite';

// wAIver dev/build config. Kept intentionally lean — one codebase, PC→phone.
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
  },
});
