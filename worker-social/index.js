/**
 * VANTHARA SOCIAL PUBLISHER — Cloudflare Worker
 * =================================================
 * Powers the admin dashboard's "Social Publish" tab: upload a real photo
 * or video, write a caption, pick Instagram / Facebook / YouTube, and
 * either publish immediately or schedule it. A Cron Trigger checks every
 * 10 minutes for approved posts whose scheduled time has arrived and
 * publishes them automatically.
 *
 * This Worker deploys automatically from GitHub (Settings → Build →
 * Git repository, root directory "worker-social") — edit this file and
 * push to main to redeploy. Initial deploy trigger.
 *
 * ONE-TIME SETUP — Worker → Settings → Variables and Secrets → add:
 *   ADMIN_KEY          (Secret)  Same value you use for the other Workers.
 *   ALLOWED_ORIGIN      (Text)    https://vantharahomestay.com
 *   PUBLIC_BASE_URL     (Text)    https://vanthara-social.<you>.workers.dev
 *                                 (this Worker's own URL — used to build
 *                                 public media links that Instagram/
 *                                 Facebook/YouTube fetch from)
 *
 *   -- YouTube (Google Cloud Console → OAuth client, Web application) --
 *   GOOGLE_CLIENT_ID     (Text)
 *   GOOGLE_CLIENT_SECRET (Secret)
 *
 *   -- Meta (Meta for Developers → your app) --
 *   META_APP_ID          (Text)
 *   META_APP_SECRET      (Secret)
 *
 * Bindings required (Worker → Settings → Bindings):
 *   D1 database  "DB"     → vanthara-social-db
 *   R2 bucket    "MEDIA"  → vanthara-social-media
 *
 * After secrets + bindings are set, visit (while logged in as yourself):
 *   {PUBLIC_BASE_URL}/api/oauth/youtube/start?key=YOUR_ADMIN_KEY
 *   {PUBLIC_BASE_URL}/api/oauth/meta/start?key=YOUR_ADMIN_KEY
 * and approve access. That's a one-time step per platform.
 *
 * Endpoints (all require X-Admin-Key header, except /media/* and the
 * OAuth start/callback links above which use a ?key= query param
 * because browsers can't send custom headers on a plain link click):
 *   GET  /api/me                     connection status for each platform
 *   POST /api/media                  upload raw file bytes (X-Filename, X-Content-Type headers)
 *   GET  /media/:key                 public read of an uploaded file
 *   POST /api/posts                  create a draft post
 *   GET  /api/posts?status=          list posts
 *   GET  /api/posts/:id              get one post
 *   PATCH /api/posts/:id             edit a draft
 *   POST /api/posts/:id/approve      move draft -> approved (will publish on schedule or now)
 *   POST /api/posts/:id/reject       move draft -> rejected
 *   POST /api/posts/:id/publish-now  publish immediately, bypassing schedule
 *   DELETE /api/posts/:id            remove a post
 */

