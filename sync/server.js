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
/* Same rules as every other app in My Apps: no grace days. Sync locks the day after the end date; reminders come 5, 3, 1 days before and on the last day. */
async function myapps(path, body) {
  if (!MYAPPS_URL || !MYAPPS_SECRET) return null;
  try {
    const r = await fetch(MYAPPS_URL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ slug: "dose", secret: MYAPPS_SECRET }, body)), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : null;
  } catch (e) { return null; }
}
/* Like myapps() but keeps the error text, for calls a person is waiting on. */
async function myappsTry(path, body) {
  if (!MYAPPS_URL || !MYAPPS_SECRET) return { ok: false, status: 503, error: "Payments are not set up yet." };
  try {
    const r = await fetch(MYAPPS_URL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ slug: "dose", secret: MYAPPS_SECRET }, body)), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? Object.assign({ ok: true }, j) : { ok: false, status: r.status, error: j.error || "My Apps said " + r.status };
  } catch (e) { return { ok: false, status: 502, error: "Could not reach the payment server. Try again in a minute." }; }
}
const tenantOf = (u) => "dose:" + u.id;
/* Price, Cash App link and whether this login has an "I paid" request waiting. Price and tag are set once in My Apps. */
let payLast = { price: "5", link: "", cashtag: "" };
async function payInfo(u) {
  const j = await myapps("/api/v1/pay/info", { tenant: tenantOf(u) });
  if (!j) return Object.assign({ pending: false }, payLast);
  payLast = { price: String(j.price || "5"), link: /^https:\/\//.test(j.link || "") ? j.link : "", cashtag: j.tag || "" };
  return Object.assign({ pending: !!j.pending }, payLast);
}
/* "state": ok | trial | due | locked, plus days left. Fails open if My Apps cannot be reached. */
async function accountState(u) {
  const plan = await myapps("/api/v1/trial", { tenant: tenantOf(u), tenantName: u.name });
  const pay = await payInfo(u);
  if (!plan) return { state: "ok", pay, unknown: true };
  const left = plan.days_left == null ? null : plan.days_left;
  const end = plan.expires_on ? String(plan.expires_on).slice(0, 10) : null;
  let state = "ok";
  if (plan.plan === "pro") state = left != null && left <= 5 ? "due" : (plan.source === "trial" ? "trial" : "ok");
  else state = end ? "locked" : "ok";
  return { state, days_left: left, ends: end, trial: plan.source === "trial", pay, pending: !!pay.pending };
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
create table if not exists dose_inventory (id int primary key, data jsonb not null default '[]'::jsonb, updated timestamptz not null default now());
alter table dose_users add column if not exists slug text;
alter table dose_users add column if not exists cashtag text not null default '';
create unique index if not exists dose_users_slug on dose_users(slug) where slug is not null;
create table if not exists dose_user_prices (user_id int not null references dose_users(id) on delete cascade, k text not null, price numeric(10,2) not null, primary key (user_id, k));
create table if not exists dose_orders (
  id serial primary key,
  seller_id int not null references dose_users(id) on delete cascade,
  customer_name text not null,
  customer_contact text not null,
  lines jsonb not null,
  total numeric(10,2) not null,
  status text not null default 'new',
  created timestamptz not null default now()
);
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
    res.set({ "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS", "Access-Control-Max-Age": "86400" });
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
/* Subscription, same flow as the other apps: pay on Cash App, tap "I paid", the owner confirms in My Apps. */
app.post("/pay", auth, limit("pay", 12, 60 * 60 * 1000), wrap(async (req, res) => {
  const r = await myappsTry("/api/v1/pay/request", { tenant: tenantOf(req.user), tenantName: req.user.name });
  if (!r.ok) return bad(res, r.error, r.status >= 500 ? 502 : 400);
  res.json({ ok: true, ref: r.ref, account: await stateFor(req.user, true) });
}));
app.get("/account", auth, wrap(async (req, res) => { res.json({ account: await stateFor(req.user, true) }); }));
/* Phone reminders before the end date (5, 3, 1 days and the last day). My Apps sends them. */
app.get("/push-key", auth, wrap(async (req, res) => {
  const r = await myappsTry("/api/v1/push/key", {});
  if (!r.ok || !r.key) return bad(res, "Reminders are not set up yet.", 503);
  res.json({ key: r.key });
}));
app.post("/push", auth, limit("push", 30, 60 * 60 * 1000), wrap(async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return bad(res, "Bad request.");
  const r = await myappsTry("/api/v1/push/subscribe", { tenant: tenantOf(req.user), subscription: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh || ""), auth: String(sub.keys.auth || "") } } });
  if (!r.ok) return bad(res, r.status >= 500 ? "Could not turn reminders on. Try again in a minute." : r.error, r.status >= 500 ? 502 : 400);
  res.json({ ok: true });
}));
/* Owner tools: the login named Owner lists users and decides who may see Owner's prices (prices only, never cost). */
const owner = (req, res, next) => (nameKey(req.user.name) === "owner" ? next() : bad(res, "Owner only.", 403));
app.get("/owner/users", auth, owner, wrap(async (req, res) => {
  const { rows } = await q(`select u.id, u.name, u.created, u.disabled, u.can_price, (case when jsonb_typeof(d.data->'vials') = 'array' then jsonb_array_length(d.data->'vials') else 0 end) vials
    from dose_users u left join dose_data d on d.user_id = u.id where u.name_key <> 'owner' order by u.created desc`);
  res.json({ users: rows });
}));
app.post("/owner/users/:id", auth, owner, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id > 2147483647 || typeof req.body?.can_price !== "boolean") return bad(res, "Bad request.");
  const r = await q("update dose_users set can_price = $2 where id = $1 and name_key <> 'owner'", [id, req.body.can_price]);
  if (!r.rowCount) return bad(res, "No such login.", 404);
  res.json({ ok: true });
}));
app.delete("/owner/users/:id", auth, owner, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id > 2147483647) return bad(res, "Bad id.");
  const r = await q("delete from dose_users where id = $1 and name_key <> 'owner'", [id]);   /* tokens and data go with it (cascade) */
  if (!r.rowCount) return bad(res, "No such login.", 404);
  stCache.delete(id);
  res.json({ ok: true });
}));
/* Owner's own full list (cost, price, qty) is backed up here, readable ONLY by the Owner login. Never sent to anyone else. */
app.get("/owner/inventory", auth, owner, wrap(async (req, res) => {
  const { rows: [r] } = await q("select data, updated from dose_inventory where id = 1");
  res.json({ items: r ? r.data : [], updated: r ? r.updated : null });
}));
app.put("/owner/inventory", auth, owner, wrap(async (req, res) => {
  const a = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!a || a.length > 3000) return bad(res, "Bad data.");
  const edits = req.body?.qtyEdits && typeof req.body.qtyEdits === "object" && !Array.isArray(req.body.qtyEdits) ? req.body.qtyEdits : {};
  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined);
  const inc = a.map((x) => ({ id: String(x?.id || "").slice(0, 40), n: String(x?.n || "").slice(0, 60), s: String(x?.s || "").slice(0, 20), cost: num(x?.cost), price: (num(x?.price) < 100000 ? num(x?.price) : undefined), qty: num(x?.qty) })).filter((x) => x.id && x.n);
  if (!inc.length && req.body?.clear !== true) return bad(res, "Refusing to save an empty list.");
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("insert into dose_inventory(id, data) values (1, '[]'::jsonb) on conflict (id) do nothing");
    const { rows: [r] } = await c.query("select data from dose_inventory where id = 1 for update");
    const old = new Map((Array.isArray(r.data) ? r.data : []).map((x) => [x.id, x]));
    /* Quantity belongs to the server: customer orders lower it. The app only changes it by an explicit edit. */
    const items = inc.map((x) => {
      const o = old.get(x.id); const e = typeof edits[x.id] === "number" && isFinite(edits[x.id]) ? Math.trunc(edits[x.id]) : undefined;
      x.qty = o && typeof o.qty === "number" ? Math.max(0, o.qty + (e || 0)) : (x.qty !== undefined ? Math.floor(x.qty) : 0);   /* qtyEdits are CHANGES (+/-), so orders placed meanwhile are kept */
      return x;
    });
    await c.query("update dose_inventory set data = $1::jsonb, updated = now() where id = 1", [JSON.stringify(items)]);
    await c.query("commit");
    res.json({ ok: true, count: items.length, items });
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}));

