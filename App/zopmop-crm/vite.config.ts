import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_CRM_API_URL || 'http://localhost:8091';

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      port: 5174,
      proxy: {
        '/admin': { target: apiTarget, changeOrigin: true, secure: false },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      // Heavy vendor libs get split out so they cache independently across
      // releases and only load on the routes that use them (google-maps in
      // /map, recharts in /analytics, react-hook-form on /workers/new).
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@react-google-maps') || id.includes('@googlemaps')) return 'vendor-maps';
            if (id.includes('recharts') || id.includes('d3-')) return 'vendor-recharts';
            if (id.includes('framer-motion')) return 'vendor-framer';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('react-hook-form') || id.includes('@hookform')) return 'vendor-forms';
            if (id.includes('node_modules/zod')) return 'vendor-zod';
            if (id.includes('date-fns')) return 'vendor-date';
            if (id.includes('axios')) return 'vendor-http';
            if (id.includes('zustand')) return 'vendor-state';
            if (id.includes('@tanstack')) return 'vendor-tanstack';
            if (id.includes('react-router')) return 'vendor-router';
            // Trailing-slash guards stop these from catching react-is,
            // react-icons, etc. — which belong in the catch-all `vendor`
            // and otherwise create a vendor ↔ vendor-react import cycle.
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) return 'vendor-react';
            return 'vendor';
          },
        },
      },
    },
  };
});
