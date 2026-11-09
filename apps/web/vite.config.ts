import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Mirrors the AWS ALB path routing: one origin, three backend services.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_CORE_URL ?? 'http://localhost:3000',
      '/sync': process.env.SYNC_URL ?? 'http://localhost:18081',
      '/ai': process.env.AI_URL ?? 'http://localhost:8010',
    },
  },
});
