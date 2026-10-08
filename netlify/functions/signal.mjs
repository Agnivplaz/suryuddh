/**
 * Netlify Function — the "you cannot host the game server here" signal.
 *
 * Netlify runs short-lived functions, not a long-running Node process, so the
 * arena (WebSocket matchmaking, the authoritative match, XP writes) has to live
 * elsewhere. Any /api/* or /ws request that reaches Netlify lands here instead
 * of a 404 page, and answers with the real addresses plus setup instructions.
 */
const CORS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export default async (req) => {
  const url = new URL(req.url);
  const venue = process.env.MATCH_SERVER_URL || null;
  const body = {
    ok: false,
    error: 'netlify_static_only',
    message: 'This Netlify site serves the game client. Online play needs the match server, '
      + 'which Netlify cannot host (it runs short-lived functions, not a WebSocket server).',
    requested: url.pathname,
    matchServer: venue,
    howTo: {
      deploy: 'https://github.com/<you>/<repo> → Render / Fly.io (see docs/05-DEPLOYMENT.md) — free tier is enough',
      then: venue
        ? 'This site should already proxy to ' + venue + ' (netlify.toml redirects).'
        : 'Set MATCH_SERVER_URL in Netlify → Site configuration → Environment variables, then redeploy.',
    },
    docs: 'discussion: docs/02-BACKEND-DECISION.md · why: docs/03-SYSTEM-DESIGN.md',
  };
  return new Response(JSON.stringify(body, null, 2), { status: 501, headers: CORS });
};
