# Ferry Fidelity Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The clone behaves like production without production's bloat: lite DB pulls (revisions/transients/sessions/AS history excluded by default, `--full` opt-out), license stubs (EDD/Freemius/WooCommerce.com clients stay "valid" inside the harness), and uploads that materialize from production on first request plus a `ferry fetch-uploads` bulk command.

**Spec:** `docs/superpowers/specs/2026-07-25-ferry-fidelity-slice-design.md` — read it first.

**Architecture:** Exclusion policy is hardcoded in the plugin as named rules; the CLI selects rules by name (never SQL over the wire) and verifies via an `X-Ferry-Skip` echo header. License stubs and the uploads-fallback script ship as static PHP assets in ferry-cli, copied into the clone by the overlay; the overlay's `pre_http_request` interceptor consults the stub registry before blocking. `fetch-uploads` reuses the existing manifest/transfer machinery via a new `scope=uploads` manifest parameter.

**Tech Stack:** Plugin: native PHP (no deps), PHPUnit 9 (`ferry-plugin/vendor/bin/phpunit`). CLI: Node/TypeScript ESM, vitest (`npx vitest run`), commander, undici.

## Global Constraints

- Plugin code must run on old PHP (7.0-era): classic closures, no arrow functions, no named args. Plugin stays read-only, zero external dependencies, namespace `/ferry/v1/`.
- `wp-config.php` never crosses the bridge; exclusion policy lives hardcoded in the plugin, CLI selects by **name** — never SQL over the wire.
- The clone never holds the pairing secret (the agent works there). The in-clone fallback script uses plain public GETs only.
- Timeouts are answers: every endpoint that iterates a collection stays resumable (`Budget`, `X-Next-Index`/`X-Last-Key`).
- Surgical changes only; match existing style. Existing tests must keep passing unmodified unless a task explicitly says otherwise.
- Work on branch `feat/fidelity-slice` off `main`.
- Run tests from the package dir: `cd ferry-plugin && vendor/bin/phpunit`, `cd ferry-cli && npx vitest run`.

---

### Task 1: Plugin — named DB exclusion rules (`DbExcludes` + `Db::export` filter + `/db` skip contract)

**Files:**
- Create: `ferry-plugin/src/DbExcludes.php`
- Modify: `ferry-plugin/src/Db.php` (append `$filter` param to `export()`; `$where` to `fetch_chunk()`)
- Modify: `ferry-plugin/src/Routes.php:207-223` (`db_export`)
- Test: `ferry-plugin/tests/DbExcludesTest.php`

**Interfaces:**
- Consumes: `Db::export()`, `Budget`, `FakeWpdb` (existing).
- Produces: `DbExcludes::NAMES` (`['revisions','transients','sessions','as_logs','as_completed']`), `DbExcludes::parse($raw): array`, `DbExcludes::unknown(array $skip): array`, `DbExcludes::plan(string $table, string $prefix, array $skip): array{schema_only: bool, where: string[]}`. Wire contract for Task 2: `/db?skip=<comma-names>` → 400 `ferry_unknown_skip` on unknown name; response header `X-Ferry-Skip` echoes the recognized names.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/fidelity-slice main
```

- [ ] **Step 2: Write the failing tests**

Create `ferry-plugin/tests/DbExcludesTest.php`:

```php
<?php
use Ferry\Budget;
use Ferry\Db;
use Ferry\DbExcludes;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/helpers/FakeWpdb.php';

final class DbExcludesTest extends TestCase
{
    public function test_parse_and_unknown(): void
    {
        $this->assertSame(['revisions', 'transients'], DbExcludes::parse(' revisions, transients ,'));
        $this->assertSame([], DbExcludes::parse(null));
        $this->assertSame([], DbExcludes::parse(''));
        $this->assertSame(['bogus'], DbExcludes::unknown(['revisions', 'bogus']));
        $this->assertSame([], DbExcludes::unknown(DbExcludes::NAMES));
    }

    public function test_plan_matches_rules_to_prefixed_tables(): void
    {
        $all = DbExcludes::NAMES;
        $this->assertTrue(DbExcludes::plan('wp_woocommerce_sessions', 'wp_', $all)['schema_only']);
        $this->assertTrue(DbExcludes::plan('wp_actionscheduler_logs', 'wp_', $all)['schema_only']);
        $this->assertSame(["post_type <> 'revision'"], DbExcludes::plan('wp_posts', 'wp_', $all)['where']);
        $this->assertSame([], DbExcludes::plan('wp_posts', 'xyz_', $all)['where'], 'prefix must match');
        $this->assertSame(['schema_only' => false, 'where' => []], DbExcludes::plan('wp_posts', 'wp_', []));
        $this->assertNotEmpty(DbExcludes::plan('wp_options', 'wp_', ['transients'])['where']);
        $this->assertNotEmpty(DbExcludes::plan('wp_actionscheduler_actions', 'wp_', ['as_completed'])['where']);
        $this->assertFalse(DbExcludes::plan('wp_posts', 'wp_', $all)['schema_only']);
    }

    public function test_transients_filter_escapes_like_wildcards(): void
    {
        $where = DbExcludes::plan('wp_options', 'wp_', ['transients'])['where'][0];
        $this->assertStringContainsString("NOT LIKE '\\_transient\\_%'", $where);
        $this->assertStringContainsString("NOT LIKE '\\_site\\_transient\\_%'", $where);
    }

    public function test_row_filter_lands_in_keyset_chunk_query(): void
    {
        $wpdb = new FakeWpdb([
            [['Field' => 'ID', 'Type' => 'bigint(20)'], ['Field' => 'post_type', 'Type' => 'varchar(20)']], // SHOW COLUMNS
            ['wp_posts', "CREATE TABLE `wp_posts` (\n  `ID` bigint(20)\n)"],                                  // SHOW CREATE TABLE
            [['ID' => '1', 'post_type' => 'post']],                                                          // short chunk -> complete
        ]);
        $filter = DbExcludes::plan('wp_posts', 'wp_', ['revisions']);
        $r = Db::export($wpdb, 'wp_posts', 'ID', 0, 9, new Budget(10.0), 2, Db::BYTE_BUDGET, $filter);
        $this->assertTrue($r['complete']);
        $this->assertStringContainsString(
            "WHERE `ID` > 0 AND `ID` <= 9 AND (post_type <> 'revision') ORDER BY",
            $wpdb->queries[2]
        );
    }

    public function test_schema_only_emits_create_and_completes_immediately(): void
    {
        $wpdb = new FakeWpdb([
            ['wp_woocommerce_sessions', "CREATE TABLE `wp_woocommerce_sessions` (\n  `session_id` bigint(20)\n)"],
        ]);
        $filter = DbExcludes::plan('wp_woocommerce_sessions', 'wp_', ['sessions']);
        $r = Db::export($wpdb, 'wp_woocommerce_sessions', 'session_id', 0, 5, new Budget(10.0), 50, Db::BYTE_BUDGET, $filter);
        $this->assertStringContainsString('DROP TABLE IF EXISTS `wp_woocommerce_sessions`;', $r['sql']);
        $this->assertStringContainsString('CREATE TABLE `wp_woocommerce_sessions`', $r['sql']);
        $this->assertStringNotContainsString('INSERT INTO', $r['sql']);
        $this->assertTrue($r['complete']);
        $this->assertSame(0, $r['last_key']);
    }

