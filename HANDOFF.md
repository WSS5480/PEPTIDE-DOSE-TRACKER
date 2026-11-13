# HANDOFF: Peptide Dose Guide

Update this file in the same commit as every change.

## Start here (rules from Steve, owner)
- Terse, voice-dictated style. Give short, practical answers with the reasoning.
- NEVER reference or link 360 Medical or its store/tracker apps in this app. It is completely separate.
- End replies with https://peptide-dose-guide.onrender.com
- Values to copy go in their own copy box, no stray spaces.
- Wrap info (dropdowns, cards) instead of sideways-scrolling tables, especially on phones. Align table headers over their data.
- Summary tiles drill down to detail with a back button.
- Tell him to close and reopen the app (or pull down) to load updates.
- Doses shown only from approved labels, published human studies or guidelines. Vendor-only doses must be labeled as such. Never invent numbers.

## How it is built
- Single file `index.html` (PWA, script in one IIFE). Service worker `sw.js` (bump cache name `pdg-vNN` each release). Feed `updates.json` (new/changed peptides, news). Sync server in `sync/` (Express + Postgres).
- Ship: commit and push to `main` of WSS5480/PEPTIDE-DOSE-TRACKER. Render static site `peptide-dose-guide` (srv-db02a5m7bikc73ftging) deploys itself.
- Version stamp: `VER`/`BUILT` in index.html. Bump with every release.
- Tests: Playwright with `service_workers="block"`.

## Decisions
- 2026-11-13: Steve chose one subscriber flow for every app, Oddable's: price set in My Apps (Setup tab), Cash App link + "I paid" + he confirms under Payments, phone push reminders at 5, 3, 1 and 0 days, lock on the day after the end date with no grace. Trial length (30 days) and price stay per app. Reason: he wants all apps to work the same for subscribers.
- What the subscription gates did not change: only sync across devices is paid. The calculator itself stays open.

## Open items
- Reminders need the app installed to the Home Screen on iPhone. Real push delivery could not be tested from the build sandbox (no network); the request reaches My Apps and is stored. Have Steve tap "Turn on renewal reminders" on his phone, then "Check and send now" in My Apps Setup.
- WhatsApp reminder box still exists in My Apps for Dose Guide (manual). Fine to keep; push is the automatic one.
- `dose-guide-sync` (srv-dbjqr88ae00c73f1h0e0) fails to deploy: `DATABASE_URL` not set. Steve must paste the Internal Database URL of `dose-guide-db` into its Environment. Then: verify /healthz, have Arlene create a login, set her PIN to 2757 (platform `setpin` action), and confirm sign-in stays remembered.
- Possible: fold long sections on peptide detail pages; the 9 built-in refOnly peptides still need the dosing-source pass; LC216 and LC120 may get calculators like LC526.
- Separate doctor/nurse "recommended dosing" app: not started. App-store points to raise first (in-app purchase vs Cash App, developer accounts, review risk).

## Change log
- 2026-11-13 (v2026-11-13a, sw pdg-v46): Subscription now works like the owner's other apps (Oddable is the model). Sync server: no grace days (locks the day after the end date, Central time, decided by My Apps), new routes `POST /pay` ("I paid" request), `GET /account` (fresh state), `GET /push-key`, `POST /push` (phone reminders). Price and Cash App link come from My Apps `/api/v1/pay/info` with `tenant: "dose:<id>"`. Client: Pay + "I paid" / "Check again" buttons (`data-sy`), pending message, "Turn on renewal reminders" in the sync card (`pdg:push` remembers it per login), "in development, credit card payments coming soon" line. `sw.js` has push + notificationclick handlers. Tested locally end to end (local Postgres + local My Apps + Playwright phone size): trial, last day, lock, I paid, owner confirm, unlock.
- 2026-11-12: Prices > My inventory: + Mine on each item, own cost / price / on-hand per item, margin, cart profit uses own cost, "Sold" button reduces stock. Stored in `pdg:inv` (price uses existing `pdg:custPrice`).
- 2026-11-12: Lipo-C Fat Blaster (LC526) calculator: pre-mixed 10 mL, 526 mg/mL, 1 mL = 100 units. Dose range is clinic practice, not sourced. Fixed squashed category groups on desktop.
- 2026-11-11: Menu, collapsible categories, category colors, vial icons, My vials shelf, readable sign-in with server-down message.
- 2026-11-08: Dosing section from labels/studies for 47 reference peptides; per-vial "How often"; WhatsApp removed from login (PIN only); sync `setpin` action.
- Earlier: disclaimer, price list with My price and cart, alphabetical order, live Add vial math, Quick calc, vials for other people, bulk delete, pull-to-refresh, lock dose.

