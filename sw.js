// eKasi Kota Hub — minimal service worker.
// Just enough to satisfy PWA installability and let the app shell
// (this page) load if the connection drops momentarily. Firestore
// data itself still needs a live connection — this does NOT cache
// menu/order data, only the static app shell.

var CACHE_NAME = 'ekasi-kota-hub-v2';
var APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_NAME; })
             .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  // Network-first for everything — this app is live-data driven
  // (Firestore), so we only fall back to cache if the network fails
  // (e.g. the shell itself, when offline).
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
