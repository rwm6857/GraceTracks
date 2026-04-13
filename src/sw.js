/**
 * GraceTracks Service Worker — SOURCE NOTE
 *
 * This file is NOT used in the build. vite-plugin-pwa with strategies:'generateSW'
 * generates dist/sw.js entirely from the workbox: config in vite.config.js.
 * Any code written here has NO effect on the deployed service worker.
 *
 * To add custom SW logic, either:
 *   a) Switch to strategies:'injectManifest' in vite.config.js (then this file IS used), or
 *   b) Add Workbox options to the workbox: block in vite.config.js.
 *
 * SW behaviour is controlled by registerType and workbox options in vite.config.js.
 * Key decisions documented there:
 *   - registerType: 'prompt'  (NOT 'autoUpdate') — prevents skipWaiting()/clientsClaim()
 *     from being injected, which on iOS Safari forces a page reload causing crashes.
 *   - navigateFallback: null  — Cloudflare _redirects handles SPA routing server-side;
 *     navigateFallback can return response.redirected=true which iOS Safari rejects.
 *   - clientsClaim: false     — belt-and-suspenders; prompt mode doesn't inject it anyway.
 */