## Decisions
- 2026-11-12: LC526 modeled like HHB (pre-mixed, no water). Reason: the only ingredient listing gives amounts per mL on a 10 mL vial; per-mL total (526) matches the product code.
- 2026-11-08: Sources limited to labels, human studies, guidelines. Reason: Steve's rule against vendor doses; blocked sites (PubMed, ClinicalTrials.gov) left some entries marked unverified.

## 2026-11-12d — Prices is now a pure manual inventory
- Steve's rule: NO built-in price list for anyone. Only what the user types (item, size, own cost, own price, on hand).
- Removed PRICE_BLOB (encrypted Xint list), PIN gate, CSV import. Storage: `pdg:items`, `pdg:cart`. Old keys (pdg:inv/custPrice/myLines/priceList/priceEdits/order) migrated once then deleted.
- Cart shows customer total + profit; Sold button reduces stock. sw cache pdg-v27.
- Old blob still exists in git history and in old cached copies on devices (history rewrite = destructive, needs Steve's OK).
- Dropped: publishing prices to resellers (his latest messages imply it; not confirmed).

## 2026-11-12e — inventory simplified
- Steve: only "My cost" and "My price" side by side per item. Removed On hand, stock totals and Sold button. Cart (+/-, customer total, profit) stays. sw pdg-v28.

## 2026-11-12f — search box autofill bug
- Browser autofilled the saved login name ("steve") into the peptide search box, so the list showed "Nothing matches". Fix: search input name/autocomplete off, and clear any autofilled value shortly after load. sw pdg-v29.

## 2026-11-12g — login name defaults to "Owner"
- Steve's login name: Owner (prefilled when none remembered). PIN is his own (set when he creates the login). Claude can't reach the sync server from its sandbox, so he creates the login himself in the app. sw pdg-v30.

## 2026-11-12h — Owner user list + price access checkboxes
- Login named "Owner" (name_key owner) is the owner. Prices page shows "Users & price access" for Owner: list of other logins with a checkbox per person (dose_users.can_price).
- Server (sync/server.js): GET /owner/users, POST /owner/users/:id {can_price}, PUT /owner/prices, GET /prices. Owner publishes only n/size/price (NEVER cost) to table dose_prices when items change. Checked users see read-only "Prices from Owner" fold on the Prices page.
- Risk: whoever registers the name "Owner" first is owner. Steve must create Owner BEFORE anyone else tries it.
- Tested client with mocked server (Owner / allowed user / not allowed). Server endpoints syntax-checked only; verify live after deploy. sw pdg-v31.
- Not built: users entering their own price against Owner's price (earlier reseller idea).

## 2026-11-12i — guests see Owner price as locked cost
- Users Owner has checked: Owner's price list is merged into their inventory (items flagged o:1). Owner price shows as their "My cost" (read-only, refreshed from server); they type their own "My price". No Delete button for these users. Replaced the read-only "Prices from Owner" fold. sw pdg-v32.
- Unchecked users still use their own typed inventory with Delete.

## 2026-11-12j — clean slate
- Steve: remove all previous pricing, he enters his own. Old pricing keys purged on every load; one-time wipe of pdg:items (flag pdg:fresh1) so carried-over entries are gone; added "Clear all my prices" (two taps; hidden for Owner-list guests). sw pdg-v33.

## 2026-11-12k — qty back
- Steve asked "qty?": per-item Qty box restored next to My cost and My price, and Sold (cart) reduces qty. sw pdg-v34.

## 2026-11-12l — Owner can delete users
- Users page: Delete button per login (two taps), server DELETE /owner/users/:id removes login, tokens, data (cascade); Owner row can't be deleted. CORS allows DELETE. sw pdg-v35.

## 2026-11-12m — owner-list items removed on sign-out / 401
- Steve had two logins (steve and Owner). Owner-list items (o:1) are dropped from the device inventory when signed out or when the login is rejected/deleted. sw pdg-v36.

## 2026-11-12n — restore Owner prices from server
- Steve was signed in as "steve" (guest) on his device; deleting that login dropped the copied Owner list locally. Server still holds the published prices (dose_prices). Added Owner-only "Restore prices from server" button (restores name/size/price; cost and qty were never on the server). sw pdg-v37.

## 2026-11-12o — never keep Owner-list copies unless signed in as a checked guest
- Steve saw duplicates (his own item + an o:1 copy with Owner price as cost) on his Owner device. On every load, o:1 items are removed unless the device is signed in as a checked guest. sw pdg-v38.
- Steve login deletion: must be done from Owner > Users page (DB blocks outside connections; MCP query tool can't reach it).

## 2026-11-12p — inventory is per LOGIN
- Bug: inventory lived in the browser, so a checked user (tom) signing in on Steve's browser saw Steve's cost/price/qty. Now switching login swaps lists (`pdg:items:<name>`, `pdg:itemsFor`); first sign-in on a device with an unclaimed list files it under "owner". Guests start with only Owner-price rows (cost locked) and their own price/qty. Signed-out state uses an empty list. sw pdg-v39.
- Known limit: lists are still per device, not synced across devices (only Owner's published prices sync).

## 2026-11-12q — list swap also runs at load
- v p only swapped lists on sign-in; a login already signed in (tom) kept Steve's list. invSwitch() now also runs on every load. sw pdg-v40.

## 2026-11-12r — recover saved lists
- Steve's list "vanished" after deleting tom (signed-out state uses an empty list; his list was filed under pdg:items:owner). Added "Saved lists on this device" fold on Prices: lists every pdg:items:* stash with count and a Bring back button. sw pdg-v41.

## 2026-11-12s — never lose a list (reviewer findings)
- Reviewer found invSwitch hid lists (swapped in an empty list for a new login) and the fresh1 wipe had no backup. Fixes: rolling snapshots (last 5, `pdg:items:snap-<ts>`) before any swap/wipe/clear-all; never overwrite a non-empty stash with an empty list; Owner's first sign-in keeps the list already typed on the device; banner "Your list is saved... Bring back" when the live list is empty.
- Privacy: Saved-lists/Bring back is hidden for any signed-in non-Owner (a checked user could have copied Owner's cost/qty). sw pdg-v42.
- Rule: use ONLY the Owner login on Steve's devices.

## 2026-11-12t — never publish an empty price list
- Likely cause of Owner's "Nothing new to restore": an empty inventory got published (PUT /owner/prices with []) and wiped the server copy. ownerPublish now returns early on an empty list. Prices a checked user's device still holds (pdg:ownerPrices) are the only other copy. sw pdg-v43.

## 2026-11-12u — reviewer #2 fixes
- Saved lists / Bring back only for the signed-in Owner (they hold cost/qty). Owner sign-in drops cached guest copies. Server: PUT /owner/prices refuses an empty list unless {clear:true}; price must be a number; /owner/users guards non-array vials and huge ids. sw pdg-v44.
- Known/accepted: first registrant of "Owner" would become owner (Steve's Owner already exists; can't be deleted by the endpoint). Owner PIN is 4 digits like everyone; 5 wrong tries lock 15 min.

## 2026-11-12v — Owner list backed up on the server
- Lists are per device, so Steve's phone had none. New owner-only endpoints GET/PUT /owner/inventory (table dose_inventory: full list incl. cost/qty; Owner token only; refuses empty save). Client: every change pushes the full list; Owner sign-in/opening Prices pulls it when the local list is empty; "Restore prices from server" now pulls the full list first. sw pdg-v45.
- Privacy: cost/qty are stored server-side but only readable by the Owner login. Checked users still get prices only (dose_prices).

## 2026-11-13a — Save vial gives a reason
- Delia (user) "can't save a vial": sync server logs clean (no 4xx/5xx). The Save vial button silently did nothing when vial size, water or target dose was empty/0 or a new person's name was missing. Now shows a red message saying which. sw pdg-v46. Not confirmed this was her cause; ask her what she sees / which box was empty.

## 2026-11-13b — merge note
- Rebased the "Save vial says what is missing" change on top of the parallel session's subscription commit (VER 2026-11-13b, sw pdg-v47). Two sessions are editing this repo: pull before pushing.

## 2026-11-13c — vials save to the account (database), not just the phone
- Steve: "save to db vs their phones". A NEW vial (Add vial form or "Save this vial" on a peptide page) now requires being signed in; otherwise it opens Create login with an explanation. Editing/logging existing vials unchanged. Banner on the vials page when vials exist but nobody is signed in. Sync still caches locally and queues sync 1.5 s after each change. sw pdg-v48.

## 2026-11-13d — dose reminders (8:00 am default)
- Vials page: "Dose reminders" fold (on/off, alert time, Test alert) + red "Dose due today" banner. remindCheck() runs on load, every 60 s and when the app becomes visible; once per day after the alert time, only if a vial is due (plan started, not expired, not logged today, interval passed; peptides without a fixed interval only until the first dose). Notification via service-worker registration with vibrate pattern + navigator.vibrate. Settings in localStorage `pdg:remind`. sw pdg-v49 (push handler vibrates too).
- LIMIT: fires only while the app is open or running in the background on the phone. A true 8:00 alert with the app fully closed needs a server push at 8 am: sync server is on Render FREE (sleeps), so it needs a paid always-on plan or a Render Cron Job, plus the push key. A browser holds ONE push subscription per key, so this must be designed together with the renewal-reminder push (My Apps key) from the parallel session. Not built. Asked Steve.
