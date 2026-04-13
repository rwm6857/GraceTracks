/**
 * GraceTracks Service Worker
 *
 * This file is the custom service worker entry point.
 * vite-plugin-pwa (generateSW strategy) handles the Workbox injection
 * automatically — you do not need to add Workbox imports manually.
 *
 * Runtime caching rules are configured in vite.config.js (workbox.runtimeCaching).
 * Stem WAV files are cached with CacheFirst in 'stems-cache'.
 * App shell assets are precached by the injected Workbox precache manifest.
 *
 * If you need custom service worker logic (e.g. push notifications, background
 * sync), add it below the Workbox injection point comment.
 */

// Workbox injects its precache manifest here during build:
// self.__WB_MANIFEST

// — Custom SW logic (optional) —
// NOTE: Do NOT call self.clients.claim() here.
// On iOS Safari, clients.claim() forces an immediate page reload when the SW
// activates, causing the double-load / "A problem repeatedly occurred" crash.
// SPA routing works without it: Cloudflare's _redirects handles first-visit
// navigation, and the SW takes control on the next navigation naturally.