const json = (obj, status, extraHeaders) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
  });

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Filename, X-Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  };
}

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // Public, unauthenticated: serve uploaded media so Meta/YouTube can fetch it.
    if (url.pathname.startsWith('/media/') && request.method === 'GET') {
      return serveMedia(request, env, cors);
    }

    // OAuth start/callback use ?key= because they're followed via a plain browser link/redirect.
    if (url.pathname === '/api/oauth/youtube/start') return oauthYoutubeStart(request, env, cors);
    if (url.pathname === '/api/oauth/youtube/callback') return oauthYoutubeCallback(request, env, cors);
    if (url.pathname === '/api/oauth/meta/start') return oauthMetaStart(request, env, cors);
    if (url.pathname === '/api/oauth/meta/callback') return oauthMetaCallback(request, env, cors);

    // Everything else requires the admin key header.
    if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }

    try {
      if (url.pathname === '/api/me' && request.method === 'GET') return apiMe(env, cors);
      if (url.pathname === '/api/media' && request.method === 'POST') return uploadMedia(request, env, cors);

      if (url.pathname === '/api/posts' && request.method === 'POST') return createPost(request, env, cors);
      if (url.pathname === '/api/posts' && request.method === 'GET') return listPosts(url, env, cors);

      const postMatch = url.pathname.match(/^\/api\/posts\/([a-zA-Z0-9-]+)$/);
      if (postMatch && request.method === 'GET') return getPost(postMatch[1], env, cors);
      if (postMatch && request.method === 'PATCH') return editPost(postMatch[1], request, env, cors);
      if (postMatch && request.method === 'DELETE') return deletePost(postMatch[1], env, cors);

      const approveMatch = url.pathname.match(/^\/api\/posts\/([a-zA-Z0-9-]+)\/approve$/);
      if (approveMatch && request.method === 'POST') return setStatus(approveMatch[1], 'approved', env, cors);

      const rejectMatch = url.pathname.match(/^\/api\/posts\/([a-zA-Z0-9-]+)\/reject$/);
      if (rejectMatch && request.method === 'POST') return setStatus(rejectMatch[1], 'rejected', env, cors);

      const publishMatch = url.pathname.match(/^\/api\/posts\/([a-zA-Z0-9-]+)\/publish-now$/);
      if (publishMatch && request.method === 'POST') return publishNow(publishMatch[1], env, cors);

      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, cors);
    }
  },

  // Cron Trigger: runs every 10 minutes (see wrangler.jsonc), publishes due posts.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDuePosts(env));
  },
};

/* ---------------- Media ---------------- */

async function uploadMedia(request, env, cors) {
  const filename = request.headers.get('X-Filename') || 'upload';
  const contentType = request.headers.get('X-Content-Type') || 'application/octet-stream';
  const isVideo = contentType.startsWith('video/');
  const ext = (filename.split('.').pop() || (isVideo ? 'mp4' : 'jpg')).toLowerCase();
  const key = `media/${uid()}.${ext}`;

  const bytes = await request.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) return json({ error: 'Empty upload' }, 400, cors);

  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });

  const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return json(
    {
      key,
      url: `${base}/media/${key.slice('media/'.length)}`,
      media_type: isVideo ? 'video' : 'image',
      content_type: contentType,
      size: bytes.byteLength,
    },
    200,
    cors
  );
}

async function serveMedia(request, env, cors) {
  const key = 'media/' + decodeURIComponent(new URL(request.url).pathname.slice('/media/'.length));
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: cors });
  const headers = new Headers(cors);
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000');
  return new Response(obj.body, { headers });
}

/* ---------------- Posts CRUD ---------------- */

