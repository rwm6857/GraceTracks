import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/',
  server: {
    historyApiFallback: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      manifest: false, // we supply our own manifest.webmanifest in /public
      workbox: {
        // App shell: cache-first
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Serve precached index.html for any navigate request when offline (SPA routing)
        navigateFallback: '/index.html',
        // Stem WAV files: cache on first play, then serve from cache
        runtimeCaching: [
          {
            urlPattern: /\.(wav|m4a)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'stems-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
})
