import { defineConfig, mergeConfig } from 'vite';
import config from './vite.config';

export default defineConfig((env) => mergeConfig(config(env), {
  server: {
    host: '127.0.0.1', port: 15199, strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:18109', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:18109', changeOrigin: true },
      '/v1': { target: 'http://127.0.0.1:18109', changeOrigin: true },
    },
  },
}));
