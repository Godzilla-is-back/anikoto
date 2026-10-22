// appGuard.js - accepts only requests signed by the AniHub app.
// Signature = HMAC-SHA256(secret, `${METHOD}\n${host}\n${path+query}\n${ts}\n${nonce}`)
// (same format the Android app's RequestSigner sends, and vercel-protection/middleware.js).
// Works in Vercel Node, Vercel Edge and plain Node 18+ (Web Crypto, no dependencies).
//
// Env vars: APP_SIGN_SECRET (required), APP_SIGN_SECRET_PREV (optional, for rotation),
//           APP_SIGN_MAX_SKEW_MS (optional, default 120000, max 300000),
//           UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (recommended: one-time nonces
//           shared by all serverless instances). Without them a per-instance in-memory
//           nonce cache is used (still blocks quick replays on the same instance).
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

const seen = new Map(); // in-memory fallback: nonce -> expiry ms
function consumeNonceLocal(nonce, ttlMs) {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
  if (seen.has(nonce)) return false;
  seen.set(nonce, now + ttlMs);
  return true;
}

async function consumeNonce(nonce, ttlMs, env) {
  const url = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return consumeNonceLocal(nonce, ttlMs);
  const key = `app-sign:nonce:${nonce}`;
  const r = await fetch(
    `${url}/set/${encodeURIComponent(key)}/1?EX=${Math.ceil(ttlMs / 1000)}&NX=true`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error("nonce_store_unavailable");
  return (await r.json())?.result === "OK";
}

/**
 * Returns null if the request is allowed, otherwise { status, body }.
 * host = host the client called; target = encoded path + query exactly as sent.
 */
export async function checkAppRequest(method, host, target, getHeader) {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const secrets = [env.APP_SIGN_SECRET, env.APP_SIGN_SECRET_PREV].filter(Boolean);
  if (secrets.length === 0) return { status: 500, body: { error: "server_misconfigured" } }; // fail closed

  const ts = getHeader("x-req-ts") || "";
  const nonce = getHeader("x-req-nonce") || "";
  const sig = getHeader("x-req-sig") || "";
  const deny = { status: 401, body: { error: "unauthorized" } };
  if (!/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return deny;

  const configured = Number(env.APP_SIGN_MAX_SKEW_MS);
  const maxSkew = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 300000) : 120000;
  if (Math.abs(Date.now() - Number(ts)) > maxSkew) return deny;

  const message = `${method}\n${String(host).toLowerCase()}\n${target}\n${ts}\n${nonce}`;
  let ok = false;
  for (const secret of secrets) {
    if (safeEqual(await hmacHex(secret, message), sig)) { ok = true; break; }
  }
  if (!ok) return deny;

  try {
    if (!(await consumeNonce(nonce, maxSkew * 2, env))) return deny; // replayed request
  } catch {
    return { status: 503, body: { error: "auth_unavailable" } }; // never fall back silently
  }
  return null;
}

function firstHeader(v) {
  return String(v || "").split(",")[0].trim();
}

function deniedResponse(denied) {
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

/** Fetch-API style (Vercel Edge / worker.fetch): returns a Response to send, or null to continue. */
export async function guardRequest(request) {
  if (request.method === "OPTIONS") return null;
  const u = new URL(request.url);
  const host = firstHeader(request.headers.get("x-forwarded-host")) || u.hostname;
  const denied = await checkAppRequest(request.method, host, `${u.pathname}${u.search}`,
    (n) => request.headers.get(n));
  return denied ? deniedResponse(denied) : null;
}

/** Express middleware. */
export async function expressGuard(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const host = firstHeader(req.get("x-forwarded-host")) || req.hostname || firstHeader(req.get("host")).split(":")[0];
  const target = req.originalUrl || req.url; // raw path + query as received
  const denied = await checkAppRequest(req.method, host, target, (n) => req.get(n));
  if (!denied) return next();
  res.set("X-Server-Time", String(Date.now()));
  res.set("Cache-Control", "no-store");
  return res.status(denied.status).json(denied.body);
}
