import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true, // reachable from the phone on the same network
    proxy: {
      // Same-origin API in dev: the field app talks to /api/*, Vite
      // forwards to the backend. No CORS juggling on device.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
