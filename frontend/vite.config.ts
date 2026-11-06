import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For local dev against the deployed backend:  SITE_URL=https://xxxx.cloudfront.net npm run dev
const target = process.env.SITE_URL;
const proxy = target
  ? Object.fromEntries(['/api', '/stream', '/art'].map((p) => [p, { target, changeOrigin: true, secure: true }]))
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: { proxy },
});