async function createPost(request, env, cors) {
  const body = await request.json();
  if (!body.media_key || !body.media_type) return json({ error: 'media_key and media_type are required' }, 400, cors);
  if (!Array.isArray(body.platforms) || body.platforms.length === 0)
    return json({ error: 'platforms must be a non-empty array' }, 400, cors);

  const id = uid();
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO posts (id, media_key, media_type, caption, youtube_title, platforms, scheduled_at, status, results, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`
  )
    .bind(
      id,
      body.media_key,
      body.media_type,
      body.caption || '',
      body.youtube_title || null,
      JSON.stringify(body.platforms),
      body.scheduled_at || null,
      ts,
      ts
    )
    .run();

  return json(await rowToPost(env, id), 200, cors);
}

async function listPosts(url, env, cors) {
  const status = url.searchParams.get('status');
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
  let stmt;
  if (status) {
    stmt = env.DB.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit);
  } else {
    stmt = env.DB.prepare('SELECT * FROM posts ORDER BY created_at DESC LIMIT ?').bind(limit);
  }
  const { results } = await stmt.all();
  return json((results || []).map(rowFormat), 200, cors);
}

async function getPost(id, env, cors) {
  const post = await rowToPost(env, id);
  if (!post) return json({ error: 'Not found' }, 404, cors);
  return json(post, 200, cors);
}

async function editPost(id, request, env, cors) {
  const body = await request.json();
  const existing = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Not found' }, 404, cors);
  if (existing.status !== 'draft') return json({ error: 'Only drafts can be edited' }, 400, cors);

  const caption = body.caption !== undefined ? body.caption : existing.caption;
  const youtube_title = body.youtube_title !== undefined ? body.youtube_title : existing.youtube_title;
  const platforms = body.platforms !== undefined ? JSON.stringify(body.platforms) : existing.platforms;
  const scheduled_at = body.scheduled_at !== undefined ? body.scheduled_at : existing.scheduled_at;

  await env.DB.prepare(
    `UPDATE posts SET caption = ?, youtube_title = ?, platforms = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`
  )
    .bind(caption, youtube_title, platforms, scheduled_at, nowIso(), id)
    .run();

  return json(await rowToPost(env, id), 200, cors);
}

async function deletePost(id, env, cors) {
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, cors);
}

async function setStatus(id, status, env, cors) {
  const existing = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Not found' }, 404, cors);
  await env.DB.prepare('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?').bind(status, nowIso(), id).run();
  return json(await rowToPost(env, id), 200, cors);
}

async function publishNow(id, env, cors) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!post) return json({ error: 'Not found' }, 404, cors);
  const result = await publishPost(env, post);
  return json(result, 200, cors);
}

async function rowToPost(env, id) {
  const row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  return row ? rowFormat(row) : null;
}

function rowFormat(row) {
  return {
    id: row.id,
    media_key: row.media_key,
    media_type: row.media_type,
    caption: row.caption,
    youtube_title: row.youtube_title,
    platforms: JSON.parse(row.platforms || '[]'),
    scheduled_at: row.scheduled_at,
    status: row.status,
    results: row.results ? JSON.parse(row.results) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* ---------------- Connection status ---------------- */

async function apiMe(env, cors) {
  const youtube = await env.DB.prepare("SELECT data FROM tokens WHERE platform = 'youtube'").first();
  const meta = await env.DB.prepare("SELECT data FROM tokens WHERE platform = 'meta'").first();
  return json(
    {
      youtube: { connected: !!youtube },
      meta: { connected: !!meta },
      google_client_configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      meta_app_configured: !!(env.META_APP_ID && env.META_APP_SECRET),
    },
    200,
    cors
  );
}

/* ---------------- Cron: publish due posts ---------------- */

async function runDuePosts(env) {
  const nowTs = nowIso();
  const { results } = await env.DB.prepare(
    `SELECT * FROM posts WHERE status = 'approved' AND (scheduled_at IS NULL OR scheduled_at <= ?)`
  )
    .bind(nowTs)
    .all();
  for (const post of results || []) {
    await publishPost(env, post);
  }
}

/* ---------------- Publish orchestration ---------------- */

async function publishPost(env, post) {
  const platforms = JSON.parse(post.platforms || '[]');
  const mediaObj = await env.MEDIA.get(post.media_key);
  const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const mediaUrl = `${base}/media/${post.media_key.slice('media/'.length)}`;

  const results = post.results ? JSON.parse(post.results) : {};
  let allOk = true;

  for (const platform of platforms) {
    try {
      if (platform === 'youtube') {
        if (!mediaObj) throw new Error('Media not found in storage');
        const bytes = await env.MEDIA.get(post.media_key).then((o) => o && o.arrayBuffer());
        results.youtube = await publishToYouTube(env, post, bytes);
      } else if (platform === 'instagram') {
        results.instagram = await publishToInstagram(env, post, mediaUrl);
      } else if (platform === 'facebook') {
        results.facebook = await publishToFacebook(env, post, mediaUrl);
      } else {
        results[platform] = { ok: false, error: 'Unknown platform' };
      }
    } catch (e) {
      results[platform] = { ok: false, error: String((e && e.message) || e) };
    }
    if (!results[platform] || !results[platform].ok) allOk = false;
  }

  const status = allOk ? 'published' : 'failed';
  await env.DB.prepare('UPDATE posts SET status = ?, results = ?, updated_at = ? WHERE id = ?')
    .bind(status, JSON.stringify(results), nowIso(), post.id)
    .run();

  return rowFormat({ ...post, status, results: JSON.stringify(results) });
}

/* ---------------- YouTube ---------------- */

async function getYoutubeAccessToken(env) {
  const row = await env.DB.prepare("SELECT data FROM tokens WHERE platform = 'youtube'").first();
  if (!row) throw new Error('YouTube is not connected yet — visit /api/oauth/youtube/start?key=YOUR_ADMIN_KEY');
  const { refresh_token } = JSON.parse(row.data);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('YouTube token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function publishToYouTube(env, post, videoBytes) {
  if (post.media_type !== 'video') return { ok: false, error: 'YouTube requires a video file' };
  const accessToken = await getYoutubeAccessToken(env);

  const metadata = {
    snippet: {
      title: post.youtube_title || (post.caption || 'Vanthara Homestay').slice(0, 90),
      description: post.caption || '',
      categoryId: '22',
    },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
  };

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) return { ok: false, error: 'YouTube init failed: ' + (await initRes.text()) };
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) return { ok: false, error: 'YouTube did not return an upload URL' };

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: videoBytes,
  });
  const data = await uploadRes.json();
  if (!uploadRes.ok || !data.id) return { ok: false, error: 'YouTube upload failed: ' + JSON.stringify(data) };

  return { ok: true, url: `https://youtube.com/watch?v=${data.id}`, video_id: data.id };
}

/* ---------------- Meta (Instagram + Facebook) ---------------- */

async function getMetaTokenData(env) {
  const row = await env.DB.prepare("SELECT data FROM tokens WHERE platform = 'meta'").first();
  if (!row) throw new Error('Meta is not connected yet — visit /api/oauth/meta/start?key=YOUR_ADMIN_KEY');
  return JSON.parse(row.data);
}

async function publishToInstagram(env, post, mediaUrl) {
  const { ig_user_id, page_access_token } = await getMetaTokenData(env);
  if (!ig_user_id) return { ok: false, error: 'No Instagram Business account linked to your Facebook Page' };

  const isVideo = post.media_type === 'video';
  const containerBody = isVideo
    ? { media_type: 'REELS', video_url: mediaUrl, caption: post.caption || '', access_token: page_access_token }
    : { image_url: mediaUrl, caption: post.caption || '', access_token: page_access_token };

  const createRes = await fetch(`https://graph.facebook.com/v19.0/${ig_user_id}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(containerBody),
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.id) return { ok: false, error: 'IG container failed: ' + JSON.stringify(createData) };

  if (isVideo) {
    // Reels need processing time — poll status before publishing.
    let statusCode = 'IN_PROGRESS';
    for (let i = 0; i < 20 && statusCode === 'IN_PROGRESS'; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await fetch(
        `https://graph.facebook.com/v19.0/${createData.id}?fields=status_code&access_token=${page_access_token}`
      );
      const statusData = await statusRes.json();
      statusCode = statusData.status_code;
    }
    if (statusCode !== 'FINISHED') return { ok: false, error: 'IG video processing did not finish: ' + statusCode };
  }

  const publishRes = await fetch(`https://graph.facebook.com/v19.0/${ig_user_id}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: createData.id, access_token: page_access_token }),
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok || !publishData.id) return { ok: false, error: 'IG publish failed: ' + JSON.stringify(publishData) };

  return { ok: true, media_id: publishData.id };
}

async function publishToFacebook(env, post, mediaUrl) {
  const { page_id, page_access_token } = await getMetaTokenData(env);
  if (!page_id) return { ok: false, error: 'No Facebook Page connected' };

  const isVideo = post.media_type === 'video';
  const endpoint = isVideo ? 'videos' : 'photos';
  const body = isVideo
    ? { file_url: mediaUrl, description: post.caption || '', access_token: page_access_token }
    : { url: mediaUrl, caption: post.caption || '', access_token: page_access_token };

  const res = await fetch(`https://graph.facebook.com/v19.0/${page_id}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || (!data.id && !data.post_id)) return { ok: false, error: 'Facebook post failed: ' + JSON.stringify(data) };

  return { ok: true, post_id: data.post_id || data.id };
}