    public function test_schema_only_resume_emits_nothing(): void
    {
        $wpdb = new FakeWpdb([]);
        $r = Db::export($wpdb, 'wp_woocommerce_sessions', 'session_id', 7, null, new Budget(10.0), 50, Db::BYTE_BUDGET, ['schema_only' => true, 'where' => []]);
        $this->assertSame('', $r['sql']);
        $this->assertTrue($r['complete']);
        $this->assertSame(7, $r['last_key']);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter DbExcludesTest`
Expected: FAIL — class `Ferry\DbExcludes` not found.

- [ ] **Step 4: Implement `DbExcludes` and the `Db` changes**

Create `ferry-plugin/src/DbExcludes.php`:

```php
<?php
namespace Ferry;

/**
 * Lite-pull exclusion rules (§3.1 posture applied to rows): policy is hardcoded
 * here and selected by NAME from the CLI - never SQL over the wire. Row rules
 * become an AND-clause inside the keyset chunk query; schema-only tables export
 * DROP+CREATE with zero rows so plugins that expect them don't fatal. Every
 * targeted table has an integer PK, so the OFFSET fallback is never involved.
 */
final class DbExcludes
{
    const NAMES = ['revisions', 'transients', 'sessions', 'as_logs', 'as_completed'];

    /** @param mixed $raw @return string[] */
    public static function parse($raw): array
    {
        return array_values(array_filter(array_map('trim', explode(',', (string) $raw))));
    }

    /** @return string[] names not in NAMES (fail loud beats a silently-bloated clone) */
    public static function unknown(array $skip): array
    {
        return array_values(array_diff($skip, self::NAMES));
    }

    /** @return array{schema_only: bool, where: string[]} filter for one table */
    public static function plan(string $table, string $prefix, array $skip): array
    {
        $filter = ['schema_only' => false, 'where' => []];
        foreach ($skip as $name) {
            if ($name === 'sessions' && $table === $prefix . 'woocommerce_sessions') {
                $filter['schema_only'] = true;
            }
            if ($name === 'as_logs' && $table === $prefix . 'actionscheduler_logs') {
                $filter['schema_only'] = true;
            }
            if ($name === 'revisions' && $table === $prefix . 'posts') {
                $filter['where'][] = "post_type <> 'revision'";
            }
            if ($name === 'transients' && $table === $prefix . 'options') {
                // \_ = literal underscore in LIKE (default escape char is backslash)
                $filter['where'][] = "option_name NOT LIKE '\\_transient\\_%' AND option_name NOT LIKE '\\_site\\_transient\\_%'";
            }
            if ($name === 'as_completed' && $table === $prefix . 'actionscheduler_actions') {
                $filter['where'][] = "status NOT IN ('complete','failed','canceled')";
            }
        }
        return $filter;
    }
}
```

Modify `ferry-plugin/src/Db.php`. `export()` gains a trailing `$filter` param (trailing so existing callers/tests stay untouched) and a schema-only short-circuit **before** the `SHOW COLUMNS` call:

```php
    /**
     * @param array{schema_only?: bool, where?: string[]} $filter
     * @return array{sql: string, last_key: int, complete: bool}
     */
    public static function export($wpdb, string $table, $pk, int $after, $before, Budget $budget, int $chunk_rows = self::CHUNK_ROWS, int $byte_budget = self::BYTE_BUDGET, array $filter = []): array
    {
        $where = isset($filter['where']) ? $filter['where'] : [];
        if (!empty($filter['schema_only'])) {
            $out = '';
            if ($after === 0) {
                $create = $wpdb->get_row("SHOW CREATE TABLE `$table`", ARRAY_N);
                $out = "DROP TABLE IF EXISTS `$table`;\n" . $create[1] . ";\n";
            }
            return ['sql' => $out, 'last_key' => $after, 'complete' => true];
        }
        // ... existing body unchanged, except fetch_chunk gains $where:
        //   $rows = self::fetch_chunk($wpdb, $table, $pk, $last, $before, $chunk_rows, $where);
```

`fetch_chunk()` gains `array $where = []` as last param:

```php
    private static function fetch_chunk($wpdb, string $table, $pk, int $after, $before, int $chunk_rows, array $where = []): array
    {
        $extra = '';
        foreach ($where as $clause) {
            $extra .= " AND ($clause)";
        }
        if ($pk !== null) {
            $sql = "SELECT * FROM `$table` WHERE `$pk` > %d" . ($before !== null ? " AND `$pk` <= %d" : '') . $extra . " ORDER BY `$pk` LIMIT %d";
            $args = $before !== null ? [$after, $before, $chunk_rows] : [$after, $chunk_rows];
            return $wpdb->get_results($wpdb->prepare($sql, ...$args), ARRAY_A);
        }
        // No usable pk: OFFSET fallback (§3.5). Named rules never target PK-less
        // tables, but apply the filter here too so the contract holds regardless.
        $w = $where === [] ? '' : ' WHERE (' . implode(') AND (', $where) . ')';
        return $wpdb->get_results($wpdb->prepare("SELECT * FROM `$table`$w LIMIT %d OFFSET %d", $chunk_rows, $after), ARRAY_A);
    }
```

Keep the existing comment block about OFFSET consistency; only the lines shown change.

- [ ] **Step 5: Run tests**

Run: `cd ferry-plugin && vendor/bin/phpunit`
Expected: DbExcludesTest PASS **and** the whole existing suite still green (trailing-param design means no existing test changes).

- [ ] **Step 6: Wire the `/db` contract in Routes**

In `ferry-plugin/src/Routes.php`, replace `db_export` body (keep the unknown-table check first):

```php
    public static function db_export(\WP_REST_Request $request)
    {
        global $wpdb;
        $table = (string) $request->get_param('table');
        if (!in_array($table, $wpdb->get_col('SHOW TABLES'), true)) {
            return new \WP_Error('ferry_unknown_table', 'Unknown table.', ['status' => 404]);
        }
        $skip = DbExcludes::parse($request->get_param('skip'));
        $unknown = DbExcludes::unknown($skip);
        if ($unknown !== []) {
            return new \WP_Error('ferry_unknown_skip', 'Unknown skip rule(s): ' . implode(', ', $unknown) . '. The CLI is newer than this plugin - update the Ferry Connect plugin on the site.', ['status' => 400]);
        }
        $after = max(0, (int) $request->get_param('after'));
        $before = $request->get_param('before') !== null ? (int) $request->get_param('before') : null;
        $filter = DbExcludes::plan($table, $wpdb->prefix, $skip);
        $result = Db::export($wpdb, $table, Db::single_pk($wpdb, $table), $after, $before, new Budget(), Db::CHUNK_ROWS, Db::BYTE_BUDGET, $filter);
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/gzip');
        header('X-Complete: ' . ($result['complete'] ? '1' : '0'));
        header('X-Last-Key: ' . $result['last_key']);
        header('X-Ferry-Skip: ' . implode(',', $skip));
        echo gzencode($result['sql'], 6);
        exit;
    }
```

The pure parts (`parse`/`unknown`/`plan`) are unit-tested above; the `header()`/`exit` wiring is covered by the CLI mock tests (Task 2) and E2E (Task 9) — same posture as the existing routes.

- [ ] **Step 7: Full plugin suite green, then commit**

Run: `cd ferry-plugin && vendor/bin/phpunit`
Expected: PASS.

```bash
git add ferry-plugin/src/DbExcludes.php ferry-plugin/src/Db.php ferry-plugin/src/Routes.php ferry-plugin/tests/DbExcludesTest.php
git commit -m "plugin: named DB exclusion rules with /db skip contract"
```

---

### Task 2: CLI — lite default, `--full` flag, `X-Ferry-Skip` verification

**Files:**
- Modify: `ferry-cli/src/db.ts`
- Modify: `ferry-cli/src/pull.ts` (opts param, `liteSkip` in result)
- Modify: `ferry-cli/src/main.ts` (flag + output)
- Modify: `ferry-cli/tests/helpers/mockPlugin.ts` (record `/db` queries, echo `X-Ferry-Skip`, `skipSupported` opt)
- Test: `ferry-cli/tests/db.test.ts`

**Interfaces:**
- Consumes: Task 1's wire contract (`skip=` param, `X-Ferry-Skip` echo).
- Produces: `LITE_SKIP: string[]` (exported from `db.ts`, value `['revisions','transients','sessions','as_logs','as_completed']`); `pullDatabase(client, dumpDir, skip: string[] = [])`; `pull(slug, deps?, opts?: { full?: boolean })`; `PullResult.liteSkip: string[]` (empty on full pulls).

- [ ] **Step 1: Extend the mock plugin**

In `ferry-cli/tests/helpers/mockPlugin.ts`:
- Add `skipSupported?: boolean` to the opts interface.
- Change `requests` to `{ files: [] as string[][], db: [] as Record<string, string>[] }` (and widen the `MockPlugin.requests` type accordingly).
- In the `/db` handler, right after finding the table, add:

```ts
      requests.db.push(Object.fromEntries(url.searchParams.entries()));
      const skip = url.searchParams.get('skip');
      if (skip !== null && opts.skipSupported !== false) {
        res.setHeader('X-Ferry-Skip', skip);
      }
```

- [ ] **Step 2: Write the failing tests**

Append to the `describe` block in `ferry-cli/tests/db.test.ts` (reuse the existing `wp_posts` single-batch fixture shape; import `LITE_SKIP` from `../src/db.js`):

```ts
  const oneTable = [{
    name: 'wp_posts', rows: 1, bytes: 100, pk: 'ID', maxpk: 1,
    batches: [{ sql: 'INSERT INTO `wp_posts` VALUES (1);\n', lastKey: 1, complete: true }],
  }];

  it('sends the skip list and accepts the echoed X-Ferry-Skip header', async () => {
    mock = await startMockPlugin(fixture, { dbTables: oneTable });
    const client = new FerryClient(mock.base, 'irrelevant');
    await pullDatabase(client, dumpDir, LITE_SKIP);
    expect(mock.requests.db[0].skip).toBe('revisions,transients,sessions,as_logs,as_completed');
  });

  it('aborts when the plugin does not echo X-Ferry-Skip (old plugin)', async () => {
    mock = await startMockPlugin(fixture, { dbTables: oneTable, skipSupported: false });
    const client = new FerryClient(mock.base, 'irrelevant');
    await expect(pullDatabase(client, dumpDir, LITE_SKIP))
      .rejects.toThrow(/does not support lite pulls/);
  });

  it('omits the skip param entirely on a full pull', async () => {
    mock = await startMockPlugin(fixture, { dbTables: oneTable });
    const client = new FerryClient(mock.base, 'irrelevant');
    await pullDatabase(client, dumpDir);
    expect(mock.requests.db[0].skip).toBeUndefined();
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ferry-cli && npx vitest run tests/db.test.ts`
Expected: FAIL — `LITE_SKIP` not exported / skip never sent.

- [ ] **Step 4: Implement**

In `ferry-cli/src/db.ts`:

```ts
/** Lite-pull rule names; must stay in sync with the plugin's DbExcludes::NAMES. */
export const LITE_SKIP = ['revisions', 'transients', 'sessions', 'as_logs', 'as_completed'];

export async function pullDatabase(client: FerryClient, dumpDir: string, skip: string[] = []): Promise<string> {
```

Inside the per-table loop, build the query with the skip param and verify the echo on every response:

```ts
      const query: Record<string, string> = { table: table.name, after: String(after) };
      if (skip.length > 0) {
        query.skip = skip.join(',');
      }
      if (table.maxpk !== null) {
        query.before = String(table.maxpk); // §3.5: snapshot bound fixed at export start
      }
      const { buffer, headers } = await client.getBuffer('/ferry/v1/db', query);
      if (skip.length > 0 && headers['x-ferry-skip'] !== skip.join(',')) {
        throw new Error(
          'the Ferry Connect plugin on the site does not support lite pulls - update the plugin on the site, or re-run with --full',
        );
      }
```

In `ferry-cli/src/pull.ts`:

```ts
import { LITE_SKIP, pullDatabase } from './db.js';

export interface PullOpts { full?: boolean }
```

- `PullResult` gains `liteSkip: string[];`
- Signature: `export async function pull(slug: string, deps: PullDeps = {}, opts: PullOpts = {}): Promise<PullResult> {`
- The db line becomes:

```ts
  const liteSkip = opts.full ? [] : LITE_SKIP;
  const dump = await pullDatabase(client, join(ferryHome(), 'sites', slug, 'db-dump'), liteSkip);
```

- Add `liteSkip,` to the returned object.

In `ferry-cli/src/main.ts`, on the `pull` command:

```ts
  .option('--full', 'pull the complete database (skip the lite exclusions)')
  .action(async (site: string, opts: { full?: boolean }) => {
    const result = await pull(site, {}, { full: opts.full });
```

and after the admin line:

```ts
    console.log(
      result.liteSkip.length > 0
        ? `  Lite DB pull: skipped ${result.liteSkip.join(', ')} (use --full for everything)`
        : '  Full DB pull: no exclusions',
    );
```

- [ ] **Step 5: Run the full CLI suite**

Run: `cd ferry-cli && npx vitest run`
Expected: PASS (pull.test.ts keeps passing — the new opts/field are additive).

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/db.ts ferry-cli/src/pull.ts ferry-cli/src/main.ts ferry-cli/tests/db.test.ts ferry-cli/tests/helpers/mockPlugin.ts
git commit -m "cli: lite DB pull by default with --full opt-out and X-Ferry-Skip verification"
```

---

### Task 3: License stubs asset (`ferry-stubs.php`) + `assetPath()`

**Files:**
- Create: `ferry-cli/assets/ferry-stubs.php`
- Modify: `ferry-cli/src/overlay.ts` (add `assetPath` helper only — wiring is Task 4)
- Test: `ferry-plugin/tests/StubsTest.php`

**Interfaces:**
- Consumes: nothing new.
- Produces: PHP functions `ferry_stub_response($url, $args): ?array` (WP_Http-shaped response array or null), `ferry_stub_request_params($url, $args): array`; TS `assetPath(name: string): string` (absolute path to a ferry-cli asset, works from both `src/` and `dist/`).

The stubs file is plain PHP with pure functions, so it is tested from the plugin's PHPUnit suite via a relative `require` — accepted monorepo pragmatism (spec §8).

- [ ] **Step 1: Write the failing tests**

Create `ferry-plugin/tests/StubsTest.php`:

```php
<?php
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../../ferry-cli/assets/ferry-stubs.php';

final class StubsTest extends TestCase
{
    public function test_edd_check_license_in_body_returns_valid(): void
    {
        $r = ferry_stub_response('https://some-edd-store.example/', ['body' => ['edd_action' => 'check_license', 'license' => 'k', 'item_name' => 'Thing']]);
        $this->assertSame(200, $r['response']['code']);
        $data = json_decode($r['body'], true);
        $this->assertTrue($data['success']);
        $this->assertSame('valid', $data['license']);
        $this->assertSame('Thing', $data['item_name']);
    }

    public function test_edd_action_in_query_string_matches(): void
    {
        $r = ferry_stub_response('https://store.example/?edd_action=activate_license&license=k', []);
        $this->assertNotNull($r);
        $this->assertSame('valid', json_decode($r['body'], true)['license']);
    }

    public function test_edd_string_body_is_parsed(): void
    {
        $r = ferry_stub_response('https://store.example/', ['body' => 'edd_action=check_license&license=k']);
        $this->assertNotNull($r);
    }

    public function test_edd_get_version_never_offers_an_update(): void
    {
        $r = ferry_stub_response('https://store.example/', ['body' => ['edd_action' => 'get_version', 'slug' => 'demo']]);
        $data = json_decode($r['body'], true);
        $this->assertSame('0.0.0', $data['new_version']);
        $this->assertSame('', $data['package']);
        $this->assertSame('demo', $data['slug']);
    }

    public function test_edd_deactivate_reports_deactivated(): void
    {
        $r = ferry_stub_response('https://store.example/', ['body' => ['edd_action' => 'deactivate_license']]);
        $this->assertSame('deactivated', json_decode($r['body'], true)['license']);
    }

    public function test_freemius_api_host_is_stubbed(): void
    {
        $ping = ferry_stub_response('https://api.freemius.com/v1/ping.json', []);
        $this->assertSame(200, $ping['response']['code']);
        $this->assertSame('pong', json_decode($ping['body'], true)['api']);
        $other = ferry_stub_response('https://api.freemius.com/v1/installs/1.json', []);
        $this->assertSame('{}', $other['body']);
    }

    public function test_woocommerce_helper_host_is_stubbed(): void
    {
        $subs = ferry_stub_response('https://api.woocommerce.com/wp-json/helper/1.0/subscriptions', []);
        $this->assertSame('[]', $subs['body']);
        $other = ferry_stub_response('https://woocommerce.com/wp-json/helper/1.0/update-check', []);
        $this->assertSame('{}', $other['body']);
    }

    public function test_unrelated_hosts_are_not_stubbed(): void
    {
        $this->assertNull(ferry_stub_response('https://api.stripe.com/v1/charges', ['body' => ['amount' => 1]]));
        $this->assertNull(ferry_stub_response('https://example.com/', []));
        $this->assertNull(ferry_stub_response('https://notfreemius.com/x', []), 'suffix match must require the dot');
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter StubsTest`
Expected: FAIL — require of missing file.

- [ ] **Step 3: Create the asset**

Create `ferry-cli/assets/ferry-stubs.php`:

```php
<?php
/**
 * Ferry license stubs - static asset, copied into wp-content/mu-plugins/ by the
 * CLI overlay. The harness interceptor (ferry-overlay.php) consults
 * ferry_stub_response() before blocking an outbound call. The DB snapshot already
 * carries production's license state; these stubs exist so revalidation pings
 * cannot flip it - responses are generic "still valid" shapes.
 * Runs on the clone's PHP, which mirrors production: classic syntax only.
 */

/** Merge URL query params and the request body (array or form-encoded string). */
function ferry_stub_request_params($url, $args)
{
    $params = [];
    $query = (string) parse_url($url, PHP_URL_QUERY);
    if ($query !== '') {
        parse_str($query, $params);
    }
    if (isset($args['body'])) {
        if (is_array($args['body'])) {
            $params = array_merge($params, $args['body']);
        } elseif (is_string($args['body'])) {
            parse_str($args['body'], $body_params);
            $params = array_merge($params, $body_params);
        }
    }
    return $params;
}

/** @return array WP_Http-shaped 200 response */
function ferry_stub_http_200($body)
{
    return [
        'headers'  => ['content-type' => 'application/json'],
        'body'     => is_string($body) ? $body : json_encode($body),
        'response' => ['code' => 200, 'message' => 'OK'],
        'cookies'  => [],
        'filename' => null,
    ];
}

function ferry_stub_edd($params)
{
    $action = $params['edd_action'];
    if ($action === 'get_version') {
        return ferry_stub_http_200([
            'new_version'    => '0.0.0', // never offer a phantom update in the clone
            'stable_version' => '0.0.0',
            'name'           => isset($params['item_name']) ? $params['item_name'] : '',
            'slug'           => isset($params['slug']) ? $params['slug'] : '',
            'url'            => '',
            'homepage'       => '',
            'package'        => '',
            'download_link'  => '',
            'sections'       => json_encode([]),
            'banners'        => json_encode([]),
            'last_updated'   => '',
            'requires'       => '',
            'tested'         => '',
        ]);
    }
    if ($action === 'deactivate_license') {
        return ferry_stub_http_200(['success' => true, 'license' => 'deactivated']);
    }
    // check_license / activate_license
    return ferry_stub_http_200([
        'success'          => true,
        'license'          => 'valid',
        'item_id'          => isset($params['item_id']) ? $params['item_id'] : 0,
        'item_name'        => isset($params['item_name']) ? $params['item_name'] : '',
        'expires'          => 'lifetime',
        'payment_id'       => 0,
        'customer_name'    => 'ferry',
        'customer_email'   => 'ferry@localhost',
        'license_limit'    => 0,
        'site_count'       => 1,
        'activations_left' => 'unlimited',
        'price_id'         => false,
    ]);
}

function ferry_stub_freemius($url)
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (strpos($path, '/ping') !== false) {
        return ferry_stub_http_200(['api' => 'pong', 'timestamp' => gmdate('Y-m-d H:i:s')]);
    }
    return ferry_stub_http_200(new stdClass()); // "{}": success-shaped, no 'error' key
}

function ferry_stub_woocommerce($url)
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (substr($path, -14) === '/subscriptions') {
        return ferry_stub_http_200('[]');
    }
    return ferry_stub_http_200(new stdClass());
}

/**
 * @param string $url outbound request URL
 * @param array  $args wp_remote_* args
 * @return array|null WP_Http-shaped response, or null to let the harness block
 */
function ferry_stub_response($url, $args)
{
    $params = ferry_stub_request_params($url, $args);
    if (isset($params['edd_action']) && in_array($params['edd_action'], ['check_license', 'activate_license', 'deactivate_license', 'get_version'], true)) {
        return ferry_stub_edd($params); // EDD is detected by request shape: every EDD store hosts its own API
    }
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    if ($host === 'api.freemius.com' || substr($host, -13) === '.freemius.com') {
        return ferry_stub_freemius($url);
    }
    if ($host === 'api.woocommerce.com' || $host === 'woocommerce.com') {
        return ferry_stub_woocommerce($url);
    }
    return null;
}
```

Add to `ferry-cli/src/overlay.ts` (top, after imports):

```ts
import { fileURLToPath } from 'node:url';

/** Absolute path to a bundled PHP asset; resolves from src/ and dist/ alike. */
export function assetPath(name: string): string {
  return fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
}
```

- [ ] **Step 4: Run tests + PHP lint**

Run: `cd ferry-plugin && vendor/bin/phpunit` and `php -l ferry-cli/assets/ferry-stubs.php`
Expected: PASS / "No syntax errors".

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/assets/ferry-stubs.php ferry-cli/src/overlay.ts ferry-plugin/tests/StubsTest.php
git commit -m "cli: license stub asset for EDD/Freemius/WooCommerce.com"
```

---

### Task 4: Overlay wiring — interceptor consults stubs, asset copied, excludes/gitignore prefixes

**Files:**
- Modify: `ferry-cli/src/overlay.ts` (`generateMuPlugin`, `applyOverlay`)
- Modify: `ferry-plugin/src/Excludes.php`
- Modify: `ferry-cli/src/git.ts` (`GITIGNORE`)
- Test: `ferry-cli/tests/overlay.test.ts`, `ferry-plugin/tests/ExcludesTest.php`

**Interfaces:**
- Consumes: `assetPath('ferry-stubs.php')` (Task 3).
- Produces: clone layout `wp-content/mu-plugins/ferry-stubs.php` next to `ferry-overlay.php`; both covered by the transfer-exclusion prefix `wp-content/mu-plugins/ferry-` and the gitignore line `/wp-content/mu-plugins/ferry-*`.

- [ ] **Step 1: Write the failing tests**

In `ferry-cli/tests/overlay.test.ts` (reuse the file's existing `SiteInfo` fixture and temp-dir setup):

```ts
  it('mu-plugin consults the stub registry before blocking', () => {
    const mu = generateMuPlugin();
    expect(mu).toContain("function_exists('ferry_stub_response')");
    expect(mu).toContain('[ferry-harness] stubbed: ');
    expect(mu.indexOf('ferry_stub_response')).toBeLessThan(mu.indexOf('ferry_blocked'));
  });

  it('applyOverlay copies the stubs asset into mu-plugins', async () => {
    await applyOverlay(docroot, info, 'https://clone.ddev.site');
    const copied = readFileSync(join(docroot, 'wp-content', 'mu-plugins', 'ferry-stubs.php'), 'utf8');
    expect(copied).toContain('function ferry_stub_response');
  });
```

In `ferry-plugin/tests/ExcludesTest.php` add:

```php
    public function test_ferry_mu_plugins_prefix_is_excluded(): void
    {
        $this->assertTrue(Excludes::excluded('wp-content/mu-plugins/ferry-overlay.php'));
        $this->assertTrue(Excludes::excluded('wp-content/mu-plugins/ferry-stubs.php'));
        $this->assertFalse(Excludes::excluded('wp-content/mu-plugins/loader.php'));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ferry-cli && npx vitest run tests/overlay.test.ts` and `cd ferry-plugin && vendor/bin/phpunit --filter ExcludesTest`
Expected: FAIL (mu-plugin lacks consult; stubs file not copied; `ferry-stubs.php` not excluded).

- [ ] **Step 3: Implement**

`generateMuPlugin()` in `overlay.ts` — the `pre_http_request` closure becomes:

```php
add_filter('pre_http_request', function ($pre, $args, $url) {
    if (function_exists('ferry_stub_response')) {
        $stub = ferry_stub_response($url, $args);
        if ($stub !== null) {
            error_log('[ferry-harness] stubbed: ' . $url);
            return $stub;
        }
    }
    error_log('[ferry-harness] blocked outbound HTTP: ' . $url);
    return new WP_Error('ferry_blocked', 'ferry harness: outbound HTTP is blocked in the clone (' . $url . ')');
}, 1, 3);
```

`applyOverlay()` — after the existing mu-plugin write:

```ts
  await fsp.copyFile(assetPath('ferry-stubs.php'), join(docroot, 'wp-content', 'mu-plugins', 'ferry-stubs.php'));
```

`ferry-plugin/src/Excludes.php` — in `FILES`, remove the line
`'wp-content/mu-plugins/ferry-overlay.php',` and in `PREFIXES` add:

```php
        'wp-content/mu-plugins/ferry-',   // ferry's own overlay + stubs - production must never clobber the clone's copies
```

`ferry-cli/src/git.ts` — in `GITIGNORE`, replace `/wp-content/mu-plugins/ferry-overlay.php` with:

```
/wp-content/mu-plugins/ferry-*
```

- [ ] **Step 4: Run both suites**

Run: `cd ferry-cli && npx vitest run` and `cd ferry-plugin && vendor/bin/phpunit`
Expected: PASS. If a git.test.ts assertion pins the old gitignore line, update that assertion to the new pattern — that is the only permitted existing-test change.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/overlay.ts ferry-cli/src/git.ts ferry-plugin/src/Excludes.php ferry-cli/tests/overlay.test.ts ferry-plugin/tests/ExcludesTest.php
git commit -m "overlay: harness consults license stubs; ferry mu-plugins excluded by prefix"
```

---

### Task 5: Uploads materializing fallback — script asset, nginx/apache routing, wording

**Files:**
- Create: `ferry-cli/assets/ferry-uploads-fallback.php`
- Modify: `ferry-cli/src/overlay.ts` (`generateNginxFallback`, `generateHtaccessFallback`, `applyOverlay`)
- Modify: `ferry-cli/src/git.ts` (`GITIGNORE`, `CLAUDE_MD`)
- Modify: `ferry-cli/src/main.ts` (pull output line)
- Test: `ferry-plugin/tests/FallbackScriptTest.php`, `ferry-cli/tests/overlay.test.ts`

**Interfaces:**
- Consumes: `assetPath()` (Task 3), `phpScalar()` (existing in overlay.ts).
- Produces: clone file `<docroot>/ferry-uploads-fallback.php` with the production origin baked in (token `__FERRY_PROD_ORIGIN__` substituted); both webserver configs route missing uploads to `/ferry-uploads-fallback.php?path=<rel>`; PHP functions `ferry_fallback_valid_path($rel): bool`, `ferry_fallback_content_type($rel): string`, `ferry_fallback_remote_url($origin, $rel): string`. `generateNginxFallback()` and `generateHtaccessFallback()` lose their `prodOrigin` parameter (origin lives in the script now).

- [ ] **Step 1: Write the failing PHP tests**

Create `ferry-plugin/tests/FallbackScriptTest.php`:

```php
<?php
use PHPUnit\Framework\TestCase;

if (!defined('FERRY_FALLBACK_TEST')) {
    define('FERRY_FALLBACK_TEST', true);
}
require_once __DIR__ . '/../../ferry-cli/assets/ferry-uploads-fallback.php';

final class FallbackScriptTest extends TestCase
{
    public function test_path_validation(): void
    {
        $this->assertTrue(ferry_fallback_valid_path('2026/07/photo.jpg'));
        $this->assertTrue(ferry_fallback_valid_path('fonts/custom.woff2'));
        $this->assertFalse(ferry_fallback_valid_path(''));
        $this->assertFalse(ferry_fallback_valid_path('/etc/passwd'));
        $this->assertFalse(ferry_fallback_valid_path('a/../b.jpg'));
        $this->assertFalse(ferry_fallback_valid_path('..'));
        $this->assertFalse(ferry_fallback_valid_path('a//b.jpg'));
        $this->assertFalse(ferry_fallback_valid_path('a\\b.jpg'));
        $this->assertFalse(ferry_fallback_valid_path("a.jpg\0x"));
        $this->assertFalse(ferry_fallback_valid_path('.htaccess'));
        $this->assertFalse(ferry_fallback_valid_path('2026/.hidden/x.jpg'));
        $this->assertFalse(ferry_fallback_valid_path('shell.php'));
        $this->assertFalse(ferry_fallback_valid_path('shell.PHP'));
        $this->assertFalse(ferry_fallback_valid_path('shell.php5'));
        $this->assertFalse(ferry_fallback_valid_path('x.phtml'));
        $this->assertFalse(ferry_fallback_valid_path('x.phar'));
        $this->assertFalse(ferry_fallback_valid_path('dir/'));
    }

    public function test_content_types(): void
    {
        $this->assertSame('image/jpeg', ferry_fallback_content_type('a/b.jpg'));
        $this->assertSame('image/jpeg', ferry_fallback_content_type('a/b.JPEG'));
        $this->assertSame('font/woff2', ferry_fallback_content_type('f.woff2'));
        $this->assertSame('image/svg+xml', ferry_fallback_content_type('i.svg'));
        $this->assertSame('application/pdf', ferry_fallback_content_type('d.pdf'));
        $this->assertSame('application/octet-stream', ferry_fallback_content_type('x.unknownext'));
    }

    public function test_remote_url_encodes_segments_but_keeps_slashes(): void
    {
        $this->assertSame(
            'https://prod.example/wp-content/uploads/2026/07/my%20file.jpg',
            ferry_fallback_remote_url('https://prod.example', '2026/07/my file.jpg')
        );
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter FallbackScriptTest`
Expected: FAIL — missing file.

- [ ] **Step 3: Create the asset**

Create `ferry-cli/assets/ferry-uploads-fallback.php`:

```php
<?php
/**
 * Ferry uploads fallback (§2.8 v0.2) - materialize-on-first-request.
 * Copied into the clone docroot by the CLI (origin token substituted); routed to
 * by nginx/apache when a file under wp-content/uploads/ is missing. Standalone by
 * design: WordPress never loads, so the harness (which governs WP's outbound
 * HTTP) does not apply - this fetch targets the customer's own public uploads.
 * The clone holds no pairing secret; this is a plain public GET.
 * Serving from the clone's own origin is what makes fonts work (no CORS).
 */

define('FERRY_UPLOADS_CAP_BYTES', 50 * 1024 * 1024); // bigger files 302 to production instead of buffering

/** Path must stay under uploads/: no traversal, no dot-segments, never PHP. */
function ferry_fallback_valid_path($rel)
{
    if (!is_string($rel) || $rel === '' || strpos($rel, "\0") !== false || strpos($rel, '\\') !== false) {
        return false;
    }
    if (preg_match('/\.(php\d*|phtml|phar)$/i', $rel)) {
        return false;
    }
    foreach (explode('/', $rel) as $seg) {
        if ($seg === '' || $seg[0] === '.') {
            return false;
        }
    }
    return true;
}

function ferry_fallback_content_type($rel)
{
    $map = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
        'gif' => 'image/gif', 'webp' => 'image/webp', 'avif' => 'image/avif',
        'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
        'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
        'otf' => 'font/otf', 'eot' => 'application/vnd.ms-fontobject',
        'css' => 'text/css', 'js' => 'application/javascript', 'json' => 'application/json',
        'pdf' => 'application/pdf', 'zip' => 'application/zip', 'txt' => 'text/plain',
        'mp3' => 'audio/mpeg', 'mp4' => 'video/mp4', 'webm' => 'video/webm',
    ];
    $ext = strtolower((string) pathinfo($rel, PATHINFO_EXTENSION));
    return isset($map[$ext]) ? $map[$ext] : 'application/octet-stream';
}

function ferry_fallback_remote_url($origin, $rel)
{
    return $origin . '/wp-content/uploads/' . implode('/', array_map('rawurlencode', explode('/', $rel)));
}

if (defined('FERRY_FALLBACK_TEST')) {
    return; // loaded for unit tests: definitions only
}

$origin = '__FERRY_PROD_ORIGIN__'; // substituted by the CLI at copy time
$rel = isset($_GET['path']) ? (string) $_GET['path'] : ''; // PHP has already urldecoded
if (!ferry_fallback_valid_path($rel)) {
    http_response_code(404);
    exit;
}
$dest = __DIR__ . '/wp-content/uploads/' . $rel;
$remote = ferry_fallback_remote_url($origin, $rel);
if (!is_file($dest)) {
    if (!is_dir(dirname($dest))) {
        mkdir(dirname($dest), 0775, true);
    }
    $tmp = $dest . '.ferry-tmp-' . getmypid();
    $out = fopen($tmp, 'wb');
    $too_big = false;
    $bytes = 0;
    $ch = curl_init($remote);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 120,
        CURLOPT_WRITEFUNCTION  => function ($ch, $data) use ($out, &$too_big, &$bytes) {
            $bytes += strlen($data);
            if ($bytes > FERRY_UPLOADS_CAP_BYTES) {
                $too_big = true;
                return 0; // aborts the transfer
            }
            return fwrite($out, $data);
        },
    ]);
    curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    fclose($out);
    if ($too_big || $code !== 200) {
        @unlink($tmp);
        header('Location: ' . $remote, true, 302); // today's behavior is the floor
        exit;
    }
    rename($tmp, $dest);
}
header('Content-Type: ' . ferry_fallback_content_type($rel));
header('Content-Length: ' . (string) filesize($dest));
readfile($dest);
```

- [ ] **Step 4: PHP tests pass + lint**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter FallbackScriptTest` and `php -l ferry-cli/assets/ferry-uploads-fallback.php`
Expected: PASS / no syntax errors.

- [ ] **Step 5: Write the failing overlay tests**

In `ferry-cli/tests/overlay.test.ts`:

```ts
  it('nginx fallback routes missing uploads to the materializing script', () => {
    const conf = generateNginxFallback();
    expect(conf).toContain('try_files $uri @ferry_fallback');
    expect(conf).toContain('/ferry-uploads-fallback.php?path=$1');
    expect(conf).not.toContain('302');
  });

  it('htaccess fallback rewrites to the materializing script', () => {
    const block = generateHtaccessFallback();
    expect(block).toContain('/ferry-uploads-fallback.php?path=$1');
    expect(block).not.toContain('R=302');
  });

  it('applyOverlay bakes the production origin into the fallback script', async () => {
    await applyOverlay(docroot, info, 'https://clone.ddev.site');
    const script = readFileSync(join(docroot, 'ferry-uploads-fallback.php'), 'utf8');
    expect(script).toContain("'https://wasgeurtje.nl'"); // origin of the fixture's siteurl
    expect(script).not.toContain('__FERRY_PROD_ORIGIN__');
  });
```

Run: `cd ferry-cli && npx vitest run tests/overlay.test.ts` — expected FAIL.

- [ ] **Step 6: Implement the overlay/git/main changes**

`overlay.ts`:

```ts
/**
 * §2.8 v0.2: missing uploads route to the materializing fallback script.
 * `^~` keeps DDEV's static-media regex location from 404ing uploads first.
 */
export function generateNginxFallback(): string {
  return `location ^~ /wp-content/uploads/ {
    try_files $uri @ferry_fallback;
}
location @ferry_fallback {
    rewrite ^/wp-content/uploads/(.*)$ /ferry-uploads-fallback.php?path=$1 last;
}
`;
}

export function generateHtaccessFallback(): string {
  return `# BEGIN ferry-uploads-fallback
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^wp-content/uploads/(.*)$ /ferry-uploads-fallback.php?path=$1 [QSA,L]
</IfModule>
# END ferry-uploads-fallback
`;
}
```

In `applyOverlay()`: the nginx write drops its origin argument, and the script is copied with the token substituted:

```ts
  await fsp.writeFile(join(docroot, '.ddev', 'nginx', 'ferry-uploads.conf'), generateNginxFallback());
  const fallback = await fsp.readFile(assetPath('ferry-uploads-fallback.php'), 'utf8');
  await fsp.writeFile(
    join(docroot, 'ferry-uploads-fallback.php'),
    fallback.replace("'__FERRY_PROD_ORIGIN__'", phpScalar(new URL(info.siteurl).origin) as string),
  );
```

In `finalizeClone()`: `generateHtaccessFallback(new URL(info.siteurl).origin) + existing` becomes `generateHtaccessFallback() + existing`.

`git.ts` `GITIGNORE`: add the line `/ferry-uploads-fallback.php`.

`git.ts` `CLAUDE_MD`: replace the airtight bullet with:

```
- **The clone is airtight.** Outbound email and HTTP are blocked (license checks for EDD,
  Freemius, and WooCommerce.com are answered locally with valid stubs). Missing uploads
  are fetched from production on first request and saved locally; \`ferry fetch-uploads\`
  bulk-fetches. This is expected, not a bug.
```

and extend the never-edit bullet's list with `ferry-uploads-fallback.php`.

`main.ts` pull output: replace the media line with:

```ts
    console.log('  Media is not cloned upfront - missing uploads materialize from production on first request (ferry fetch-uploads for bulk).');
```

- [ ] **Step 7: Full suites green, commit**

Run: `cd ferry-cli && npx vitest run` and `cd ferry-plugin && vendor/bin/phpunit`
Expected: PASS (update any overlay/git test that pinned the old 302 conf or CLAUDE.md wording — those assertions changed meaning with this task).

```bash
git add ferry-cli/assets/ferry-uploads-fallback.php ferry-cli/src/overlay.ts ferry-cli/src/git.ts ferry-cli/src/main.ts ferry-cli/tests/overlay.test.ts ferry-plugin/tests/FallbackScriptTest.php
git commit -m "cli: materializing uploads fallback replaces bare 302"
```

---

### Task 6: Plugin — manifest `scope=uploads` + `/files` uploads acceptance

**Files:**
- Modify: `ferry-plugin/src/Excludes.php` (add `allowed_upload`)
- Modify: `ferry-plugin/src/Manifest.php` (scope/prefix params)
- Modify: `ferry-plugin/src/Routes.php` (`manifest`, `files`, `send_range`)
- Test: `ferry-plugin/tests/ExcludesTest.php`, `ferry-plugin/tests/ManifestTest.php`

**Interfaces:**
- Consumes: existing `Manifest::batch`, `Excludes`, `Budget`.
- Produces: `Excludes::allowed_upload(string $relpath): bool`; `Manifest::batch(string $root, int $after, Budget $budget, int $cap = 5000, string $scope = '', string $prefix = ''): array`; wire contract for Task 8: `GET /manifest?scope=uploads&prefix=2026/07/` (400 `ferry_bad_scope` / `ferry_bad_prefix` on invalid input), `/files` serves explicitly-requested uploads paths.

- [ ] **Step 1: Write the failing tests**

`ExcludesTest.php` additions:

```php
    public function test_allowed_upload(): void
    {
        $this->assertTrue(Excludes::allowed_upload('wp-content/uploads/2026/07/a.jpg'));
        $this->assertTrue(Excludes::allowed_upload('wp-content/uploads/2026/'));
        $this->assertFalse(Excludes::allowed_upload('wp-content/uploads/error_log'), 'logs stay blocked even under uploads');
        $this->assertFalse(Excludes::allowed_upload('wp-content/cache/x.jpg'));
        $this->assertFalse(Excludes::allowed_upload('wp-config.php'));
    }
```

`ManifestTest.php` additions (follow the file's existing `setUp`/`tearDown` temp-root pattern; the fixture root already contains `wp-content/uploads/2026`):

```php
    public function test_uploads_scope_lists_only_uploads(): void
    {
        file_put_contents($this->root . '/wp-content/uploads/2026/a.jpg', 'img');
        file_put_contents($this->root . '/wp-content/uploads/error_log', 'log');
        $r = Manifest::batch($this->root, 0, new Budget(10.0), 5000, 'uploads', '');
        $this->assertSame(['wp-content/uploads/2026/a.jpg'], array_column($r['files'], 'path'));
        $this->assertTrue($r['complete']);
    }

    public function test_uploads_scope_respects_prefix(): void
    {
        file_put_contents($this->root . '/wp-content/uploads/2026/a.jpg', 'img');
        mkdir($this->root . '/wp-content/uploads/2027');
        file_put_contents($this->root . '/wp-content/uploads/2027/b.jpg', 'img');
        $r = Manifest::batch($this->root, 0, new Budget(10.0), 5000, 'uploads', '2026/');
        $this->assertSame(['wp-content/uploads/2026/a.jpg'], array_column($r['files'], 'path'));
    }

    public function test_uploads_scope_missing_prefix_dir_is_empty_and_complete(): void
    {
        $r = Manifest::batch($this->root, 0, new Budget(10.0), 5000, 'uploads', 'nope/');
        $this->assertSame([], $r['files']);
        $this->assertTrue($r['complete']);
    }

    public function test_default_scope_still_excludes_uploads(): void
    {
        file_put_contents($this->root . '/wp-content/uploads/2026/a.jpg', 'img');
        $r = Manifest::batch($this->root, 0, new Budget(10.0));
        $this->assertNotContains('wp-content/uploads/2026/a.jpg', array_column($r['files'], 'path'));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter 'ExcludesTest|ManifestTest'`
Expected: FAIL — `allowed_upload` undefined; `batch()` rejects extra args.

- [ ] **Step 3: Implement**

`Excludes.php`:

```php
    /**
     * §2.8 escape hatch: an explicitly requested uploads path may be served
     * (fetch-uploads / materialization) - logs stay blocked even there.
     */
    public static function allowed_upload(string $relpath): bool
    {
        $relpath = ltrim(str_replace('\\', '/', $relpath), '/');
        if (in_array(basename($relpath), self::BASENAMES, true)) {
            return false;
        }
        return strpos($relpath, 'wp-content/uploads/') === 0;
    }
```

`Manifest.php` — `batch()` gains `string $scope = '', string $prefix = ''`; before the loop:

```php
        $base = '';
        $allow_uploads = false;
        if ($scope === 'uploads') {
            $allow_uploads = true;
            $base = 'wp-content/uploads';
            if ($prefix !== '') {
                $base .= '/' . trim($prefix, '/');
            }
            if (!is_dir($root . '/' . $base)) {
                return ['files' => [], 'next' => $after, 'complete' => true];
            }
        }
        foreach (self::walk($root, $base, $allow_uploads) as $entry) {
```

`walk()` gains `bool $allow_uploads = false` (thread it through the recursive call) and its two exclusion checks become:

```php
            if (is_dir($abspath)) {
                if (!Excludes::excluded($relpath . '/') || ($allow_uploads && Excludes::allowed_upload($relpath . '/'))) {
                    yield from self::walk($root, $relpath, $allow_uploads);
                }
            } elseif (is_file($abspath) && (!Excludes::excluded($relpath) || ($allow_uploads && Excludes::allowed_upload($relpath)))) {
```

`Routes.php` — `manifest()` validates and forwards:

```php
    public static function manifest(\WP_REST_Request $request)
    {
        $scope = (string) $request->get_param('scope');
        if ($scope !== '' && $scope !== 'uploads') {
            return new \WP_Error('ferry_bad_scope', 'Unknown manifest scope.', ['status' => 400]);
        }
        $prefix = (string) $request->get_param('prefix');
        if ($prefix !== '' && preg_match('#(^/)|(\\\\)|(\.\.)|(\x00)#', $prefix)) {
            return new \WP_Error('ferry_bad_prefix', 'Invalid manifest prefix.', ['status' => 400]);
        }
        $after = max(0, (int) $request->get_param('after'));
        $result = Manifest::batch(untrailingslashit(ABSPATH), $after, new Budget(), 5000, $scope, $prefix);
        $response = new \WP_REST_Response(['files' => $result['files']]);
        $response->header('X-Complete', $result['complete'] ? '1' : '0');
        $response->header('X-Next-Index', (string) $result['next']);
        return $response;
    }
```

`files()` and `send_range()`: both `Excludes::excluded($resolved_rel)` skip-conditions become

```php
            if ((Excludes::excluded($resolved_rel) && !Excludes::allowed_upload($resolved_rel)) || !is_file($abs)) {
```

- [ ] **Step 4: Run the plugin suite**

Run: `cd ferry-plugin && vendor/bin/phpunit`
Expected: PASS, including all pre-existing manifest/excludes tests (default scope byte-identical).

- [ ] **Step 5: Commit**

```bash
git add ferry-plugin/src/Excludes.php ferry-plugin/src/Manifest.php ferry-plugin/src/Routes.php ferry-plugin/tests/ExcludesTest.php ferry-plugin/tests/ManifestTest.php
git commit -m "plugin: uploads manifest scope and explicit uploads serving"
```

---

### Task 7: CLI — transfer containment guard

**Files:**
- Modify: `ferry-cli/src/transfer.ts` (`fetchOversized`)
- Test: `ferry-cli/tests/transfer.test.ts`

**Interfaces:**
- Consumes: existing `fetchAll`/`extractBatch`.
- Produces: `fetchAll` rejects with `/refusing range write outside the clone/` for traversal paths in range mode; a doc-test proving `extractBatch` (node-tar) never writes tar entries outside `destDir`.

- [ ] **Step 1: Write the failing tests**

In `ferry-cli/tests/transfer.test.ts`:

```ts
import { gzipSync } from 'node:zlib';

/** Hand-built ustar entry: node-tar must sanitize what a malicious server could send. */
function rawTarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148); // checksum field = spaces while summing
  header.write('0', 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(body);
  return Buffer.concat([header, body]);
}

it('range mode refuses to write outside the clone', async () => {
  const destDir = mkdtempSync(join(tmpdir(), 'ferry-guard-'));
  const client = new FerryClient('http://127.0.0.1:9', 'never-reached');
  await expect(
    fetchAll(client, [{ path: '../evil.bin', size: 10, hash: null }], destDir, { maxBytes: 4 }),
  ).rejects.toThrow(/refusing range write outside the clone/);
  expect(existsSync(join(destDir, '..', 'evil.bin'))).toBe(false);
  rmSync(destDir, { recursive: true, force: true });
});

it('batch extraction never writes tar entries outside destDir (node-tar guard)', async () => {
  const destDir = mkdtempSync(join(tmpdir(), 'ferry-tarx-'));
  const meta = Buffer.from(JSON.stringify({ complete: true, next_index: 2, skipped: [] }));
  const archive = Buffer.concat([
    rawTarEntry('../escape.txt', Buffer.from('evil')),
    rawTarEntry('.ferry-meta.json', meta),
    Buffer.alloc(1024), // end-of-archive blocks
  ]);
  await extractBatch(gzipSync(archive), destDir);
  expect(existsSync(join(destDir, '..', 'escape.txt'))).toBe(false);
  rmSync(destDir, { recursive: true, force: true });
});
```

(`maxBytes: 4` makes the 10-byte entry oversized, forcing range mode; the guard must throw before any HTTP request, so the dead client address is never contacted.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ferry-cli && npx vitest run tests/transfer.test.ts`
Expected: range-mode test FAILS (no guard exists — the rejection message doesn't match); the tar doc-test may already pass (node-tar sanitizes) — that's fine, it pins the behavior.

- [ ] **Step 3: Implement the guard**

In `transfer.ts`, import `resolve, sep` from `node:path`, then at the top of `fetchOversized`:

```ts
  const destRoot = resolve(destDir);
  const dest = resolve(destDir, entry.path);
  if (!dest.startsWith(destRoot + sep)) {
    throw new Error(`refusing range write outside the clone: ${entry.path}`);
  }
```

(Replaces the existing unguarded `const dest = join(destDir, entry.path);`.)

- [ ] **Step 4: Run + commit**

Run: `cd ferry-cli && npx vitest run`
Expected: PASS.

```bash
git add ferry-cli/src/transfer.ts ferry-cli/tests/transfer.test.ts
git commit -m "cli: containment guard on range-mode writes (parked PR #3 item)"
```

---

### Task 8: CLI — `ferry fetch-uploads` command

**Files:**
- Modify: `ferry-cli/src/transfer.ts` (add `fetchManifest` moved from pull.ts)
- Modify: `ferry-cli/src/pull.ts` (import `fetchManifest` from transfer.ts, delete local copy)
- Create: `ferry-cli/src/fetch-uploads.ts`
- Modify: `ferry-cli/src/main.ts`
- Test: `ferry-cli/tests/fetch-uploads.test.ts`

**Interfaces:**
- Consumes: Task 6's wire contract (`scope=uploads`, `prefix=`), `fetchAll` (Task 7 guard included), `loadProfile`/`FERRY_HOME` (existing), `FerryClient`.
- Produces: `fetchManifest(client: FerryClient, query?: Record<string, string>): Promise<ManifestEntry[]>` exported from `transfer.ts`; `fetchUploads(slug: string, opts: { prefix?: string; all?: boolean }): Promise<{ fetched: number; bytes: number; skipped: string[] }>`; CLI command `ferry fetch-uploads <site> [prefix]` / `--all`.

- [ ] **Step 1: Move `fetchManifest`**

Cut the `fetchManifest` function from `pull.ts` verbatim into `transfer.ts`, exported and with a query parameter:

```ts
export async function fetchManifest(
  client: FerryClient,
  query: Record<string, string> = {},
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  let after = 0;
  for (;;) {
    const { data, headers } = await client.getJson('/ferry/v1/manifest', { ...query, after: String(after) });
    entries.push(...(data.files as ManifestEntry[]));
    if (headers['x-complete'] === '1') {
      return entries;
    }
    const next = Number(headers['x-next-index']);
    if (!Number.isFinite(next) || next <= after) {
      throw new Error('manifest made no progress - aborting');
    }
    after = next;
  }
}
```

`pull.ts` imports it from `./transfer.js` (extend the existing `fetchAll` import) and calls `fetchManifest(client)` unchanged.

Run: `cd ferry-cli && npx vitest run` — expected PASS (pure move).

- [ ] **Step 2: Write the failing test**

Create `ferry-cli/tests/fetch-uploads.test.ts` (FERRY_HOME + profile setup mirrors `link.test.ts`):

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchUploads } from '../src/fetch-uploads.js';
import { startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';

describe('fetchUploads', () => {
  let home: string;
  let fixture: string;
  let clone: string;
  let mock: MockPlugin;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    fixture = mkdtempSync(join(tmpdir(), 'ferry-uploads-fixture-'));
    clone = mkdtempSync(join(tmpdir(), 'ferry-clone-'));
    process.env.FERRY_HOME = home;
    mkdirSync(join(fixture, 'wp-content', 'uploads', '2026'), { recursive: true });
    writeFileSync(join(fixture, 'wp-content', 'uploads', '2026', 'a.jpg'), 'image-bytes');
  });

  afterEach(() => {
    mock?.close();
    delete process.env.FERRY_HOME;
    for (const dir of [home, fixture, clone]) rmSync(dir, { recursive: true, force: true });
  });

  function writeProfile(base: string): void {
    mkdirSync(join(home, 'sites', 'demo'), { recursive: true });
    writeFileSync(
      join(home, 'sites', 'demo', 'profile.json'),
      JSON.stringify({ slug: 'demo', url: base, secret: 's', clonePath: clone }),
    );
  }

  it('fetches the uploads manifest for a prefix and materializes the files', async () => {
    const path = 'wp-content/uploads/2026/a.jpg';
    mock = await startMockPlugin(fixture, {
      manifest: [{ path, size: sizeOf(fixture, path), hash: null }],
    });
    writeProfile(mock.base);
    const result = await fetchUploads('demo', { prefix: '2026/' });
    expect(result.fetched).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(clone, path))).toBe(true);
  });

  it('requires a prefix or --all', async () => {
    writeProfile('http://127.0.0.1:9');
    await expect(fetchUploads('demo', {})).rejects.toThrow(/prefix .* or --all/);
  });
});
```

Also extend `mockPlugin.ts`'s `/manifest` handler to record its query (so the scope is assertable) — add to `requests`: `manifest: [] as Record<string, string>[]` and push `Object.fromEntries(url.searchParams.entries())` at the top of the handler. Then add to the first test:

```ts
    expect(mock.requests.manifest[0].scope).toBe('uploads');
    expect(mock.requests.manifest[0].prefix).toBe('2026/');
```

Note: `mockPlugin`'s manifest handler serves halves regardless of scope — good enough; the scope/prefix filtering itself is plugin-side and tested in Task 6. `syncClock` tolerates the mock's missing `/wp-json/` route (any response with a Date header works; if it throws on connection the mock still serves `/wp-json/` 404 with headers — fine).

- [ ] **Step 3: Run to verify failure**

Run: `cd ferry-cli && npx vitest run tests/fetch-uploads.test.ts`
Expected: FAIL — module `../src/fetch-uploads.js` missing.

- [ ] **Step 4: Implement**

Create `ferry-cli/src/fetch-uploads.ts`:

```ts
import { FerryClient } from './client.js';
import { loadProfile } from './profile.js';
import { fetchAll, fetchManifest } from './transfer.js';

export interface FetchUploadsResult {
  fetched: number;
  bytes: number;
  skipped: string[];
}

/** §2.8 escape hatch, bulk edition: materialize production uploads into the clone. */
export async function fetchUploads(slug: string, opts: { prefix?: string; all?: boolean }): Promise<FetchUploadsResult> {
  if (!opts.all && !opts.prefix) {
    throw new Error('specify a prefix (e.g. ferry fetch-uploads mysite 2026/07/) or --all');
  }
  const profile = loadProfile(slug);
  const client = new FerryClient(profile.url, profile.secret);
  await client.syncClock();
  const query: Record<string, string> = { scope: 'uploads' };
  if (!opts.all && opts.prefix) {
    query.prefix = opts.prefix;
  }
  const entries = await fetchManifest(client, query);
  const { skipped } = await fetchAll(client, entries, profile.clonePath);
  return {
    fetched: entries.length - skipped.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    skipped,
  };
}
```

In `main.ts`:

```ts
import { fetchUploads } from './fetch-uploads.js';

program
  .command('fetch-uploads <site> [prefix]')
  .description('Materialize production uploads into the clone (e.g. 2026/07/), or everything with --all')
  .option('--all', 'fetch every upload')
  .action(async (site: string, prefix: string | undefined, opts: { all?: boolean }) => {
    const result = await fetchUploads(site, { prefix, all: opts.all });
    console.log(`✔ Materialized ${result.fetched} file(s) (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
    if (result.skipped.length > 0) {
      console.log(`  Skipped ${result.skipped.length} (gone on production?): ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ', ...' : ''}`);
    }
  });
```

- [ ] **Step 5: Full suite, commit**

Run: `cd ferry-cli && npx vitest run`
Expected: PASS.

```bash
git add ferry-cli/src/fetch-uploads.ts ferry-cli/src/transfer.ts ferry-cli/src/pull.ts ferry-cli/src/main.ts ferry-cli/tests/fetch-uploads.test.ts ferry-cli/tests/helpers/mockPlugin.ts
git commit -m "cli: ferry fetch-uploads command over manifest scope=uploads"
```

---

### Task 9: E2E — fixture prep, gates, runbook

**Files:**
- Create: `e2e/fixtures/ferry-demo-licensed/ferry-demo-licensed.php`
- Create: `e2e/fixtures/ferry-demo-licensed/EDD_SL_Plugin_Updater.php` (vendored)
- Create: `e2e/fixtures/e2e-fake-edd-store.php`
- Create: `docs/superpowers/plans/2026-07-25-ferry-fidelity-e2e-runbook.md`

This task runs against the real DDEV fixture (`~/ferry-e2e/prod`, plugin dir `ferry-connect`) and the paired clone. Prereq: `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` and `cd ferry-cli && npx tsc` (the CLI runs from `dist/`). **Never** restore the fixture with `ddev wp core download` (truncates >90-char filenames) — use the official zip.

- [ ] **Step 1: Create the licensed fixture plugin**

`e2e/fixtures/ferry-demo-licensed/ferry-demo-licensed.php`:

```php
<?php
/*
Plugin Name: Ferry Demo Licensed
Description: E2E fixture - strict EDD-style licensed plugin. Any non-valid license answer (including network errors) flips status to invalid, so the harness stub is the only thing keeping it alive in the clone.
Version: 1.0.0
*/
if (!defined('ABSPATH')) { exit; }

define('FERRY_DEMO_STORE', home_url('/')); // the fake store mu-plugin answers on this same fixture site
define('FERRY_DEMO_ITEM', 'Ferry Demo Licensed');

require __DIR__ . '/EDD_SL_Plugin_Updater.php'; // genuine EDD client, vendored

add_action('admin_init', function () {
    new EDD_SL_Plugin_Updater(FERRY_DEMO_STORE, __FILE__, [
        'version'   => '1.0.0',
        'license'   => 'FERRY-E2E-KEY',
        'item_name' => FERRY_DEMO_ITEM,
        'author'    => 'ferry',
    ]);
    $response = wp_remote_post(FERRY_DEMO_STORE, [
        'timeout' => 10,
        'body'    => [
            'edd_action' => 'check_license',
            'license'    => 'FERRY-E2E-KEY',
            'item_name'  => FERRY_DEMO_ITEM,
            'url'        => home_url(),
        ],
    ]);
    $status = 'invalid';
    if (!is_wp_error($response)) {
        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (is_array($data) && isset($data['license']) && $data['license'] === 'valid') {
            $status = 'valid';
        }
    }
    update_option('ferry_demo_license_status', $status);
});

add_action('admin_notices', function () {
    $status = get_option('ferry_demo_license_status', 'unknown');
    if ($status === 'valid') {
        echo '<div class="notice notice-success"><p>Ferry Demo Licensed: license VALID - premium feature active.</p></div>';
    } else {
        echo '<div class="notice notice-error"><p>Ferry Demo Licensed: license ' . esc_html($status) . ' - premium feature DISABLED.</p></div>';
    }
});
```

Vendor the genuine client: download `EDD_SL_Plugin_Updater.php` from the `easydigitaldownloads/edd-sample-plugin` GitHub repo (raw file at its default branch) into the fixture plugin dir. Do not modify it — the point is that real client code runs.

`e2e/fixtures/e2e-fake-edd-store.php` (deliberately NOT `ferry-`-prefixed — that prefix is transfer-excluded since Task 4):

```php
<?php
/* E2E fixture: answers EDD license API calls so the production fixture has a real,
   reachable licensing "store". Never needed in the clone - the harness stub answers there. */
add_action('init', function () {
    if (!isset($_REQUEST['edd_action'])) { return; }
    wp_send_json([
        'success'          => true,
        'license'          => 'valid',
        'item_name'        => isset($_REQUEST['item_name']) ? sanitize_text_field(wp_unslash($_REQUEST['item_name'])) : '',
        'expires'          => 'lifetime',
        'activations_left' => 'unlimited',
    ]);
});
```

Commit: `git add e2e/ && git commit -m "e2e: licensed-plugin fixture (genuine EDD client) and fake store"`

- [ ] **Step 2: Seed the production fixture**

```bash
cd ~/ferry-e2e/prod
# WooCommerce: brings woocommerce_sessions + actionscheduler_* tables AND is the real WC.com helper client
ddev wp plugin install woocommerce --activate
# AS actions: one pending (must survive lite pull), one completed (must be dropped)
ddev wp eval 'as_schedule_single_action(time() + 86400, "ferry_e2e_pending"); as_enqueue_async_action("ferry_e2e_done");'
ddev wp action-scheduler run
# revisions + transients
ddev wp post update 1 --post_content="ferry rev seed 1"
ddev wp post update 1 --post_content="ferry rev seed 2"
ddev wp transient set ferry_e2e_transient hello 3600
# session row
ddev wp db query "INSERT INTO wp_woocommerce_sessions (session_key, session_value, session_expiry) VALUES ('ferry_e2e', 'a:0:{}', UNIX_TIMESTAMP()+86400)"
# WC.com helper token (fake - the stub answers the pings)
ddev wp option update woocommerce_helper_data '{"auth":{"access_token":"ferry-e2e","access_token_secret":"x","site_id":1,"user_id":1,"updated":0}}' --format=json
# licensed plugin + fake store
cp -r <repo>/e2e/fixtures/ferry-demo-licensed wp-content/plugins/
mkdir -p wp-content/mu-plugins && cp <repo>/e2e/fixtures/e2e-fake-edd-store.php wp-content/mu-plugins/
ddev wp plugin activate ferry-demo-licensed
# uploads: image exists under 2026/; add a font
printf 'wOF2fake-font-bytes' > wp-content/uploads/2026/e2e-font.woff2
```

Verify on production before pulling: `ddev wp eval "do_action('admin_init');" && ddev wp option get ferry_demo_license_status` → `valid` (the fake store answered). If not, debug the fixture before continuing.

- [ ] **Step 3: Gate 1 — lite pull**

```bash
cd <repo>/ferry-cli && npx tsc
node dist/main.js pull <site-slug>
```

Expected output includes the `Lite DB pull: skipped ...` line. Then in the clone dir:

```bash
ddev wp db query "SELECT COUNT(*) AS c FROM wp_posts WHERE post_type='revision'"          # 0
ddev wp transient get ferry_e2e_transient                                                  # empty
ddev wp db query "SELECT COUNT(*) AS c FROM wp_woocommerce_sessions"                       # table exists, 0
ddev wp db query "SELECT COUNT(*) AS c FROM wp_actionscheduler_logs"                       # table exists, 0
ddev wp db query "SELECT status, hook FROM wp_actionscheduler_actions WHERE hook LIKE 'ferry_e2e%'"
# ferry_e2e_pending present (pending), ferry_e2e_done ABSENT
```

- [ ] **Step 4: Gate 2 — license stubs**

In the clone dir:

```bash
ddev wp eval "do_action('admin_init');"
ddev wp option get ferry_demo_license_status        # valid  <- the stub kept it alive
ddev logs -s web 2>&1 | grep 'ferry-harness'        # 'stubbed:' lines present for the store call
```

Then in the browser: clone `/wp-admin/` shows the green "license VALID" notice; WooCommerce → Extensions loads without a fatal (helper pings stubbed). Negative control: temporarily rename `wp-content/mu-plugins/ferry-stubs.php` in the clone, run `ddev wp eval "do_action('admin_init');"` again → status flips to `invalid`; restore the file, re-run, back to `valid`.

- [ ] **Step 5: Gate 3 — uploads materialization**

DDEV-only network wrinkle (real production origins are public; sibling DDEV projects are not): from inside the clone's web container, `ferry-prod.ddev.site` resolves to loopback. Add to the **clone's** `.ddev/` a file `docker-compose.ferry-e2e.yaml`:

```yaml
services:
  web:
    external_links:
      - "ddev-router:<prod-hostname>.ddev.site"
```

then `ddev restart`. (Document this in the runbook as E2E-only.) Now:

```bash
curl -kI https://<clone>/wp-content/uploads/2026/<existing-image>   # 200, correct content-type
ls wp-content/uploads/2026/<existing-image>                          # materialized on disk
curl -kI https://<clone>/wp-content/uploads/2026/e2e-font.woff2      # 200, font/woff2, same-origin
curl -kI https://<clone>/wp-content/uploads/2026/nope.jpg            # 302 to production (miss floor)
curl -kI 'https://<clone>/wp-content/uploads/..%2Fwp-config.php'     # 404 (traversal rejected by the script;
                                                                     # plain ../ would be normalized away by nginx before matching)
```

- [ ] **Step 6: Gate 4 — fetch-uploads + full pull**

```bash
node dist/main.js fetch-uploads <site-slug> 2026/    # materializes the prefix; files on disk afterwards
node dist/main.js pull <site-slug> --full
# in the clone: revisions are back
ddev wp db query "SELECT COUNT(*) AS c FROM wp_posts WHERE post_type='revision'"   # 2
```

- [ ] **Step 7: Write the runbook + commit**

Write `docs/superpowers/plans/2026-07-25-ferry-fidelity-e2e-runbook.md` recording: fixture-seeding commands (Step 2), the four gates with their exact commands and observed outputs, the `docker-compose.ferry-e2e.yaml` sibling-networking workaround, and any deviations discovered. Commit:

```bash
git add docs/superpowers/plans/2026-07-25-ferry-fidelity-e2e-runbook.md
git commit -m "e2e: fidelity-slice runbook with verified gate outputs"
```

---

## Final verification (before PR)

- [ ] `cd ferry-plugin && vendor/bin/phpunit` — green
- [ ] `cd ferry-cli && npx vitest run` — green
- [ ] `cd ferry-cli && npx tsc --noEmit` — clean
- [ ] All four E2E gates observed on the real fixture (Task 9)
- [ ] Whole-branch review, then PR against `main` titled "Ferry Plan 2: fidelity slice (DB exclusions, license stubs, uploads materialization)"
