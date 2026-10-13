/* Service worker: makes the app installable and readable when the Mac at
   home is asleep, off the network, or you are on a plane.

   Code    -> HTML, JS and CSS are fetched fresh, falling back to the cache
              after a short timeout. They have to agree with each other: markup
              decides which elements exist and the script decides what to do
              with them, so serving one from this launch and one from three
              launches ago is how you get a card that renders empty. The
              *navigation* decides which it is to be and the rest of the shell
              follows it — see freshFirst — so a slow connection costs you
              freshness, never consistency. A Mac that is asleep costs a
              moment, not the app.
   Assets  -> stale-while-revalidate. Icons and the manifest aren't coupled to
              the code, so they can stay instant.
   GET API -> network-first with a cache fallback (fresh when online,
              last-known numbers when not). The fallback will accept a cached
              answer for a different date range when the exact one is missing,
              because the range moves every day and an older window beats an
              empty card. That cache outlives VERSION on purpose.
*/

const VERSION = 'v40';

// Long enough for a sleeping Mac to wake and answer, short enough that opening
// the app on a plane doesn't feel broken.
const NETWORK_TIMEOUT = 2500;
const SHELL_CACHE = `workouts-shell-${VERSION}`;
// Deliberately NOT versioned. The shell is: index.html and app.js have to agree
// with each other, so a new build needs a new shell cache. Cached API responses
// have no such coupling, and tying them to VERSION meant every CSS tweak wiped
// the numbers you would have read on a plane.
const DATA_CACHE = 'workouts-data';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/charts.js',
  '/app.js',
  // Loaded on demand by the map view, but precached so the map's own chrome
  // still opens offline. The basemap tiles come from CARTO and need a network.
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
];

/* No skipWaiting/clients.claim on purpose. index.html and app.js have to come
   from the same version: a worker that takes over a page mid-load can serve the
   old HTML and the new script, and the script then looks for markup that isn't
   there. Waiting until every old tab is gone costs one extra launch before an
   update shows up, and removes that failure mode entirely. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(freshFirst(request, true));
    return;
  }

  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(freshFirst(request, false));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

const timeout = (ms) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error('timeout')), ms);
});

/* index.html, styles.css, charts.js and app.js used to race the network one by
   one, each falling back on its own. Whichever lost was served from a cache
   that could be several versions behind, so a slow connection produced a page
   that was *part* new: new markup under an old stylesheet, or a script asking
   charts.js for an option the cached copy has never heard of. Fetching them
   the same way is not the same as fetching them from the same version.

   So the navigation decides for the whole load. If the Mac answered the page
   request, it is awake and reachable, and the files that follow are given a
   longer leash to arrive from the network rather than being allowed to drop to
   the cache on their own. If the navigation had to fall back, everything falls
   back with it. Either way you get one version of the app.

   Biasing toward the cache under a bad connection is the safe direction: a
   consistent older app works perfectly and simply shows older numbers, which
   the header already says. A mixed one renders wrong. */
let generation = null;                 // 'network' | 'cache' | null
let generationAt = 0;
const GENERATION_TTL = 15000;          // one page load's worth
// The server is known to be up in a network generation, so a sub-resource that
// is merely slow is worth waiting for — falling back is the expensive mistake.
const SUBRESOURCE_TIMEOUT = NETWORK_TIMEOUT * 3;

function currentGeneration() {
  if (generation && Date.now() - generationAt < GENERATION_TTL) return generation;
  return null;
}

function setGeneration(value) {
  generation = value;
  generationAt = Date.now();
}

// Fresh whenever the Mac answers in time, the cached copy when it doesn't.
async function freshFirst(request, navigation) {
  const cache = await caches.open(SHELL_CACHE);
  // Kept running past the timeout: a slow answer still refreshes the cache for
  // next time, even though this load fell back.
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => { /* handled by the fallback below */ });

  // A sub-resource in a load whose navigation already fell back: take the
  // cached copy without racing, so it matches the markup being styled.
  if (!navigation && currentGeneration() === 'cache') {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  const limit = navigation ? NETWORK_TIMEOUT : SUBRESOURCE_TIMEOUT;
  try {
    const response = await Promise.race([network, timeout(limit)]);
    if (navigation) setGeneration('network');
    return response;
  } catch (error) {
    if (navigation) setGeneration('cache');
    const cached = await cache.match(request);
    if (cached) return cached;
    if (navigation) {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// Cache keys embed the resolved date range, and "12 months ending today" moves
// every day — so yesterday's entry can never match today's request, and the
// Training view came up empty offline however recently you had loaded it. Accept
// an entry that differs from the request in start/end alone, newest first, and
// nothing else: metric, bucket and the sport list still have to match exactly or
// you would be handed the wrong series. The header keeps showing when the data
// was last synced, so the staleness stays visible.
async function matchIgnoringRange(cache, request) {
  const identity = (url) => {
    const params = new URLSearchParams(url.search);
    params.delete('start');
    params.delete('end');
    params.sort();
    return `${url.pathname}?${params.toString()}`;
  };
  const wanted = identity(new URL(request.url));

  let best = null;
  let bestEnd = '';
  for (const key of await cache.keys()) {
    const url = new URL(key.url);
    if (identity(url) !== wanted) continue;
    // ISO dates, so lexicographic order is chronological order.
    const end = new URLSearchParams(url.search).get('end') || '';
    if (!best || end > bestEnd) {
      best = key;
      bestEnd = end;
    }
  }
  return best ? cache.match(best) : undefined;
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => { /* handled by the fallback below */ });

  try {
    // Timed out for the same reason as the shell: a sleeping Mac accepts the
    // connection and then says nothing, and waiting on that is the difference
    // between last week's numbers appearing and the app hanging on a spinner.
    return await Promise.race([network, timeout(NETWORK_TIMEOUT)]);
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const stale = await matchIgnoringRange(cache, request);
    if (stale) return stale;
    return new Response(
      JSON.stringify({ detail: 'Offline and no cached copy of this view yet.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: false });

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const response = await network;
  if (response) return response;
  return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}