app.put("/owner/prices", auth, owner, wrap(async (req, res) => {
  const a = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!a || a.length > 2000) return bad(res, "Bad data.");
  const items = a.map((x) => ({ n: String(x?.n || "").slice(0, 60), s: String(x?.s || "").slice(0, 20), p: typeof x?.p === "number" ? x.p : NaN })).filter((x) => x.n && isFinite(x.p) && x.p >= 0);
  if (!items.length && req.body?.clear !== true) return bad(res, "Refusing to publish an empty price list.");
  await q("insert into dose_prices(id, data, updated) values (1, $1::jsonb, now()) on conflict (id) do update set data = excluded.data, updated = now()", [JSON.stringify(items)]);
  res.json({ ok: true, count: items.length });
}));
/* Anyone signed in may ask. Only Owner and checked users get items back. Cost is never stored here. */
app.get("/prices", auth, wrap(async (req, res) => {
  const isOwner = nameKey(req.user.name) === "owner";
  const { rows: [u] } = await q("select can_price from dose_users where id = $1", [req.user.id]);
  const allowed = isOwner || !!(u && u.can_price);
  if (!allowed) return res.json({ allowed: false, owner: false, items: [] });
  const { rows: [inv] } = await q("select data, updated from dose_inventory where id = 1");
  const list = inv && Array.isArray(inv.data) ? inv.data.filter((x) => typeof x.price === "number" && x.price > 0) : [];
  if (list.length) return res.json({ allowed: true, owner: isOwner, items: list.map((x) => ({ n: x.n, s: x.s, p: x.price, q: typeof x.qty === "number" ? x.qty : 0 })), updated: inv.updated });
  const { rows: [r] } = await q("select data, updated from dose_prices where id = 1");
  res.json({ allowed: true, owner: isOwner, items: r ? r.data : [], updated: r ? r.updated : null });
}));

