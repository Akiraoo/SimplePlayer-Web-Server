const CACHE='simple-player-v15';
const STATIC=['/','/style.css','/app.js','/manifest.webmanifest','/icon-192.png','/icon-512.png','/default-cover.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(u.origin!==location.origin)return;if(/^\/(stream|api|s|p|c|d|share|play)\//.test(u.pathname))return;event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(event.request,copy))}return r}).catch(()=>cached))) });
