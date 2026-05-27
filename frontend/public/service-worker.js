/**
 * Service Worker - PWA Offline Support
 * Place this file in public/service-worker.js
 */

const CACHE_NAME = 'price-negotiator-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Install event - cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {
        // Non-critical error if some assets fail
        console.log('Some assets could not be cached');
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip API requests (let them go to network)
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful responses
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Return offline response for API failures
          return caches.match(request) || new Response('Offline - data cached locally');
        })
    );
  } else {
    // For static assets, try cache first, then network
    event.respondWith(
      caches.match(request).then((response) => {
        if (response) {
          return response;
        }

        return fetch(request).then((response) => {
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }

          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });

          return response;
        });
      }).catch(() => {
        // Offline fallback
        return new Response('Offline - resource not cached');
      })
    );
  }
});

// Background sync (optional - for automatic sync when network returns)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-prices') {
    event.waitUntil(
      fetch('/api/sync')
        .then(() => {
          // Notify clients that sync completed
          self.clients.matchAll().then((clients) => {
            clients.forEach((client) => {
              client.postMessage({
                type: 'SYNC_COMPLETE',
                data: { success: true },
              });
            });
          });
        })
        .catch(() => {
          // Retry later
          return Promise.reject();
        })
      );
    }
});

console.log('✓ Service Worker activated');