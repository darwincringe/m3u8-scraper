// Cloudflare Worker: tiny fetch relay for the vidnest.fun API.
//
// Why: new.vidnest.fun sits behind a Cloudflare WAF rule that blocks
// datacenter IPs (our DigitalOcean droplet gets "Attention Required" 403 on
// every request), but it has to allow Cloudflare's own egress. A Worker
// therefore sees the API that the droplet cannot. We used to lean on a
// third-party worker for this; it died on 2026-10-15 (error 1101 on every
// call) and took Catflix/flixhq/ophim down with it, hence our own.
//
// Deploy (free tier is plenty; we make a few thousand calls a day):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> "Hello World"
//   2. Replace the code with this file, name it e.g. `vidnest-relay`, Deploy.
//   3. (Recommended) Settings -> Variables -> add RELAY_KEY = <random string>
//      so nobody else can use the relay.
//   4. On the server: in /var/www/m3u8-scraper/.env set
//        CATFLIX_RELAY=https://vidnest-relay.<you>.workers.dev/fetch?url=
//        CATFLIX_RELAY_KEY=<the same random string>
//      (CATFLIX_RELAY may list several relays, comma-separated; they are
//      tried in order.) Then `pm2 restart backend --update-env`.
//
// Usage: GET /fetch?url=<encoded https://new.vidnest.fun/...>
//        header X-Relay-Key: <RELAY_KEY>   (only if RELAY_KEY is set)
// Upstream status and body are passed through unchanged.

const ALLOWED_HOSTS = new Set(["new.vidnest.fun"]);

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/fetch") return new Response("not found", { status: 404 });

    if (env.RELAY_KEY && request.headers.get("x-relay-key") !== env.RELAY_KEY) {
      return new Response("forbidden", { status: 403 });
    }

    let target;
    try {
      target = new URL(searchParams.get("url") || "");
    } catch {
      return new Response("bad url", { status: 400 });
    }
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
      return new Response("host not allowed", { status: 403 });
    }

    const upstream = await fetch(target, {
      headers: {
        Referer: "https://vidnest.fun/",
        Origin: "https://vidnest.fun",
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      cf: { cacheTtl: 0 },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
