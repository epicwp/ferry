# Plan 5b acceptance runbook — change cards against the real fixture (§6 criterion)

Run by a human (Robbert), against the real `ferry-prod` DDEV fixture. Nothing here is
simulated — every command hits the real plugin REST routes, the real server API, the real
dashboard UI, and the real fixture database. This is the base doc's §6 criterion ("Tracking
database changes") exercised end-to-end with a real WooCommerce order stream running
underneath the whole session.

## Suite + typecheck results (feat/change-cards, Task 14's own verification pass)

| Suite | Command | Result |
|---|---|---|
| ferry-plugin | `cd ferry-plugin && ./vendor/bin/phpunit` | **OK — 203 tests, 566 assertions** |
| ferry-cli | `npm --workspace ferry-cli run test` | **21 files, 141 tests passed** |
| ferry-cli typecheck | — | **no `typecheck` script exists** in `ferry-cli/package.json` (only `build`, which runs `tsc -p tsconfig.json`); not added — out of scope for this task |
| ferry-server | `npm --workspace ferry-server run test` | **19 files, 180 tests passed** |
| ferry-server typecheck | `npm --workspace ferry-server run typecheck` | clean, exit 0 |
| ferry-dashboard typecheck | `npm --workspace ferry-dashboard run typecheck` | clean, exit 0 |
| ferry-dashboard e2e (full, incl. 3b gate) | `npm --workspace ferry-dashboard run e2e` | **18 passed** (`changes.spec.ts` 9 + `dashboard.spec.ts` 9), 31.1s |

