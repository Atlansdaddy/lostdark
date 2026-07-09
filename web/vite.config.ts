import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// wAIver dev/build config. Kept intentionally lean — one codebase, PC→phone.
// (This is the ONLY vite config; a stray vite.config.mjs used to shadow it and
//  bind localhost-only, which broke phone/LAN testing. Don't reintroduce one —
//  the studio build input the PC added there lives HERE now.)
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
    port: 5175, // pinned so the phone URL stops drifting (was hopping 5173→5174)
    strictPort: true, // if 5175 is held by a stale server, fail loudly instead
    //                    of silently hopping ports — kill the old `vite` first.
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
