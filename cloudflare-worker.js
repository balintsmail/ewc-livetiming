// Cloudflare Worker: online relay for the EWC timing feed + shared lap store.
//
// 1. Feed relay. ewc.chronelec.com sends no CORS headers, so a page on GitHub
//    Pages can't read it directly. This Worker fetches the feed and passes it
//    on with the headers the browser needs (the online twin of serve.py).
//      GET  /feed/results.php            → https://ewc.chronelec.com/results.php
//
// 2. Sync. Every open page (localhost or online) uploads the laps it recorded
//    and downloads the ones it missed, so the race history survives any one
//    page being closed. Stored in a D1 database bound as `DB`.
//      POST /sync/push   { session, laps: [{num, lap, pits, data}], flags: [{t, flag}] }
//      GET  /sync/pull?session=…&since=<id>
//
// 3. Usage. Requests per UTC day (Cloudflare's free limit is 100,000/day).
//      GET  /stats                       → { day, requests }
//    Every response also carries X-Relay-Today with the running count.
//
// Setup (Cloudflare dashboard):
//   Storage & Databases → D1 → Create → name "ewc-sync".
//   Workers & Pages → ewc-feed → Settings → Bindings → Add → D1 database,
//   variable name DB, database ewc-sync → Deploy. Then Edit code → paste this
//   file → Deploy. Tables are created automatically on the first request.

const UPSTREAM = 'https://ewc.chronelec.com/';
const FEEDS = new Set(['results.php', 'messages.php']);
const ORIGINS = ['https://balintsmail.github.io', 'http://localhost:3800', 'http://127.0.0.1:3800'];

// Request counter: counted in memory, flushed to D1 every 20 s, so counting
// doesn't cost a database write per request.
let pending = 0, lastFlush = 0, known = 0, knownDay = '';
const today = () => new Date().toISOString().slice(0, 10);   // Cloudflare's quota resets at 00:00 UTC

let schemaReady = null;
function schema(db) {
  return schemaReady ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS laps (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL,
                num TEXT NOT NULL, lap INTEGER NOT NULL, pits INTEGER, data TEXT NOT NULL, UNIQUE(session, num, lap))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS flags (session TEXT NOT NULL, t INTEGER NOT NULL, flag INTEGER NOT NULL,
                PRIMARY KEY(session, t))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL)`),
  ]).catch(e => { schemaReady = null; throw e; });
}

async function count(env, ctx) {
  const day = today();
  if (day !== knownDay) { knownDay = day; known = 0; pending = 0; }
  pending++;
  if (!env.DB || Date.now() - lastFlush < 20000) return known + pending;
  lastFlush = Date.now();
  const n = pending; pending = 0;
  const job = (async () => {
    await schema(env.DB);
    const row = await env.DB.prepare(
      `INSERT INTO usage (day, requests) VALUES (?1, ?2)
       ON CONFLICT(day) DO UPDATE SET requests = requests + ?2 RETURNING requests`).bind(day, n).first();
    if (row) known = row.requests;
  })().catch(() => { pending += n; });
  ctx.waitUntil(job);
  return known + n;
}

const json = (obj, headers, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'X-Relay-Today',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const headers = { ...cors, 'X-Relay-Today': String(await count(env, ctx)) };
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '');

    try {
      // ── Feed relay ──
      const feed = path.replace(/^feed\//, '');
      if (request.method === 'GET' && FEEDS.has(feed)) {
        const up = await fetch(UPSTREAM + feed, {
          headers: { 'User-Agent': 'Mozilla/5.0 (ewc-livetiming relay)' },
          cf: { cacheTtl: 2, cacheEverything: true },   // viewers polling together share one upstream request
        });
        return new Response(up.body, { status: up.status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
      }

      if (path === 'stats') {
        let requests = known + pending;
        if (env.DB) {
          await schema(env.DB);
          const row = await env.DB.prepare('SELECT requests FROM usage WHERE day = ?').bind(today()).first();
          requests = (row?.requests || 0) + pending;
        }
        return json({ day: today(), requests, limit: 100000 }, headers);
      }

      if (path.startsWith('sync/')) {
        if (!env.DB) return json({ error: 'No D1 database bound as DB' }, headers, 503);
        await schema(env.DB);

        if (path === 'sync/push' && request.method === 'POST') {
          const body = await request.json();
          const session = String(body.session || '').slice(0, 200);
          if (!session) return json({ error: 'session missing' }, headers, 400);
          const stmts = [];
          for (const l of (body.laps || []).slice(0, 2000)) {
            const num = String(l.num || '').slice(0, 8), lap = parseInt(l.lap);
            if (!num || !(lap > 0) || lap > 2000) continue;
            const data = JSON.stringify(l.data || {});
            if (data.length > 2000) continue;
            stmts.push(env.DB.prepare('INSERT OR IGNORE INTO laps (session, num, lap, pits, data) VALUES (?, ?, ?, ?, ?)')
              .bind(session, num, lap, Number.isFinite(l.pits) ? l.pits : null, data));
          }
          for (const f of (body.flags || []).slice(0, 500)) {
            if (!Number.isFinite(f.t) || !Number.isFinite(f.flag)) continue;
            stmts.push(env.DB.prepare('INSERT OR IGNORE INTO flags (session, t, flag) VALUES (?, ?, ?)').bind(session, f.t, f.flag));
          }
          if (stmts.length) await env.DB.batch(stmts);
          return json({ ok: true, received: stmts.length }, headers);
        }

        if (path === 'sync/pull' && request.method === 'GET') {
          const session = url.searchParams.get('session') || '';
          const since = parseInt(url.searchParams.get('since')) || 0;
          const laps = await env.DB.prepare(
            'SELECT id, num, lap, pits, data FROM laps WHERE session = ? AND id > ? ORDER BY id LIMIT 5000').bind(session, since).all();
          const flags = await env.DB.prepare('SELECT t, flag FROM flags WHERE session = ? ORDER BY t').bind(session).all();
          const rows = laps.results || [];
          return json({
            laps: rows.map(r => ({ num: r.num, lap: r.lap, pits: r.pits, data: JSON.parse(r.data) })),
            flags: flags.results || [],
            maxId: rows.length ? rows[rows.length - 1].id : since,
            more: rows.length === 5000,
          }, headers);
        }
      }
      return json({ error: 'Not found' }, headers, 404);
    } catch (e) {
      return json({ error: String(e) }, headers, 502);
    }
  },
};