/* ---------- customer ordering ----------
   Each login has a shop link. The customer sees the shared stock (Owner's quantities) at THAT login's prices,
   orders, and pays that login's Cash App. Stock drops when the order is placed; cancelling puts it back. */
const keyOf = (n, s) => (String(n || "").toLowerCase().trim() + "|" + String(s || "").toLowerCase().trim());
const cleanTag = (v) => String(v || "").replace(/^\$/, "").trim();
const TAG_OK = /^[A-Za-z0-9_]{1,20}$/;
async function ensureSlug(userId) {
  const { rows: [u] } = await q("select slug from dose_users where id = $1", [userId]);
  if (u && u.slug) return u.slug;
  for (let i = 0; i < 6; i++) {
    const slug = crypto.randomBytes(5).toString("hex");
    try { await q("update dose_users set slug = $2 where id = $1 and slug is null", [userId, slug]); const { rows: [x] } = await q("select slug from dose_users where id = $1", [userId]); if (x && x.slug) return x.slug; } catch (e) { if (e.code !== "23505") throw e; }
  }
  throw new Error("slug");
}
app.get("/me/shop", auth, wrap(async (req, res) => {
  const slug = await ensureSlug(req.user.id);
  const { rows: [u] } = await q("select cashtag from dose_users where id = $1", [req.user.id]);
  res.json({ slug, cashtag: u ? u.cashtag : "" });
}));
app.put("/me/shop", auth, wrap(async (req, res) => {
  const tag = cleanTag(req.body?.cashtag);
  if (tag && !TAG_OK.test(tag)) return bad(res, "That Cash App tag does not look right. Letters, numbers and underscore only.");
  await q("update dose_users set cashtag = $2 where id = $1", [req.user.id, tag]);
  res.json({ ok: true, cashtag: tag });
}));
app.get("/me/prices", auth, wrap(async (req, res) => {
  const { rows } = await q("select k, price from dose_user_prices where user_id = $1", [req.user.id]);
  const prices = {}; rows.forEach((r) => { prices[r.k] = Number(r.price); });
  res.json({ prices });
}));
app.put("/me/prices", auth, wrap(async (req, res) => {
  const p = req.body?.prices;
  if (!p || typeof p !== "object" || Array.isArray(p)) return bad(res, "Bad data.");
  const ents = Object.entries(p).filter(([k, v]) => typeof k === "string" && k.length <= 90 && typeof v === "number" && isFinite(v) && v > 0 && v < 100000).slice(0, 3000);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from dose_user_prices where user_id = $1", [req.user.id]);
    for (const [k, v] of ents) await c.query("insert into dose_user_prices(user_id, k, price) values ($1,$2,$3)", [req.user.id, k.toLowerCase(), Math.round(v * 100) / 100]);
    await c.query("commit");
    res.json({ ok: true, count: ents.length });
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}));
async function sellerCatalog(u) {
  const { rows: [inv] } = await q("select data from dose_inventory where id = 1");
  const items = inv && Array.isArray(inv.data) ? inv.data : [];
  let own = null;
  if (nameKey(u.name) !== "owner") { const { rows } = await q("select k, price from dose_user_prices where user_id = $1", [u.id]); own = {}; rows.forEach((r) => { own[r.k] = Number(r.price); }); }
  return items.map((x) => { const k = keyOf(x.n, x.s); const price = own ? own[k] : x.price; return { k, n: x.n, s: x.s, price, qty: typeof x.qty === "number" ? x.qty : 0 }; }).filter((x) => typeof x.price === "number" && x.price > 0);
}
app.get("/shop/:slug", limit("shop", 240, 60 * 60 * 1000), wrap(async (req, res) => {
  const { rows: [u] } = await q("select id, name, cashtag, disabled from dose_users where slug = $1", [String(req.params.slug || "").slice(0, 40)]);
  if (!u || u.disabled) return bad(res, "This shop link is not active.", 404);
  const items = (await sellerCatalog(u)).filter((x) => x.qty > 0);
  res.json({ shop: u.name, pay: !!u.cashtag, items });
}));
app.post("/shop/:slug/order", limit("order", 20, 60 * 60 * 1000), wrap(async (req, res) => {
  const name = String(req.body?.name || "").replace(/\s+/g, " ").trim().slice(0, 60), contact = String(req.body?.contact || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const want = Array.isArray(req.body?.items) ? req.body.items.slice(0, 40) : [];
  if (name.length < 2) return bad(res, "Enter your name.");
  if (contact.length < 3) return bad(res, "Enter a phone number or email so the seller can reach you.");
  let sum = 0; want.forEach((w) => { sum += Math.floor(Number(w?.qty)) || 0; }); if (sum > 30) return bad(res, "Please order 30 items or fewer at a time.");
  const asked = new Map(); want.forEach((w) => { const k = String(w?.k || "").toLowerCase(); const n = Math.floor(Number(w?.qty)); if (k && n > 0 && n <= 99) asked.set(k, (asked.get(k) || 0) + n); });
  if (!asked.size) return bad(res, "Pick at least one item.");
  const { rows: [u] } = await q("select id, name, cashtag, disabled from dose_users where slug = $1", [String(req.params.slug || "").slice(0, 40)]);
  if (!u || u.disabled) return bad(res, "This shop link is not active.", 404);
  const c = await pool.connect();
  try {
    await c.query("begin");
    const { rows: [inv] } = await c.query("select data from dose_inventory where id = 1 for update");
    const items = inv && Array.isArray(inv.data) ? inv.data : [];
    let own = null;
    if (nameKey(u.name) !== "owner") { const { rows } = await c.query("select k, price from dose_user_prices where user_id = $1", [u.id]); own = {}; rows.forEach((r) => { own[r.k] = Number(r.price); }); }
    const lines = []; let total = 0;
    for (const [k, n] of asked) {
      const it = items.find((x) => keyOf(x.n, x.s) === k);
      const price = it ? (own ? own[k] : it.price) : undefined;
      if (!it || !(price > 0)) { await c.query("rollback"); return bad(res, "One of those items is no longer available."); }
      const have = typeof it.qty === "number" ? it.qty : 0;
      if (have < n) { await c.query("rollback"); return bad(res, (have > 0 ? "Only " + have + " left of " : "Sold out: ") + it.n + " " + it.s + ".", 409); }
      lines.push({ k, id: it.id, n: it.n, s: it.s, qty: n, price }); total += n * price; it.qty = have - n;
    }
    total = Math.round(total * 100) / 100;
    await c.query("update dose_inventory set data = $1::jsonb, updated = now() where id = 1", [JSON.stringify(items)]);
    const { rows: [o] } = await c.query("insert into dose_orders(seller_id, customer_name, customer_contact, lines, total) values ($1,$2,$3,$4::jsonb,$5) returning id", [u.id, name, contact, JSON.stringify(lines), total]);
    await c.query("commit");
    res.json({ ok: true, id: o.id, total, lines, shop: u.name, pay: u.cashtag ? "https://cash.app/$" + u.cashtag + "/" + total.toFixed(2) : null });
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}));
app.get("/me/orders", auth, wrap(async (req, res) => {
  const isOwner = nameKey(req.user.name) === "owner";
  const { rows } = await q(`select o.id, o.customer_name, o.customer_contact, o.lines, o.total, o.status, o.created, u.name seller from dose_orders o join dose_users u on u.id = o.seller_id
    where ($2 or o.seller_id = $1) order by o.created desc limit 100`, [req.user.id, isOwner]);
  res.json({ orders: rows.map((r) => ({ id: r.id, name: r.customer_name, contact: r.customer_contact, lines: r.lines, total: Number(r.total), status: r.status, created: r.created, seller: r.seller })) });
}));
app.post("/me/orders/:id", auth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), st = String(req.body?.status || "");
  if (!id || id > 2147483647 || !["new", "paid", "cancelled"].includes(st)) return bad(res, "Bad request.");
  const isOwner = nameKey(req.user.name) === "owner";
  const c = await pool.connect();
  try {
    await c.query("begin");
    const { rows: [o] } = await c.query("select id, seller_id, lines, status from dose_orders where id = $1 for update", [id]);
    if (!o || (!isOwner && o.seller_id !== req.user.id)) { await c.query("rollback"); return bad(res, "No such order.", 404); }
    if (o.status !== "cancelled" && st === "cancelled") {   /* put the stock back */
      const { rows: [inv] } = await c.query("select data from dose_inventory where id = 1 for update");
      const items = inv && Array.isArray(inv.data) ? inv.data : [];
      (o.lines || []).forEach((l) => { const it = items.find((x) => keyOf(x.n, x.s) === l.k); if (it) it.qty = (typeof it.qty === "number" ? it.qty : 0) + l.qty; });
      await c.query("update dose_inventory set data = $1::jsonb, updated = now() where id = 1", [JSON.stringify(items)]);
    } else if (o.status === "cancelled" && st !== "cancelled") { await c.query("rollback"); return bad(res, "A cancelled order cannot be reopened. Ask the customer to order again."); }
    await c.query("update dose_orders set status = $2 where id = $1", [id, st]);
    await c.query("commit");
    res.json({ ok: true });
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
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
