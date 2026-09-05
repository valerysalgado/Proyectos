import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_GOOGLE_API_KEY': JSON.stringify(
        env.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY,
      ),
      'import.meta.env.VITE_GOOGLE_MODEL_ID': JSON.stringify(env.GOOGLE_MODEL_ID || 'gemini-2.5-flash'),
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
  };
});
