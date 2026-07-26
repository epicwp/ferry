# Binlog spike — pinned mechanics (Plan 5a, Task 1)

**Date:** 2026-07-26 · Pinned against the **real running clone**, not docs or memory.
Clone under test: DDEV project `ferry-prod-ddev-site` at `~/.ferry/clones/ferry-prod-ddev-site`
(verified running via `ddev list`). Environment: DDEV `v1.24.6`, arch `arm64` (Apple Silicon host),
db image `ddev/ddev-dbserver-mariadb-10.11:v1.24.6`, container OS `Ubuntu 22.04.5 LTS`, MariaDB
`10.11.11-MariaDB-ubu2204-log` (confirmed via `SELECT VERSION();`).

Supersedes the binlog assumptions in
`docs/superpowers/specs/2026-07-26-ferry-plan5-write-back-design.md` (Journal capture section,
lines 136–157). Two mechanical deviations were found (see "Deviations" below) — **no structural
break**: `mysqlbinlog` exists, `--start-position` + filename works, `-v` gives `@N=` ordinals as
expected. Task 10 can proceed without further human sign-off, but must read the deviations below.

## Step 1: Enable binlog on the clone

File written: `~/.ferry/clones/ferry-prod-ddev-site/.ddev/mysql/ferry-binlog.cnf`

```ini
[mysqld]
log-bin=ferry-bin
binlog-format=ROW
binlog-row-image=FULL
server-id=1
expire-logs-days=14
```

Restart (required — DDEV only applies dropped-in mysql config on restart, not live):

```
cd ~/.ferry/clones/ferry-prod-ddev-site
ddev restart
```

`ddev restart` output confirms the file was picked up:

```
Using custom MySQL configuration:
  - /Users/robbertvermeulen/.ferry/clones/ferry-prod-ddev-site/.ddev/mysql/ferry-binlog.cnf

Custom configuration is updated on restart.
If you don't see your custom configuration taking effect, run 'ddev restart'.
```

Verify:

```
$ ddev mysql -e "SHOW VARIABLES LIKE 'log_bin'"
Variable_name	Value
log_bin	ON
```

**PIN CONFIRMED:** exact cnf from the brief works verbatim, one `ddev restart` is sufficient, no
other provisioning step needed.

## Step 2: Position + extraction commands

### Status statement variant

Both `SHOW MASTER STATUS` and `SHOW BINLOG STATUS` work on this MariaDB (10.11.11) and return
identical output — `SHOW BINLOG STATUS` is not a MariaDB-only rename that replaces the old one;
both names are live on this version:

```
$ ddev mysql -e "SHOW MASTER STATUS"
File	Position	Binlog_Do_DB	Binlog_Ignore_DB
ferry-bin.000001	328

$ ddev mysql -e "SHOW BINLOG STATUS"
File	Position	Binlog_Do_DB	Binlog_Ignore_DB
ferry-bin.000001	328
```

**Pin:** Task 10 should use `SHOW BINLOG STATUS` (the current non-deprecated name in MariaDB
10.5+) as primary, since `SHOW MASTER STATUS` is the legacy/deprecated alias and may be removed
in a future MariaDB major version. Both are safe to use today on 10.11.x.

### Container binlog path

`/var/lib/mysql/ferry-bin.000001` — confirmed by directory listing inside the `db` container:

```
$ ddev exec -s db "ls -la /var/lib/mysql/ | grep -E 'ferry-bin|\.index'"
-rw-rw---- 1 ... 328 ... ferry-bin.000001
-rw-rw---- 1 ...  19 ... ferry-bin.index
```

This matches the design doc's assumed path exactly — no path deviation.

### `mysqlbinlog` availability — DEVIATION 1 (mechanical, not structural)

The design doc's pinned command was `ddev exec mysqlbinlog --base64-output=decode-rows -v ...`.
`ddev exec` without `-s <service>` targets the **`web`** container by default, and `mysqlbinlog`
is **not installed there**:

```
$ ddev exec "mysqlbinlog --version"
bash: line 1: mysqlbinlog: command not found
```

It **is** installed in the **`db`** container:

```
$ ddev exec -s db "mysqlbinlog --no-defaults --version"
mysqlbinlog Ver 3.5 for debian-linux-gnu at aarch64
```

**Pin:** the extraction command must target the db service explicitly: `ddev exec -s db "..."`.

### `--no-defaults` — DEVIATION 2 (mechanical, not structural)

Running `mysqlbinlog` in the `db` container *without* `--no-defaults` fails because it reads the
container's my.cnf client section, which sets a variable `mysqlbinlog` doesn't understand:

```
$ ddev exec -s db "mysqlbinlog --version"
mysqlbinlog: unknown variable 'default-character-set=utf8mb4'
[exit status 7]
```

