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

/* My Apps (the owner's manager) holds trials, payments and the Cash App tag. Same pattern as the other apps. */
const MYAPPS_URL = (process.env.MYAPPS_URL || "").replace(/\/$/, "");
const MYAPPS_SECRET = process.env.MYAPPS_SECRET || "";
const GRACE_DAYS = 3;   /* after the paid date passes, sync keeps working this many days while the reminder shows */
async function myapps(path, body) {
  if (!MYAPPS_URL || !MYAPPS_SECRET) return null;
  try {
    const r = await fetch(MYAPPS_URL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ slug: "dose", secret: MYAPPS_SECRET }, body)), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : null;
  } catch (e) { return null; }
}
let payCache = { at: 0, v: null };
async function payInfo() {
  if (payCache.v && Date.now() - payCache.at < 5 * 60 * 1000) return payCache.v;
  const j = await myapps("/api/v1/pay-info", {});
  if (j) payCache = { at: Date.now(), v: { price: j.price || "5", link: j.link || "", cashtag: j.cashtag || "" } };
  return payCache.v || { price: "5", link: "", cashtag: "" };
}
/* "state": ok | trial | due | grace | locked, plus days left. Fails open if My Apps cannot be reached. */
async function accountState(u) {
  const key = "dose:" + u.id;
  const pay = await payInfo();
  let plan = await myapps("/api/v1/trial", { tenant: key, tenantName: u.name }) ;
  if (!plan) return { state: "ok", pay, unknown: true };
  const left = plan.days_left == null ? null : plan.days_left;
  const end = plan.expires_on ? String(plan.expires_on).slice(0, 10) : null;
  const today = new Date().toISOString().slice(0, 10);
  const over = end ? Math.round((new Date(today) - new Date(end)) / 86400000) : 0;
  let state = "ok";
  if (plan.plan === "pro") state = plan.source === "trial" ? (left != null && left <= 5 ? "due" : "trial") : (left != null && left <= 5 ? "due" : "ok");
  else state = end && over <= GRACE_DAYS ? "grace" : (end ? "locked" : "ok");
  return { state, days_left: left, ends: end, trial: plan.source === "trial", pay };
}
const stCache = new Map();
async function stateFor(u, fresh) {
  const c = stCache.get(u.id);
  if (!fresh && c && Date.now() - c.at < 60000) return c.v;
  const v = await accountState(u);
  if (!v.unknown) stCache.set(u.id, { at: Date.now(), v });
  return v;
}
const DIGITS = (v) => String(v || "").replace(/\D/g, "");

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
alter table dose_users add column if not exists whatsapp text not null default '';
alter table dose_users add column if not exists disabled boolean not null default false;
alter table dose_users add column if not exists can_price boolean not null default false;
create table if not exists dose_prices (id int primary key, data jsonb not null default '[]'::jsonb, updated timestamptz not null default now());
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
  const { rows: [u] } = await q("select u.id, u.name, u.disabled from dose_tokens t join dose_users u on u.id = t.user_id where t.token_hash = $1 and t.expires > now()", [th(m[1])]);
  if (!u || u.disabled) return bad(res, "Sign in again.", 401);
  req.user = u; req.tokenHash = th(m[1]); next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/register", limit("reg", 10, 60 * 60 * 1000), wrap(async (req, res) => {
  const name = cleanName(req.body?.name), pin = cleanPin(req.body?.pin), wa = DIGITS(req.body?.whatsapp);
  if (name.length < 3) return bad(res, "Pick a login name of at least 3 letters.");
  if (!/^\d{4}$/.test(pin)) return bad(res, "The PIN must be exactly 4 digits.");
  const salt = crypto.randomBytes(16).toString("hex");
  try {
    const { rows: [u] } = await q("insert into dose_users(name, name_key, pin_salt, pin_hash, whatsapp) values ($1,$2,$3,$4,$5) returning id, name", [name, nameKey(name), salt, hashPin(pin, salt), wa]);
    res.json({ ok: true, token: await issue(u.id), name: u.name, account: await stateFor(u, true) });
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
  if (u.disabled) return bad(res, "This login is turned off. Contact Steve.", 403);
  await q("update dose_users set fails = 0, locked_until = null where id = $1", [u.id]);
  res.json({ ok: true, token: await issue(u.id), name: u.name, account: await stateFor(u, true) });
}));

