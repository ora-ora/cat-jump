// cat-jump API 代理：只转发游戏用到的 Supabase 接口到 dzarlikttkosqkcfixbx.supabase.co
// * CORS 只允许游戏站点；按 IP 限流；把真实客户端 IP / 国家码用 HMAC 签名后转发（密钥是 Worker secret PROXY_SECRET，不在仓库里）
const UPSTREAM = "https://dzarlikttkosqkcfixbx.supabase.co";
const ORIGINS = ["https://meow.12121313.xyz", "https://ora-ora.github.io", "https://cat-jump-71a.pages.dev"];
const ALLOW = [
  { m: "POST", re: /^\/rest\/v1\/rpc\/(start_run|heartbeat|finish_run|surv_start|surv_finish)$/ },
  { m: "GET", re: /^\/rest\/v1\/(leaderboard_live|surv_board)$/ }
];
const mem = new Map(); // 后备的进程内限流（没有 ratelimit 绑定时）
function memLimit(ip, limit, period) {
  const now = Date.now(), k = ip, e = mem.get(k);
  if (!e || now - e.t > period * 1000) { mem.set(k, { t: now, n: 1 }); if (mem.size > 5000) mem.clear(); return true; }
  e.n++; return e.n <= limit;
}
function originOk(o) { return ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.cat-jump-71a\.pages\.dev$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o); }
function cors(o) {
  return { "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, prefer, accept-profile, content-profile, x-client-info",
    "Access-Control-Max-Age": "86400" };
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin") || "";
    const ok = originOk(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
    const h = ok ? cors(origin) : {};
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { headers: { ...h, "content-type": "application/json" } });
    if (!ok) return new Response("origin not allowed", { status: 403 });
    if (!ALLOW.some(a => a.m === req.method && a.re.test(url.pathname))) return new Response("not found", { status: 404, headers: h });
    const ip = req.headers.get("CF-Connecting-IP") || "";
    const country = (req.cf && req.cf.country) || req.headers.get("CF-IPCountry") || "";
    let allowed = true;
    // 两层限流：Cloudflare ratelimit 绑定（跨请求、最终一致）+ 进程内计数（同一 isolate 立即生效）
    // IPv6 按 /64 前缀计数，防止同一用户轮换地址绕过
    const rk = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip;
    if (env.RL) { try { const r = await env.RL.limit({ key: rk }); allowed = r.success; } catch (e) {} }
    if (allowed) allowed = memLimit(rk, 120, 60);
    if (!allowed) return new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), { status: 429, headers: { ...h, "content-type": "application/json", "Retry-After": "30" } });
    const fwd = new Headers();
    for (const k of ["apikey", "authorization", "content-type", "prefer", "accept", "accept-profile", "content-profile", "range"]) { const v = req.headers.get(k); if (v) fwd.set(k, v); }
    if (env.PROXY_SECRET && ip) {
      const ts = String(Math.floor(Date.now() / 1000));
      fwd.set("x-cat-ip", ip); fwd.set("x-cat-country", country); fwd.set("x-cat-ts", ts);
      fwd.set("x-cat-sig", await hmacHex(env.PROXY_SECRET, ip + "|" + country + "|" + ts));
    }
    const up = await fetch(UPSTREAM + url.pathname + url.search, { method: req.method, headers: fwd, body: req.method === "POST" ? await req.arrayBuffer() : undefined });
    const out = new Headers(h);
    for (const k of ["content-type", "content-range", "cache-control"]) { const v = up.headers.get(k); if (v) out.set(k, v); }
    return new Response(up.body, { status: up.status, headers: out });
  }
};
