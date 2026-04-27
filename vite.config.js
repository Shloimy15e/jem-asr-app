import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'path'

// Fail fast if required env vars are missing — prevents deploying a broken build.
function envGuard() {
  return {
    name: 'env-guard',
    config(_, { mode, command }) {
      if (command === 'build') {
        const env = loadEnv(mode, process.cwd(), 'VITE_');
        const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];
        const missing = required.filter(k => !env[k]);
        if (missing.length) {
          throw new Error(
            `\n\n  ❌ Missing env vars: ${missing.join(', ')}\n` +
            `  Create a .env file with these values before building.\n` +
            `  See CLAUDE.md → "Build Rules" for details.\n\n`
          );
        }
      }
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [envGuard()],
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
        signup: resolve(__dirname, 'signup.html'),
        admin: resolve(__dirname, 'admin.html'),
        transcribe: resolve(__dirname, 'transcribe.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        reviewExport: resolve(__dirname, 'review-export.html'),
        billing: resolve(__dirname, 'billing.html'),
      },
    },
  },
})
