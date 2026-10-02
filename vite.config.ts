import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: 'index.html',
        rlPlayground: 'rl-playground.html',
        trainDemo: 'train-demo.html',
      },
    },
  },
});
