import { defineConfig } from 'vite';

// Frontend dev server on 8084, proxying API calls to the Express backend on 8085.
export default defineConfig({
  server: {
    port: 8084,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8085',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