Notes on noise (none of it is a failure):
- `sync.test.ts` prints `SSE listener error: Error: Listener error` / `Subscriber callback
  failed` / `afterReady hook failed` lines to stderr — intentional throwing-subscriber and
  throwing-hook tests (assert the manager doesn't crash when a listener/hook throws).
- `push-manager.test.ts` prints `push recovered as pushed (change N) — smoke status unknown
  after the restart, verify manually.` — intentional boot-recovery logging under test.
- The e2e run prints `[WebServer] agent runner error (site 12, session 2): API Error: 401
  (scripted)` during test 18 (the 3b gate test) — that's the scripted magic-prompt exercising
  issue #9's visible-error path (Task 2/13 coverage), not a real failure.

**Preflight quirk hit and resolved during this run:** `ddev list` showed a stray
`ferry-prod-ddev-site` project pointing at a `/private/var/folders/...` temp path (left over
from an earlier Playwright run), separate from the real `ferry-prod` project at
`~/ferry-e2e/prod`. If `ddev wp` commands (or the dashboard e2e's `dashboard.spec.ts`, which
shells out to `ddev wp eval` in `~/ferry-e2e/prod`) start failing with a DDEV error about a
project root that doesn't exist, or `ddev list` shows a `ferry-prod-ddev-site` row whose
location isn't `~/ferry-e2e/prod`, unlist it first:
```
ddev stop --unlist ferry-prod-ddev-site
```
This does not touch `~/ferry-e2e/prod` itself — it only removes the stale registration and
its (already-orphaned) containers. Confirm `ferry-prod` (not `ferry-prod-ddev-site`) is
`running` at `~/ferry-e2e/prod` afterwards.

**Fixture state at the time of this write-up** (`~/ferry-e2e/prod`, checked read-only, not
modified by this task): WooCommerce 10.9.4 already installed and active (`ddev wp plugin
list`), `woocommerce_custom_orders_table_enabled = yes` → **HPOS is the active order
schema** — the proof-query SQL below targets `wp_wc_orders`; the legacy `wp_posts` variant is
included alongside for completeness / in case a fresh fixture ever defaults differently.
Guest checkout is already `yes`; tax calc is currently `no` (Step 1 turns it on); no products
exist yet; active theme is `twentytwentyfive`; `functions.php` has no planted bug yet.

---

## Preconditions

- Fixture running at `~/ferry-e2e/prod` (DDEV project `ferry-prod`, site
  `https://ferry-prod.ddev.site`).
- `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` in the **same shell** that
  starts `ferry-server` — it only takes effect at Node process start (Plan 5a Task 4
  finding); starting the dev server in a different shell, or exporting it after the process
  is already up, leaves every `verifyClone` call failing on a TLS trust error no retry fixes.
  The same cert is needed for `curl` against `https://ferry-prod.ddev.site` (mkcert's CA
  isn't in curl's default trust store) — pass `--cacert "$(mkcert -CAROOT)/rootCA.pem"` on
  every such call below.
- `export ANTHROPIC_API_KEY=<real key>` (or a git-ignored `.env` at the repo root) in that
  same shell — needed for the real agent session in Step 5 onward.
- `export FERRY_AGENT_MAX_BUDGET_USD=2` in that same shell, to cap the session's spend.
- Ports free before starting: `lsof -ti:4000` and `lsof -ti:5173` should both be empty. Kill
  anything stale first (`kill <pid>`) — an old `ferry-server`/`vite` left running from a prior
  session silently serves stale code against the new fixture state.
- `ddev list` shows `ferry-prod` running at `~/ferry-e2e/prod` and no stray
  `ferry-prod-ddev-site` (see the preflight quirk note above).

## Optional pre-step: live-fire confirmation of the visible-error path (closes issue #9b)

Not required for the §6 acceptance signal itself — this closes a separate loop from Task 2's
review: the normalize unit tests cover both the SDK's structured `error` field and the
`'API Error'` text-literal fallback, and the e2e gate test exercises the path via the
*scripted* runner's `trigger-runner-error` magic prompt, but a **real** 401 through the
**real** Claude Agent SDK hasn't been observed live since the fix. Five minutes, run once,
before the main session:

1. In a scratch shell, start `ferry-server` with a deliberately invalid key (not the shell
   from Preconditions — keep the real key isolated from this throwaway check):
   ```
   export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
   export ANTHROPIC_API_KEY=sk-ant-invalid-live-fire-check
   export FERRY_AGENT_MAX_BUDGET_USD=1
   npm --workspace ferry-server run dev
   ```
2. Start the dashboard (`npm --workspace ferry-dashboard run dev`), sign up, add
   `https://ferry-prod.ddev.site`, pair, sync to ready — same flow as Step 4 below.
3. Open the site's Agent chat, send any message (e.g. "hello").
   - **PASS**: the SDK call fails with a real `401`/`authentication_failed`; the chat renders
     a **red** status block (`chat__status--error`), not ordinary agent prose. This is
     `normalize.ts`'s structured-error branch (or the text fallback) firing on a genuine SDK
     response instead of the scripted stand-in.
4. Stop this server. Do not reuse this account/site pairing for the real session below — sign
   up fresh in Step 4 (or delete this throwaway account/site row from `~/.ferry/server.db` if
   you'd rather reuse the site slug).

---

## Step 1: fixture prep — WooCommerce, products, tax, guest checkout

`cd ~/ferry-e2e/prod` for all commands in this step.

1. **Install WooCommerce from the official zip** (idempotent — it's already active on this
   fixture at v10.9.4, confirmed above; run it anyway so the runbook is self-contained for a
   fixture that doesn't have it yet). This uses WP-CLI's own plugin downloader, which pulls
   the plugin's real zip from the wordpress.org plugin API — **not** the `wp core download`
   path that corrupts long filenames (ustar-100 truncation, documented in the v0 e2e
   runbook). The official-zip rule is specifically about WordPress **core**; installing a
   plugin this way is the same official-zip discipline, never `wp core download`:
   ```
   ddev wp plugin install woocommerce --activate
   ddev wp plugin list --name=woocommerce
   ```
2. **Seed 3 products**, prices deliberately spanning the €100 threshold the planted bug keys
   off of (one under, one near, one over — gives the agent something to actually diagnose):
   ```
   ddev wp eval '
   $prices = ["25.00" => "Ferry E2E Product 1", "60.00" => "Ferry E2E Product 2", "150.00" => "Ferry E2E Product 3"];
   foreach ($prices as $price => $name) {
       $p = new WC_Product_Simple();
       $p->set_name($name);
       $p->set_regular_price($price);
       $p->set_status("publish");
       $p->set_catalog_visibility("visible");
       $p->set_manage_stock(false);
       $p->set_stock_status("instock");
       $id = $p->save();
       echo "product_id=$id price=$price\n";
   }
   '
   ```
   Record the three `product_id` values printed — Step 3 needs them.
3. **Flat 21% tax rate, taxes on, guest checkout on** (guest checkout is already `yes` on
   this fixture; the command is harmless to re-run):
   ```
   ddev wp option update woocommerce_calc_taxes yes
   ddev wp option update woocommerce_prices_include_tax no
   ddev wp option update woocommerce_enable_guest_checkout yes
   ddev wp eval '
   WC_Tax::_insert_tax_rate([
       "tax_rate_country"  => "",
       "tax_rate_state"    => "",
       "tax_rate"          => "21.0000",
       "tax_rate_name"     => "VAT",
       "tax_rate_priority" => "1",
       "tax_rate_compound" => "0",
       "tax_rate_shipping" => "1",
       "tax_rate_order"    => "1",
       "tax_rate_class"    => "",
   ]);
   echo "tax rate inserted\n";
   '
   ddev wp db query "SELECT tax_rate_id, tax_rate_country, tax_rate, tax_rate_name FROM wp_woocommerce_tax_rates"
   ```
   Fallback if `WC_Tax::_insert_tax_rate` errors on the installed version: WooCommerce →
   Settings → Tax → Standard rates in wp-admin, add one row (Country blank = all, Rate
   `21.0000`, Name `VAT`) by hand.
4. **Generate a WooCommerce REST API key pair**, used by the order-loop script in Step 3 (no
   wp-admin click-through needed — this inserts the row the wp-admin "Add key" screen would
   produce):
   ```
   ddev wp eval '
   $ck = "ck_" . wc_rand_hash();
   $cs = "cs_" . wc_rand_hash();
   global $wpdb;
   $wpdb->insert($wpdb->prefix . "woocommerce_api_keys", [
       "user_id"         => 1,
       "description"     => "ferry-e2e order loop",
       "permissions"     => "read_write",
       "consumer_key"    => wc_api_hash($ck),
       "consumer_secret" => $cs,
       "truncated_key"   => substr($ck, -7),
   ], ["%d","%s","%s","%s","%s","%s"]);
   echo "CK=$ck\nCS=$cs\n";
   '
   ```
   Record `CK`/`CS` — Step 3 needs them.

## Step 2: plant the bug — double-VAT hook + gating option

Still in `~/ferry-e2e/prod`. The bug is two pieces, matching the base doc's card example
("an incorrect setting plus a bug in the theme"): a `wp_options` flag, and a
`woocommerce_calc_tax` filter in the active theme (`twentytwentyfive`) that doubles VAT above
€100 whenever the flag is on. Fixing it later means the agent has to touch **both**.

```
THEME_DIR=wp-content/themes/twentytwentyfive
cat >> "$THEME_DIR/functions.php" <<'PHP'

// === FERRY DEMO BUG (§6 acceptance runbook) — remove once the fix is verified ===
add_option('ferry_demo_vat_surcharge_enabled', '1');
add_filter('woocommerce_calc_tax', function ($taxes, $price, $rate) {
    if (get_option('ferry_demo_vat_surcharge_enabled') === '1' && (float) $price > 100) {
        foreach ($taxes as $key => $amount) {
            $taxes[$key] = $amount * 2; // silently doubles VAT on orders above €100
        }
    }
    return $taxes;
}, 10, 3);
// === END FERRY DEMO BUG ===
PHP
php -l "$THEME_DIR/functions.php"
ddev wp option get ferry_demo_vat_surcharge_enabled
```
(`php -l` is a syntax-only lint — it doesn't execute the file, which matters here since
`functions.php` isn't meant to run standalone outside a theme bootstrap. A syntax error means
fix the heredoc before continuing; the real proof the hook registered is the next visit to
any page, which loads the theme normally and runs `add_option`/`add_filter` for real.)

**PASS**: `ferry_demo_vat_surcharge_enabled` reads `1`; placing a >€100 order (see Step 3)
shows roughly double the expected 21% VAT line.

## Step 3: order loop — checkout orders every ~20s, logged, for the whole session

Real HTTP against the fixture's own URL, via the WooCommerce REST API v3 (Basic Auth over
TLS — WooCommerce's supported non-OAuth auth mode). Line items only, no explicit `total` —
WooCommerce computes totals server-side via `WC_Abstract_Order::calculate_totals()` →
`calculate_taxes()` → `WC_Tax::calc_tax()`, the same pipeline a real checkout uses, so the
planted filter above fires exactly as it would for a genuine customer order.

```bash
mkdir -p ~/ferry-e2e
cat > ~/ferry-e2e/order-loop.sh <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
CACERT="$(mkcert -CAROOT)/rootCA.pem"
BASE="https://ferry-prod.ddev.site"
CK="ck_REPLACE_ME"          # from Step 1.4
CS="cs_REPLACE_ME"          # from Step 1.4
PRODUCT_IDS=(0 0 0)         # from Step 1.2's product_id= output
LOG="$HOME/ferry-e2e/order-loop.log"

while true; do
  PID=${PRODUCT_IDS[$((RANDOM % ${#PRODUCT_IDS[@]}))]}
  RESP=$(curl -s --cacert "$CACERT" -u "$CK:$CS" -X POST "$BASE/wp-json/wc/v3/orders" \
    -H 'Content-Type: application/json' \
    -d "{\"status\":\"processing\",\"billing\":{\"first_name\":\"Ferry\",\"last_name\":\"E2E\",\"address_1\":\"Teststraat 1\",\"city\":\"Amsterdam\",\"postcode\":\"1000AA\",\"country\":\"NL\",\"email\":\"ferry-e2e@example.com\"},\"line_items\":[{\"product_id\":$PID,\"quantity\":1}]}")
  ID=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id","ERROR"))')
  TOTAL=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("total","ERROR"))')
  echo "$(date -Iseconds) order_id=$ID total=$TOTAL" | tee -a "$LOG"
  sleep 20
done
SCRIPT
chmod +x ~/ferry-e2e/order-loop.sh
```

**Before launching**, edit `~/ferry-e2e/order-loop.sh` and replace the three placeholders
with the real values from Steps 1.2 (`PRODUCT_IDS`) and 1.4 (`CK`/`CS`). Then launch it:
```
~/ferry-e2e/order-loop.sh &
ORDER_LOOP_PID=$!
echo "order loop running as PID $ORDER_LOOP_PID, logging to ~/ferry-e2e/order-loop.log"
```

Leave this running in its own terminal (or backgrounded as above) for the **entire** rest of
this runbook. Stop it only in Step 10 (`kill $ORDER_LOOP_PID`), right before the final tally.

## Step 4: dev servers, pairing, sync

1. Confirm ports are free (`lsof -ti:4000`, `lsof -ti:5173` — both empty; see Preconditions).
2. In the shell with `NODE_EXTRA_CA_CERTS`, `ANTHROPIC_API_KEY`, and
   `FERRY_AGENT_MAX_BUDGET_USD=2` all exported (Preconditions):
   ```
   npm --workspace ferry-server run dev
   ```
3. In another shell:
   ```
   npm --workspace ferry-dashboard run dev
   ```
4. At `http://localhost:5173`: sign up, add `https://ferry-prod.ddev.site`, pair using a
   fresh code:
   ```
   cd ~/ferry-e2e/prod && ddev wp eval 'print(json_encode(\Ferry\Auth::issue_pairing_code()));'
   ```
5. Run the sync to Ready (dashboard does this automatically after pairing, or trigger it from
   the site page). **PASS**: site status reaches `ready`.

## Step 5: agent session — investigate, fix, `db_journal` → `create_change`

Open the site's Agent chat.

1. Ask: *"Customers are reporting the VAT on some orders looks wrong — can you investigate?
   The shop has a flat 21% rate."* Let it explore (check `wp option get
   woocommerce_calc_taxes`, look at recent orders' tax totals, grep the active theme for tax
   hooks). It should find the `functions.php` filter and the gating option.
2. Once it proposes a fix, confirm: *"Yes, fix both — remove the surcharge and reset the
   flag."* The agent edits `functions.php` on `agent/work` (removing or neutralizing the
   `FERRY DEMO BUG` block) and sets `ferry_demo_vat_surcharge_enabled` back to `0` (e.g. `wp
   option update ferry_demo_vat_surcharge_enabled 0` inside the clone).
3. Ask it to finalize: *"Looks good — check `db_journal` and create the change card."* The
   agent calls `mcp__ferry__db_journal` (curates to just the one option op — there should be
   nothing else since the last sync), then `mcp__ferry__create_change` with a plain-language
   title/summary, `ops: [{kind:'option_set', name:'ferry_demo_vat_surcharge_enabled',
   old:'1', new:'0'}]`, a precondition `{type:'option',
   name:'ferry_demo_vat_surcharge_enabled', expected:'1'}`, and a smoke check (e.g.
   `{label:'homepage', path:'/', expectStatus:200}`).
   - **PASS**: an inline `change_card` block appears in the chat (screen 6b, Task 13); the
     agent states it cannot push itself.
4. Open the card (Changes tab, screen 7, or the inline card's link) — screen 8. **PASS**: the
   diff shows the `functions.php` file change and the one `option_set` op with old/new
   values; drift preview reports production unchanged.

## Step 6: the one click — push, watch 8 → 9 → 10 live

Click **Push to production** on the card.

- **PASS**: the card transitions to screen 9 (pushing), showing the step timeline
  (`staging`/`hashes`/`drift`/`swap`/`journal`/`smoke`, each start→ok) live over SSE, then
  lands on screen 10 (pushed) with the smoke check result and a visible rollback button.

## Step 7: proof queries (run against the fixture DB)

All commands `cd ~/ferry-e2e/prod` first.

1. **Every order placed during the session is intact — count + totals match the order-loop
   log, before and after the push window.** Primary check, schema-agnostic (works regardless
   of HPOS/legacy — this fixture is confirmed HPOS, `woocommerce_custom_orders_table_enabled
   = yes`):
   ```
   ddev wp eval '
   $orders = wc_get_orders(["limit" => -1, "status" => "any", "return" => "ids"]);
   sort($orders);
   $sum = 0;
   foreach ($orders as $id) {
       $o = wc_get_order($id);
       printf("%d,%s\n", $id, $o->get_total());
       $sum += (float) $o->get_total();
   }
   printf("count=%d sum=%.2f\n", count($orders), $sum);
   '
   ```
   Compare `count`/`sum` against `~/ferry-e2e/order-loop.log`'s order count and sum of
   logged totals — **must match exactly**. Cross-check with raw SQL on the active schema:
   ```
   # HPOS (this fixture):
   ddev wp db query "SELECT COUNT(*), SUM(total_amount) FROM wp_wc_orders WHERE type='shop_order'"
   # legacy (only if a future fixture reinstall reads woocommerce_custom_orders_table_enabled = no):
   ddev wp db query "SELECT COUNT(*), SUM(pm.meta_value) FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id = p.ID AND pm.meta_key = '_order_total' WHERE p.post_type = 'shop_order'"
   ```
2. **The fix is live** — option value and hook both gone:
   ```
   ddev wp option get ferry_demo_vat_surcharge_enabled   # expect: 0
   grep -c "FERRY DEMO BUG" wp-content/themes/twentytwentyfive/functions.php   # expect: 0
   ```
   Place one more order for a >€100 product through the order loop (or manually via the same
   curl call from Step 3) and confirm its tax line is the plain 21%, not doubled.
3. **`wp_options` shows no unexpected writes outside the journal's keys.** Snapshot before
   the push (do this right before Step 6's click) and after, excluding known-noisy WordPress/
   WooCommerce housekeeping keys (transients, cron, Action Scheduler) that churn regardless
   of the push:
   ```
   ddev wp db query "SELECT option_name, MD5(option_value) FROM wp_options WHERE option_name NOT LIKE '\_transient\_%' AND option_name NOT LIKE '\_site\_transient\_%' AND option_name NOT LIKE 'action_scheduler%' AND option_name != 'cron' ORDER BY option_name" > /tmp/options-before.txt
   # ... after the push ...
   ddev wp db query "SELECT option_name, MD5(option_value) FROM wp_options WHERE option_name NOT LIKE '\_transient\_%' AND option_name NOT LIKE '\_site\_transient\_%' AND option_name NOT LIKE 'action_scheduler%' AND option_name != 'cron' ORDER BY option_name" > /tmp/options-after.txt
   diff /tmp/options-before.txt /tmp/options-after.txt
   ```
   **PASS**: the only changed row is `ferry_demo_vat_surcharge_enabled`.
4. **Backup dir exists:**
   ```
   ls wp-content/uploads/.ferry-backup/
   ```
   **PASS**: exactly one directory present, named after the push's full `backupTxid` (the
   card's UI only shows a shortened 7-char `prodRef`, so just read the directory name off
   `ls` rather than trying to match it against the UI), containing `index.php`, `.htaccess`,
   and `files/wp-content/themes/twentytwentyfive/functions.php` (the pre-fix version, renamed
   there during the swap).

## Step 8: honest conflict — manual drift, real conflict, one force, one rollback

Uses a **second, unrelated** change so it doesn't disturb the VAT-fix change's state for
Step 9's rollback proof. Same tagline field the Plan 5a runbook used for its own conflict
demo — easy to edit by hand in wp-admin.

1. In the chat: *"Let's also update the site tagline while we're here."* Agent edits, curates
   `db_journal`, calls `create_change` → a new change (`option_set`, `blogdescription`,
   `old:'<V0>'`, `new:'<V1>'`). **Do not push yet.**
2. **Manually drift the same option in wp-admin** (not wp-cli, per the brief — Settings →
   General → Tagline field, save), to something else entirely: `"manually edited on prod,
   mid-flow"`.
3. Push the change (no force) from the dashboard. **PASS**: screen 11 renders — the real
   conflict table (`key | expected | found`), `expected` = `<V0>`, `found` = the manually
   typed string.
4. **Verify nothing applied:**
   ```
   ddev wp option get blogdescription
   ```
   **PASS**: still the manually-typed drift string, not `<V0>` and not `<V1>`.
5. **Force path, once:** click Force on screen 11, confirm the dialog.
   ```
   ddev wp option get blogdescription
   ```
   **PASS**: now `<V1>` — force overwrote the drift unconditionally, without reading what the
   drifted value was.
6. **Roll it back:** click the rollback button on the now-pushed card.
   ```
   ddev wp option get blogdescription
   ```
   **PASS**: back to `<V0>`.

## Step 9: rollback proof — the original VAT-fix change

Roll back the change pushed in Step 6 (still sitting at screen 10 / `status: pushed`).

1. Click **Roll back** on that card.
2. **Prod files restored:**
   ```
   grep -c "FERRY DEMO BUG" wp-content/themes/twentytwentyfive/functions.php   # expect: 1 (bug is back)
   ```
3. **Option restored:**
   ```
   ddev wp option get ferry_demo_vat_surcharge_enabled   # expect: 1
   ```
4. **Orders still intact** — re-run Step 7.1's `wc_get_orders` tally; count/sum unchanged
   from the last check (the order loop should have kept adding rows in the background the
   whole time — total will have grown by however many new orders landed since, but every
   order present at the last check must still be present with the same total).

## Step 10: wrap up

1. Stop the order loop: `kill $ORDER_LOOP_PID` (or Ctrl+C in its terminal). Final tally:
   ```
   wc -l ~/ferry-e2e/order-loop.log
   ```
2. Both dev servers are still up at this point — this is also the window to do the **screens
   3–5 manual design pass** queued alongside this task (sites list, pairing, sync screens;
   design review only, not part of this runbook's PASS/FAIL criteria).

---

## Human gates (not satisfied by this runbook)

- **This runbook is run by a human**, against the real fixture, not automated. A clean run
  through Steps 1–9 (all PASS bullets true) is the acceptance signal for the base doc's §6
  criterion for Plan 5b; it is not a substitute for the security skim gate
  (`docs/2026-07-26-ferry-plugin-security-skim.md`) already required before Plan 5a's branch
  merged, and doesn't re-run it.
- The optional live-fire pre-step (issue #9b) is exactly that — optional. Its PASS/FAIL
  doesn't gate §6 acceptance; it's a separate confirmation that the real SDK's error path
  renders the same as the scripted/unit-tested one.