The brief's pinned command already included `--no-defaults` — this run confirms it is **not**
optional/defensive, it is **required** on this image, or every invocation fails outright.

### Final pinned extraction command

```
ddev exec -s db "mysqlbinlog --no-defaults --base64-output=decode-rows -v \
  --start-position=<pos> [--stop-position=<pos>] /var/lib/mysql/ferry-bin.000001"
```

(vs. the design doc's `ddev exec mysqlbinlog --base64-output=decode-rows -v ...` — add `-s db`
and `--no-defaults`.)

### Does `--start-position` + filename suffice?

**Yes.** `--start-position=<pos>` combined with the plain file path is sufficient to jump to that
exact byte offset in the log and dump forward (optionally bounded with `--stop-position=<pos>` for
a clean single-transaction window). No other flag is required to resolve the position.

One nuance found empirically: **the exact position matters relative to event boundaries.**
`SHOW BINLOG STATUS`/`SHOW MASTER STATUS` reports the position at which the *next* event will be
written. If you record that position immediately before your write and pass it as
`--start-position`, you land exactly on the `GTID ... trans` event that opens the transaction, and
the dump includes the full `GTID` + `START TRANSACTION` header. If you instead pass the position
of the *end* of that GTID event (e.g. taken from a mid-file `# at <N>` marker one event later),
mysqlbinlog silently starts mid-transaction and omits the GTID/`START TRANSACTION` lines — still
parses fine (the row events are complete), just a leaner header. Task 10 should record position
**before** each write (per the design doc's "after every DB import" bookkeeping model) to get full
transaction envelopes.

**Operational finding (validates the design doc's noise-filtering requirement):** even on an
otherwise idle site, WordPress's own background activity (in this case, transient-cache
expiry/rewrite of `_site_transient_wp_theme_files_patterns...` and its `_timeout_` sibling) wrote
~30KB and ~64KB of unrelated binlog events *between* our spike writes, purely from `ddev wp option
update` triggering unrelated WP internals. This is exactly the "background writes" case the design
doc already calls out (§ "Curation is mandatory") — confirming the engine cannot assume a
contiguous position range belongs solely to the agent's fix; it must filter to the tables/PKs the
agent's `db_journal` selection actually references.

### Ordinal mapping (`@1=`, `@2=`, ... — no column names)

With `-v`, row events show only positional ordinals, never column names — exactly as the brief
expected. Confirmed against `SHOW COLUMNS` for both tables touched by the fixtures:

```
$ ddev mysql -e "SHOW COLUMNS FROM wp_options"
Field	Type	Null	Key	Default	Extra
option_id	bigint(20) unsigned	NO	PRI	NULL	auto_increment
option_name	varchar(191)	NO	UNI
option_value	longtext	NO		NULL
autoload	varchar(20)	NO	MUL	yes

$ ddev mysql -e "SHOW COLUMNS FROM wp_postmeta"
Field	Type	Null	Key	Default	Extra
meta_id	bigint(20) unsigned	NO	PRI	NULL	auto_increment
post_id	bigint(20) unsigned	NO	MUL	0
meta_key	varchar(255)	YES	MUL	NULL
meta_value	longtext	YES		NULL
```

So for `wp_options`: `@1`=`option_id`, `@2`=`option_name`, `@3`=`option_value`, `@4`=`autoload`.
For `wp_postmeta`: `@1`=`meta_id`, `@2`=`post_id`, `@3`=`meta_key`, `@4`=`meta_value`. Both match
the captured fixtures exactly (see below) — **pin confirmed**: the parser must call
`SHOW COLUMNS FROM <table>` once per table (or cache it) and zip the ordinal list against it; there
is no other source of column names in the binlog output.

`binlog-row-image=FULL` also confirmed working as intended: `UPDATE`/`DELETE` events carry a full
`### WHERE` (before-image, all columns) and `UPDATE` additionally carries a full `### SET`
(after-image, all columns) — not just the changed column(s).

## Step 3: Fixture capture

Three throwaway writes were made against the clone, then extracted and trimmed to one clean
transaction each (GTID → annotate/table-map → row event → Xid/COMMIT), verified byte-exact against
a fresh re-run of the same `mysqlbinlog` command via `diff` before being saved.

### `ferry-cli/test-fixtures/binlog/update-option.txt` — `### UPDATE` on `wp_options`

Provenance:
1. `ddev wp option update ferry_spike_opt hello` — **first** write to a non-existent option. This
   does **not** produce an `### UPDATE` event; WP's `add_option()` path issues
   `INSERT ... ON DUPLICATE KEY UPDATE`, which MariaDB executes as a physical `INSERT` since the
   row didn't exist yet (visible in the raw dump as `### INSERT INTO wp_options`). Noted here so
   a future spike doesn't repeat the mistake of assuming the first `wp option update` yields an
   UPDATE event.
2. Recorded `SHOW BINLOG STATUS` → `ferry-bin.000001`, position `96635`.
3. `ddev wp option update ferry_spike_opt world` — option now exists, so this **is** a genuine
   `UPDATE` statement under the hood, confirmed by the `#Q>` annotate-row comment:
   `UPDATE wp_options SET option_value = 'world' WHERE option_name = 'ferry_spike_opt'`.
4. Extracted with:
   `ddev exec -s db "mysqlbinlog --no-defaults --base64-output=decode-rows -v --start-position=96635 /var/lib/mysql/ferry-bin.000001"`
   (ran to end of file; this was the last event written at capture time).
5. Saved verbatim (no trimming needed — the extraction window happened to contain exactly one
   transaction).

### `ferry-cli/test-fixtures/binlog/insert-postmeta.txt` — `### INSERT` on `wp_postmeta`

Provenance:
1. `ddev wp post list --post_type=post --field=ID --posts_per_page=1` → post ID `5`.
2. `ddev wp post meta add 5 ferry_spike_meta hello_meta`.
3. Extracted with:
   `ddev exec -s db "mysqlbinlog --no-defaults --base64-output=decode-rows -v --start-position=95626 --stop-position=95970 /var/lib/mysql/ferry-bin.000001"`
   — `95626` is the position of this transaction's `GTID 0-1-6 trans` event (taken from a full-file
   dump used only for locating boundaries, not saved); `95970` is its `Xid`/`COMMIT` end position.