/* ---------------- OAuth: YouTube (Google) ---------------- */

function redirectUri(env, path) {
  return (env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + path;
}

async function oauthYoutubeStart(request, env, cors) {
  const url = new URL(request.url);
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'Unauthorized' }, 401, cors);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: 'GOOGLE_CLIENT_ID is not set yet' }, 500, cors);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env, '/api/oauth/youtube/callback'),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(), 302);
}

async function oauthYoutubeCallback(request, env, cors) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return json({ error: 'Missing code', details: url.searchParams.get('error') }, 400, cors);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env, '/api/oauth/youtube/callback'),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!data.refresh_token) {
    return json(
      {
        error: 'No refresh_token returned. If you have connected before, revoke access at myaccount.google.com/permissions and try again so Google issues a fresh refresh token.',
        raw: data,
      },
      400,
      cors
    );
  }

  await env.DB.prepare(
    `INSERT INTO tokens (platform, data, updated_at) VALUES ('youtube', ?, ?)
     ON CONFLICT(platform) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify({ refresh_token: data.refresh_token }), nowIso())
    .run();

  return new Response('YouTube connected! You can close this tab and go back to the admin dashboard.', {
    headers: { 'Content-Type': 'text/plain', ...cors },
  });
}

/* ---------------- OAuth: Meta (Instagram + Facebook) ---------------- */

async function oauthMetaStart(request, env, cors) {
  const url = new URL(request.url);
  if (url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'Unauthorized' }, 401, cors);
  if (!env.META_APP_ID) return json({ error: 'META_APP_ID is not set yet' }, 500, cors);

  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri(env, '/api/oauth/meta/callback'),
    scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management',
    response_type: 'code',
  });
  return Response.redirect('https://www.facebook.com/v19.0/dialog/oauth?' + params.toString(), 302);
}

async function oauthMetaCallback(request, env, cors) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return json({ error: 'Missing code', details: url.searchParams.get('error_description') }, 400, cors);

  // 1. Exchange code for a short-lived user token.
  const tokenParams = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri(env, '/api/oauth/meta/callback'),
    code,
  });
  const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + tokenParams.toString());
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return json({ error: 'Token exchange failed', raw: tokenData }, 400, cors);

  // 2. Exchange for a long-lived user token (~60 days).
  const longParams = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: tokenData.access_token,
  });
  const longRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + longParams.toString());
  const longData = await longRes.json();
  const userToken = longData.access_token || tokenData.access_token;

  // 3. Find the user's Facebook Page (and its never-expiring Page token).
  const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}`);
  const pagesData = await pagesRes.json();
  const page = pagesData.data && pagesData.data[0];
  if (!page) return json({ error: 'No Facebook Page found for this account', raw: pagesData }, 400, cors);

  // 4. Find the Instagram Business account linked to that Page.
  const igRes = await fetch(
    `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
  );
  const igData = await igRes.json();
  const igUserId = igData.instagram_business_account && igData.instagram_business_account.id;

  await env.DB.prepare(
    `INSERT INTO tokens (platform, data, updated_at) VALUES ('meta', ?, ?)
     ON CONFLICT(platform) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(
      JSON.stringify({
        page_id: page.id,
        page_name: page.name,
        page_access_token: page.access_token,
        ig_user_id: igUserId || null,
      }),
      nowIso()
    )
    .run();

  const igNote = igUserId
    ? 'Instagram Business account linked too.'
    : 'No Instagram Business account was found linked to this Page — Facebook posting will work, but link an Instagram account to the Page in Meta Business Suite if you want Instagram posting as well.';

  return new Response(
    `Facebook connected (Page: ${page.name}). ${igNote} You can close this tab and go back to the admin dashboard.`,
    { headers: { 'Content-Type': 'text/plain', ...cors } }
  );
}