app.get("/vials", auth, wrap(async (req, res) => {
  const { rows: [r] } = await q("select data, updated from dose_data where user_id = $1", [req.user.id]);
  const account = await stateFor(req.user, false);
  if (account.state === "locked") return res.status(402).json({ error: "Subscription ended.", account });
  res.json({ data: r ? r.data : null, updated: r ? r.updated : null, name: req.user.name, account });
}));
app.put("/vials", auth, wrap(async (req, res) => {
  const d = req.body?.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return bad(res, "Bad data.");
  const account = await stateFor(req.user, false);
  if (account.state === "locked") return res.status(402).json({ error: "Subscription ended.", account });
  const json = JSON.stringify(d);
  if (json.length > 1500000) return bad(res, "Too much data.", 413);
  await q("insert into dose_data(user_id, data, updated) values ($1,$2::jsonb, now()) on conflict (user_id) do update set data = excluded.data, updated = now()", [req.user.id, json]);
  res.json({ ok: true, account });
}));
/* Owner tools: the login named Owner lists users and decides who may see Owner's prices (prices only, never cost). */
const owner = (req, res, next) => (nameKey(req.user.name) === "owner" ? next() : bad(res, "Owner only.", 403));
app.get("/owner/users", auth, owner, wrap(async (req, res) => {
  const { rows } = await q(`select u.id, u.name, u.created, u.disabled, u.can_price, coalesce(jsonb_array_length(d.data->'vials'), 0) vials
    from dose_users u left join dose_data d on d.user_id = u.id where u.name_key <> 'owner' order by u.created desc`);
  res.json({ users: rows });
}));
app.post("/owner/users/:id", auth, owner, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || typeof req.body?.can_price !== "boolean") return bad(res, "Bad request.");
  const r = await q("update dose_users set can_price = $2 where id = $1 and name_key <> 'owner'", [id, req.body.can_price]);
  if (!r.rowCount) return bad(res, "No such login.", 404);
  res.json({ ok: true });
}));
app.put("/owner/prices", auth, owner, wrap(async (req, res) => {
  const a = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!a || a.length > 2000) return bad(res, "Bad data.");
  const items = a.map((x) => ({ n: String(x?.n || "").slice(0, 60), s: String(x?.s || "").slice(0, 20), p: Number(x?.p) })).filter((x) => x.n && isFinite(x.p) && x.p >= 0);
  await q("insert into dose_prices(id, data, updated) values (1, $1::jsonb, now()) on conflict (id) do update set data = excluded.data, updated = now()", [JSON.stringify(items)]);
  res.json({ ok: true, count: items.length });
}));
/* Anyone signed in may ask. Only Owner and checked users get items back. Cost is never stored here. */
app.get("/prices", auth, wrap(async (req, res) => {
  const isOwner = nameKey(req.user.name) === "owner";
  const { rows: [u] } = await q("select can_price from dose_users where id = $1", [req.user.id]);
  const allowed = isOwner || !!(u && u.can_price);
  if (!allowed) return res.json({ allowed: false, owner: false, items: [] });
  const { rows: [r] } = await q("select data, updated from dose_prices where id = 1");
  res.json({ allowed: true, owner: isOwner, items: r ? r.data : [], updated: r ? r.updated : null });
}));
app.post("/logout", auth, wrap(async (req, res) => {
  await q("delete from dose_tokens where token_hash = $1", [req.tokenHash]);
  res.json({ ok: true });
}));

/* My Apps (the owner's manager) reads and manages subscribers here, with the shared app secret. */
const platform = (req, res, next) => {
  const k = String(req.headers["x-platform-key"] || "");
  if (!MYAPPS_SECRET || k.length !== MYAPPS_SECRET.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(MYAPPS_SECRET))) return bad(res, "No.", 401);
  next();
};
app.get("/api/platform/members", platform, wrap(async (req, res) => {
  const { rows } = await q(`select u.id, u.name, u.whatsapp, u.disabled, u.created,
      coalesce(jsonb_array_length(d.data->'vials'), 0) vials,
      coalesce((select sum(jsonb_array_length(v->'log')) from jsonb_array_elements(d.data->'vials') v), 0)::int doses
    from dose_users u left join dose_data d on d.user_id = u.id order by u.created desc`);
  res.json({ members: rows.map((r) => ({ key: "dose:" + r.id, id: String(r.id), name: r.name, whatsapp: r.whatsapp, disabled: r.disabled, created: r.created, vials: r.vials, doses: r.doses })) });
}));
app.post("/api/platform/members/:id", platform, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), act = String(req.body?.action || "");
  if (!id) return bad(res, "Bad id.");
  if (act === "disable" || act === "enable") {
    await q("update dose_users set disabled = $2 where id = $1", [id, act === "disable"]);
    if (act === "disable") await q("delete from dose_tokens where user_id = $1", [id]);
    stCache.delete(id);
  } else if (act === "setpin") {
    const pin = cleanPin(req.body?.pin);
    if (!/^\d{4}$/.test(pin)) return bad(res, "The PIN must be exactly 4 digits.");
    const salt = crypto.randomBytes(16).toString("hex");
    const r = await q("update dose_users set pin_salt = $2, pin_hash = $3 where id = $1", [id, salt, hashPin(pin, salt)]);
    if (!r.rowCount) return bad(res, "No such login.", 404);
    await q("delete from dose_tokens where user_id = $1", [id]);
  } else if (act === "plan") stCache.delete(id);
  res.json({ ok: true });
}));
app.get("/", (req, res) => res.redirect(ORIGIN));

app.use((err, req, res, next) => { console.error(err); bad(res, "Server error.", 500); });

(async () => {
  await q(SCHEMA);
  app.listen(process.env.PORT || 3000, () => console.log("Dose Guide sync up"));
})().catch((e) => { console.error(e); process.exit(1); });
