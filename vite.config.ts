import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // the YouTube converter: kengine (engine/start-kengine.cmd) on 8002; the Docker converter is on 8001
  // port 8080, same as the Docker app, so the browser's saved library and history carry over
  server: { port: 8080, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8002' } },
  build: {
    // inline the small piano samples so the build has no extra asset requests
    assetsInlineLimit: 100_000,
  },
});
