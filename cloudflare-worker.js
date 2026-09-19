// Cloudflare Worker: online relay for the EWC timing feed.
//
// ewc.chronelec.com sends no CORS headers, so a page on GitHub Pages can't
// read it directly. This Worker fetches the feed and passes it on with the
// headers the browser needs — the online twin of the relay in serve.py.
//
//   https://<worker>.workers.dev/feed/results.php  →  https://ewc.chronelec.com/results.php
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker → name it
// (e.g. ewc-feed) → Deploy → Edit code → replace everything with this file → Deploy.

const UPSTREAM = 'https://ewc.chronelec.com/';
const ALLOWED = new Set(['results.php', 'messages.php']);
// Pages allowed to use the relay.
const ORIGINS = ['https://balintsmail.github.io', 'http://localhost:3800', 'http://127.0.0.1:3800'];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const name = new URL(request.url).pathname.replace(/^\/(feed\/)?/, '');
    if (!ALLOWED.has(name)) return new Response('Unknown feed', { status: 404, headers: cors });

    try {
      // A 2-second edge cache: several viewers polling every 5 s share one
      // upstream request instead of each hitting Chronelec.
      const up = await fetch(UPSTREAM + name, {
        headers: { 'User-Agent': 'Mozilla/5.0 (ewc-livetiming relay)' },
        cf: { cacheTtl: 2, cacheEverything: true },
      });
      return new Response(up.body, {
        status: up.status,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    } catch (e) {
      return new Response(`Upstream error: ${e}`, { status: 502, headers: cors });
    }
  },
};