### `ferry-cli/test-fixtures/binlog/delete-row.txt` — `### DELETE` on a throwaway table

Provenance:
1. `ddev mysql -e "CREATE TABLE ferry_spike_table (id INT PRIMARY KEY, val VARCHAR(20)); INSERT INTO ferry_spike_table VALUES (1, 'x');"`
2. `ddev mysql -e "DELETE FROM ferry_spike_table WHERE id = 1;"`
3. Extracted with:
   `ddev exec -s db "mysqlbinlog --no-defaults --base64-output=decode-rows -v --start-position=96396 --stop-position=96635 /var/lib/mysql/ferry-bin.000001"`
   — `96396` is this transaction's `GTID 0-1-9 trans` position, `96635` its `Xid`/`COMMIT` end
   position.

All three files keep the full header (`SET @@SESSION.PSEUDO_SLAVE_MODE`, `DELIMITER`, the
`GTID .../START TRANSACTION` preamble, and the closing `ROLLBACK /* added by mysqlbinlog */`
footer) the way real `mysqlbinlog` output always includes them — the parser must skip these lines,
not assume the file starts directly at a `### ` marker.

## Cleanup performed

All throwaway spike artifacts were removed from the clone after fixture capture:

```
$ ddev wp option delete ferry_spike_opt
Success: Deleted 'ferry_spike_opt' option.
$ ddev wp post meta delete 5 ferry_spike_meta
Success: Deleted custom field.
$ ddev mysql -e "DROP TABLE IF EXISTS ferry_spike_table;"
```

Verified gone: `ddev wp option get ferry_spike_opt` and `ddev wp post meta get 5 ferry_spike_meta`
both error "does not exist"; `SHOW TABLES LIKE 'ferry_spike%'` returns no rows.

The `.ddev/mysql/ferry-binlog.cnf` file and the resulting `log_bin=ON` state were **left in
place** — enabling binlog is the point of this spike and the brief explicitly allows it
("enabling binlog and `ddev restart` on it is fine"); Task 10 will need a clone with binlog
already enabled to build and test against.

## Summary for Task 10

- Provision cnf: verbatim as pinned in Step 1, one `ddev restart` needed after write.
- Status query: prefer `SHOW BINLOG STATUS`; `SHOW MASTER STATUS` also works on 10.11.x but is
  the deprecated name.
- Binlog path: `/var/lib/mysql/<log-bin-basename>.NNNNNN` inside the **`db`** container.
- Extraction: `ddev exec -s db "mysqlbinlog --no-defaults --base64-output=decode-rows -v --start-position=<pos> [--stop-position=<pos>] <path>"`
  — note the `-s db` and `--no-defaults` the design doc's sketch omitted.
- Record position **before** a write (not after) to capture the full GTID/transaction envelope.
- Column names are never in the binlog; resolve `@N=` ordinals via `SHOW COLUMNS FROM <table>` in
  ordinal order.
- Expect and filter WordPress background noise events interleaved between the agent's actual
  writes — confirmed to occur even on an idle site.
