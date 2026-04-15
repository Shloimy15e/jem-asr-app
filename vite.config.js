import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    proxy: {
      '/api': {
        target: 'https://jem-asr-app.pages.dev',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        detail: resolve(__dirname, 'detail.html'),
        login: resolve(__dirname, 'login.html'),
        admin: resolve(__dirname, 'admin.html'),
        transcribe: resolve(__dirname, 'transcribe.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
})
