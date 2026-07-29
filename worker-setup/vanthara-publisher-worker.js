/**
 * VANTHARA PUBLISHER — Cloudflare Worker
 * =======================================
 * The secure backend for the Marketing Command Center's Publish tab.
 * It talks to Meta's official Graph API to publish Reels to your own
 * Instagram business account. No passwords are ever stored — only an
 * official Meta access token, kept as an encrypted Worker secret.
 *
 * DEPLOY (5 minutes):
 * 1. Cloudflare dashboard → Workers & Pages → Create → Worker.
 *    Name it: vanthara-publisher → Deploy the hello-world → Edit code.
 * 2. Delete the sample code, paste THIS ENTIRE FILE, click Deploy.
 * 3. Worker → Settings → Variables and Secrets → add these four:
 *      META_TOKEN      (Secret)  your long-lived Meta access token
 *      IG_USER_ID      (Text)    your Instagram business account ID
 *      ADMIN_KEY       (Secret)  any strong random string you invent;
 *                                you'll enter the same value in the
 *                                dashboard's Publish → Settings
 *      ALLOWED_ORIGIN  (Text)    https://vantharahomestay.com
 * 4. Copy the worker URL (https://vanthara-publisher.<you>.workers.dev)
 *    into the dashboard's Publish → Settings.
 *
 * GETTING META_TOKEN and IG_USER_ID — see the "First-time setup" panel
 * in the dashboard's Publish tab for the click-by-click guide.
 *
 * Endpoints (all require header  X-Admin-Key: <ADMIN_KEY>):
 *   GET  /api/me                 → verifies token, returns IG username
 *   POST /api/publish            → {video_url, caption} → creates reel container
 *   GET  /api/status?id=<id>     → container processing status
 *   POST /api/publish_container  → {container_id} → makes the reel live
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // --- auth ---
    if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (!env.META_TOKEN || !env.IG_USER_ID) {
      return json({ error: 'Worker not configured: set META_TOKEN and IG_USER_ID in Settings → Variables' }, 500);
    }

    try {
      // --- verify connection ---
      if (url.pathname === '/api/me' && request.method === 'GET') {
        const r = await fetch(
          `${GRAPH}/${env.IG_USER_ID}?fields=username,name,followers_count,media_count&access_token=${env.META_TOKEN}`
        );
        const data = await r.json();
        return json(data, r.ok ? 200 : 502);
      }

      // --- step 1: create a reel container from a public video URL ---
      if (url.pathname === '/api/publish' && request.method === 'POST') {
        const { video_url, caption } = await request.json();
        if (!video_url) return json({ error: 'video_url is required' }, 400);
        const r = await fetch(`${GRAPH}/${env.IG_USER_ID}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_type: 'REELS',
            video_url,
            caption: caption || '',
            share_to_feed: true,
            access_token: env.META_TOKEN,
          }),
        });
        const data = await r.json();
        if (!data.id) return json({ error: 'Container creation failed', detail: data }, 502);
        return json({ container_id: data.id });
      }

      // --- step 2: poll processing status ---
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id is required' }, 400);
        const r = await fetch(`${GRAPH}/${id}?fields=status_code,status&access_token=${env.META_TOKEN}`);
        const data = await r.json();
        return json(data, r.ok ? 200 : 502);
      }

      // --- step 3: publish the finished container ---
      if (url.pathname === '/api/publish_container' && request.method === 'POST') {
        const { container_id } = await request.json();
        if (!container_id) return json({ error: 'container_id is required' }, 400);
        const r = await fetch(`${GRAPH}/${env.IG_USER_ID}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: container_id, access_token: env.META_TOKEN }),
        });
        const data = await r.json();
        if (!data.id) return json({ error: 'Publish failed', detail: data }, 502);
        return json({ published: true, media_id: data.id });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
