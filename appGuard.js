// appGuard.js - accepts only requests signed by the AniHub app.
// Works in Vercel Node, Vercel Edge and plain Node 18+ (uses Web Crypto, no dependencies).
//
// Env vars: APP_SIGN_SECRET (required), APP_SIGN_SECRET_PREV (optional, for rotation),
//           APP_SIGN_MAX_SKEW_MS (optional, default 120000)
const enc = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns null if the request is allowed, otherwise { status, body } to send back. */
export async function checkAppRequest(method, pathname, getHeader) {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const secrets = [env.APP_SIGN_SECRET, env.APP_SIGN_SECRET_PREV].filter(Boolean);
  if (secrets.length === 0) return { status: 500, body: { error: "server_misconfigured" } }; // fail closed

  const ts = getHeader("x-req-ts") || "";
  const nonce = getHeader("x-req-nonce") || "";
  const sig = getHeader("x-req-sig") || "";
  const deny = { status: 401, body: { error: "unauthorized" } };
  if (!/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return deny;

  const maxSkew = Number(env.APP_SIGN_MAX_SKEW_MS) || 120000;
  if (Math.abs(Date.now() - Number(ts)) > maxSkew) return deny;

  const message = `${method}\n${pathname}\n${ts}\n${nonce}`;
  for (const secret of secrets) {
    if (safeEqual(await hmacHex(secret, message), sig)) return null;
  }
  return deny;
}

/** Fetch-API style (Vercel Edge / worker.fetch): returns a Response to send, or null to continue. */
export async function guardRequest(request) {
  const denied = await checkAppRequest(request.method, new URL(request.url).pathname,
    (n) => request.headers.get(n));
  if (!denied) return null;
  return new Response(JSON.stringify(denied.body), {
    status: denied.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Server-Time",
      "X-Server-Time": String(Date.now()),
    },
  });
}

/** Express middleware. */
export async function expressGuard(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const pathname = new URL(req.originalUrl || req.url, "http://localhost").pathname;
  const denied = await checkAppRequest(req.method, pathname, (n) => req.get(n));
  if (!denied) return next();
  res.set("X-Server-Time", String(Date.now()));
  res.set("Cache-Control", "no-store");
  return res.status(denied.status).json(denied.body);
}
