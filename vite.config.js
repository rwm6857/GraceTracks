import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
  base: '/',
  server: {
    historyApiFallback: true,
  },
  plugins: [
    VitePWA({
      // 'prompt' does NOT inject skipWaiting()/clientsClaim() into the generated SW.
      // 'autoUpdate' hardcodes both in the generated SW (regardless of workbox config),
      // causing iOS Safari to force-reload the page when the SW activates — the source
      // of the double-load / "A problem repeatedly occurred" crash.
      // With 'prompt' and no custom update UI in this vanilla JS app, the new SW simply
      // waits until all tabs are closed before activating. Silent, safe updates.
      registerType: 'prompt',
      strategies: 'generateSW',
      manifest: false, // we supply our own manifest.webmanifest in /public
      workbox: {
        // Do NOT call clientsClaim(). On iOS Safari, claiming existing clients
        // forces a page reload mid-load, producing the double-load / crash.
        // VitePWA's autoUpdate injects clientsClaim by default — opt out here.
        clientsClaim: false,
        // App shell: cache-first
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Do NOT use navigateFallback. iOS Safari rejects SW navigate responses
        // whose underlying fetch followed a redirect (response.redirected === true),
        // which Workbox's precache can produce. Cloudflare's _redirects rule
        // ("/* /index.html 200") already handles SPA routing server-side, so
        // the fallback is unnecessary.
        navigateFallback: null,
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
