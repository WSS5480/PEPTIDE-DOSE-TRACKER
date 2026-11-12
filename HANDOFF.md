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

## Open items
- `dose-guide-sync` (srv-dbjqr88ae00c73f1h0e0) fails to deploy: `DATABASE_URL` not set. Steve must paste the Internal Database URL of `dose-guide-db` into its Environment. Then: verify /healthz, have Arlene create a login, set her PIN to 2757 (platform `setpin` action), and confirm sign-in stays remembered.
- Possible: fold long sections on peptide detail pages; the 9 built-in refOnly peptides still need the dosing-source pass; LC216 and LC120 may get calculators like LC526.
- Separate doctor/nurse "recommended dosing" app: not started. App-store points to raise first (in-app purchase vs Cash App, developer accounts, review risk).

## Change log
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
