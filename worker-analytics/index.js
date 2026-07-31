/**
 * VANTHARA WEBSITE ANALYTICS — Cloudflare Worker
 * =================================================
 * Pulls your Cloudflare Web Analytics (page views, visits, top pages,
 * referrers, countries) into the admin dashboard's "Website Analytics"
 * tab, so you never have to open the Cloudflare dashboard separately.
 *
 * This Worker never stores anything — every request goes live to
 * Cloudflare's own Analytics API and comes straight back.
 *
 * This Worker deploys automatically from GitHub (Settings → Build →
 * Git repository, root directory "worker-analytics") — just edit this
 * file and push to main to redeploy.
 *
 * ONE-TIME SETUP — Worker → Settings → Variables and Secrets → add:
 *      CF_API_TOKEN   (Secret)  See "GETTING THE API TOKEN" below.
 *      CF_ACCOUNT_TAG (Text)    00d64d0be60d23d90582abe660367334
 *      CF_SITE_TAG    (Text)    b69269b6a2d3487a850be8f495481894
 *      ADMIN_KEY      (Secret)  Any strong string — you can reuse the
 *                               exact same value as your vanthara-booking
 *                               Worker's ADMIN_KEY for convenience.
 *      ALLOWED_ORIGIN (Text)    https://vantharahomestay.com
 *
 *    GETTING THE API TOKEN — Cloudflare dashboard → click your profile
 *    icon (top right) → My Profile → API Tokens → Create Token →
 *    Custom Token → Create.
 *      Token name:      Vanthara Analytics Read
 *      Permissions:     Account | Account Analytics | Read
 *      Account Resources: Include | (your account)
 *      Leave "Zone Resources" as-is (not needed — this token never
 *      touches DNS, Pages, Workers, or anything else on your account,
 *      only read-only analytics numbers).
 *    Click "Continue to summary" → "Create Token" → copy it once (it's
 *    shown only once) → paste it into CF_API_TOKEN above.
 *
 * Then copy the Worker URL (https://vanthara-analytics.<you>.workers.dev)
 * into the admin dashboard's Website Analytics → Settings, alongside
 * your Admin key.
 *
 * Endpoints (all require X-Admin-Key header):
 *   GET /api/me       → quick connection test
 *   GET /api/summary?days=7   → totals + breakdowns for the last N days
 *   GET /api/debug-schema     → raw introspection dump, only needed if
 *                               /api/summary ever returns a GraphQL
 *                               field error after a Cloudflare API change
 */

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_TAG || !env.CF_SITE_TAG) {
      return json({ error: 'Worker is missing CF_API_TOKEN / CF_ACCOUNT_TAG / CF_SITE_TAG — see setup instructions at the top of this file.' }, 500);
    }

    try {
      if (url.pathname === '/api/me' && request.method === 'GET') {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const until = new Date().toISOString();
        const r = await runGraphQL(env, MINI_QUERY, { accountTag: env.CF_ACCOUNT_TAG, siteTag: env.CF_SITE_TAG, since, until });
        if (r.errors) return json({ ok: false, graphql_errors: r.errors }, 502);
        return json({ ok: true });
      }

      if (url.pathname === '/api/summary' && request.method === 'GET') {
        const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
        const until = new Date();
        const since = new Date(until.getTime() - days * 24 * 3600 * 1000);
        const r = await runGraphQL(env, SUMMARY_QUERY, {
          accountTag: env.CF_ACCOUNT_TAG,
          siteTag: env.CF_SITE_TAG,
          since: since.toISOString(),
          until: until.toISOString(),
        });
        if (r.errors) return json({ error: 'GraphQL error — see graphql_errors for the exact field Cloudflare rejected.', graphql_errors: r.errors }, 502);
        return json(shapeSummary(r));
      }

      if (url.pathname === '/api/debug-schema' && request.method === 'GET') {
        const r = await runGraphQL(env, INTROSPECTION_QUERY, {});
        return json(r);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

async function runGraphQL(env, query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.CF_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json();
}

/* Minimal query used only to confirm the token/account/site tag work. */
const MINI_QUERY = `
query Ping($accountTag: string!, $siteTag: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
        limit: 1
      ) {
        count
      }
    }
  }
}`;

/* Best-effort main query — field names are Cloudflare's documented RUM
   dimension/sum conventions as of when this Worker was written. If
   Cloudflare has since renamed a field, /api/summary will return a
   graphql_errors array naming exactly which field is wrong; run
   /api/debug-schema to see the current real field names and fix the
   query below accordingly. */
const SUMMARY_QUERY = `
query Summary($accountTag: string!, $siteTag: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      byDate: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
        limit: 1000
        orderBy: [date_ASC]
      ) {
        count
        sum { visits }
        dimensions { date }
      }
      byPage: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
        limit: 20
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestPath }
      }
      byCountry: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
        limit: 20
        orderBy: [count_DESC]
      ) {
        count
        dimensions { countryName }
      }
      byReferrer: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
        limit: 20
        orderBy: [count_DESC]
      ) {
        count
        dimensions { refererHost }
      }
    }
  }
}`;

const INTROSPECTION_QUERY = `
query Introspect {
  pageload: __type(name: "AccountRumPageloadEventsAdaptiveGroups") {
    fields { name type { name kind ofType { name kind } } }
  }
  pageloadDimensions: __type(name: "AccountRumPageloadEventsAdaptiveGroupsDimensions") {
    fields { name type { name kind } }
  }
  pageloadSum: __type(name: "AccountRumPageloadEventsAdaptiveGroupsSum") {
    fields { name type { name kind } }
  }
  pageloadFilter: __type(name: "AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject") {
    inputFields { name type { name kind ofType { name kind } } }
  }
}`;

function shapeSummary(r) {
  const acc = r?.data?.viewer?.accounts?.[0] || {};
  const byDate = (acc.byDate || []).map(g => ({
    date: g.dimensions?.date,
    pageviews: g.count,
    visits: g.sum?.visits || 0,
  }));
  const totalPageviews = byDate.reduce((s, d) => s + d.pageviews, 0);
  const totalVisits = byDate.reduce((s, d) => s + d.visits, 0);
  const byPage = (acc.byPage || []).map(g => ({ path: g.dimensions?.requestPath, pageviews: g.count }));
  const byCountry = (acc.byCountry || []).map(g => ({ country: g.dimensions?.countryName, pageviews: g.count }));
  const byReferrer = (acc.byReferrer || []).map(g => ({ referrer: g.dimensions?.refererHost || '(direct)', pageviews: g.count }));
  return { totalPageviews, totalVisits, byDate, topPages: byPage, topCountries: byCountry, topReferrers: byReferrer };
}
