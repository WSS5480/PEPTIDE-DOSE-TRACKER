// Peptide Dose Guide sync: username + 4-digit PIN, token sessions, one JSON blob per person.
// Completely separate from every other app. Only the Dose Guide site may call it (CORS).
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const ORIGIN = process.env.DOSE_ORIGIN || "https://peptide-dose-guide.onrender.com";
const url = process.env.DATABASE_URL || "";
const pool = new Pool({
  connectionString: url,
  ssl: url && !/localhost|127\.0\.0\.1|host=\//.test(url) && !process.env.PGSSL_OFF ? { rejectUnauthorized: false } : false,
});
const q = (t, p) => pool.query(t, p);

const SCHEMA = `
create table if not exists dose_users (
  id serial primary key,
  name text not null,
  name_key text unique not null,
  pin_salt text not null,
  pin_hash text not null,
  fails int not null default 0,
  locked_until timestamptz,
  created timestamptz not null default now()
);
create table if not exists dose_tokens (
  token_hash text primary key,
  user_id int not null references dose_users(id) on delete cascade,
  expires timestamptz not null
);
create table if not exists dose_data (
  user_id int primary key references dose_users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated timestamptz not null default now()
);`;

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o === ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || "")) {
    res.set({ "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Max-Age": "86400" });
  }
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "2mb" }));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// small in-memory rate limit per IP
const hits = new Map();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + req.ip, now = Date.now(), a = (hits.get(k) || []).filter((t) => now - t < ms);
  if (a.length >= max) return bad(res, "Too many tries. Wait a few minutes.", 429);
  a.push(now); hits.set(k, a); next();
};

const nameKey = (n) => n.toLowerCase().replace(/\s+/g, " ").trim();
const cleanName = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 40);
const cleanPin = (v) => String(v || "").replace(/\D/g, "");
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString("hex");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const th = (t) => crypto.createHash("sha256").update(t).digest("hex");

async function issue(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await q("delete from dose_tokens where expires < now()");
  await q("insert into dose_tokens(token_hash, user_id, expires) values ($1,$2, now() + interval '180 days')", [th(token), userId]);
  return token;
}
const auth = wrap(async (req, res, next) => {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
  if (!m) return bad(res, "Sign in again.", 401);
  const { rows: [u] } = await q("select u.id, u.name from dose_tokens t join dose_users u on u.id = t.user_id where t.token_hash = $1 and t.expires > now()", [th(m[1])]);
  if (!u) return bad(res, "Sign in again.", 401);
  req.user = u; req.tokenHash = th(m[1]); next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/register", limit("reg", 10, 60 * 60 * 1000), wrap(async (req, res) => {
  const name = cleanName(req.body?.name), pin = cleanPin(req.body?.pin);
  if (name.length < 3) return bad(res, "Pick a login name of at least 3 letters.");
  if (!/^\d{4}$/.test(pin)) return bad(res, "The PIN must be exactly 4 digits.");
  const salt = crypto.randomBytes(16).toString("hex");
  try {
    const { rows: [u] } = await q("insert into dose_users(name, name_key, pin_salt, pin_hash) values ($1,$2,$3,$4) returning id, name", [name, nameKey(name), salt, hashPin(pin, salt)]);
    res.json({ ok: true, token: await issue(u.id), name: u.name });
  } catch (e) {
    if (e.code === "23505") return bad(res, "That name is taken. Pick another.", 409);
    throw e;
  }
}));

app.post("/login", limit("login", 20, 15 * 60 * 1000), wrap(async (req, res) => {
  const name = cleanName(req.body?.name), pin = cleanPin(req.body?.pin);
  const { rows: [u] } = await q("select * from dose_users where name_key = $1", [nameKey(name)]);
  const fail = () => bad(res, "Name or PIN is wrong.", 401);
  if (!u) { hashPin(pin || "0000", "00"); return fail(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) return bad(res, "Too many wrong PINs. Try again in 15 minutes.", 429);
  if (!/^\d{4}$/.test(pin) || !same(hashPin(pin, u.pin_salt), u.pin_hash)) {
    const fails = u.fails + 1;
    if (fails >= 5) await q("update dose_users set fails = 0, locked_until = now() + interval '15 minutes' where id = $1", [u.id]);
    else await q("update dose_users set fails = $2 where id = $1", [u.id, fails]);
    return fail();
  }
  await q("update dose_users set fails = 0, locked_until = null where id = $1", [u.id]);
  res.json({ ok: true, token: await issue(u.id), name: u.name });
}));

app.get("/vials", auth, wrap(async (req, res) => {
  const { rows: [r] } = await q("select data, updated from dose_data where user_id = $1", [req.user.id]);
  res.json({ data: r ? r.data : null, updated: r ? r.updated : null, name: req.user.name });
}));
app.put("/vials", auth, wrap(async (req, res) => {
  const d = req.body?.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return bad(res, "Bad data.");
  const json = JSON.stringify(d);
  if (json.length > 1500000) return bad(res, "Too much data.", 413);
  await q("insert into dose_data(user_id, data, updated) values ($1,$2::jsonb, now()) on conflict (user_id) do update set data = excluded.data, updated = now()", [req.user.id, json]);
  res.json({ ok: true });
}));
app.post("/logout", auth, wrap(async (req, res) => {
  await q("delete from dose_tokens where token_hash = $1", [req.tokenHash]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => { console.error(err); bad(res, "Server error.", 500); });

(async () => {
  await q(SCHEMA);
  app.listen(process.env.PORT || 3000, () => console.log("Dose Guide sync up"));
})().catch((e) => { console.error(e); process.exit(1); });
