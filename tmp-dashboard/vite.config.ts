import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The engine exposes one POST endpoint; path is ignored server-side.
      '/rpc': {target: 'http://127.0.0.1:7788', changeOrigin: true},
    },
  },
});
