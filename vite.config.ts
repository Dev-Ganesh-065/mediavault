import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => {
  // Load env variables based on mode (development / production)
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_API_URL || 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
    build: { 
      sourcemap: true,
      // Define global constants that get replaced at build time
      define: {
        'process.env.VITE_API_URL': JSON.stringify(env.VITE_API_URL || ''),
      },
    },
  };
});
