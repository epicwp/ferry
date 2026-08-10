<?php
namespace Ferry;

/**
 * Typed DB write operations (spec §9): a closed op set, hard refusal of
 * content tables, and a transactional read-set compare-and-swap. The plugin
 * never receives raw SQL from the wire - every write is one of the shapes
 * below, built into SQL here.
 */
final class DbOps
{
    const KINDS = [
        'option_set', 'option_delete',
        'postmeta_set', 'postmeta_delete',
        'row_update', 'row_insert', 'row_delete',
    ];

    const ROW_KINDS = ['row_update', 'row_insert', 'row_delete'];

    // Global Constraints: content never crosses. Exact names after stripping $prefix,
    // plus pattern matches for WooCommerce/Action Scheduler's own table families.
    const REFUSED_TABLES = ['posts', 'comments', 'commentmeta', 'users', 'usermeta'];
    const REFUSED_PATTERNS = ['/^woocommerce_/', '/^wc_/', '/^actionscheduler_/'];

    // Identifier hygiene, defense in depth beyond quote_ident's backtick-doubling: a
    // table/pkCol/column name arriving from the wire must look like a real SQL identifier.
    const IDENT_RE = '/\A[A-Za-z0-9_]+\z/';

    /**
     * @param array $ops list of typed op assoc arrays (see class doc)
     * @return array{ok: array[], refused: array{index:int,reason:string}[]}
     */
    public static function validate(array $ops, string $prefix): array
    {
        $ok = [];
        $refused = [];
        foreach ($ops as $index => $op) {
            $kind = isset($op['kind']) ? $op['kind'] : null;
            if (!in_array($kind, self::KINDS, true)) {
                $refused[] = ['index' => $index, 'reason' => 'unknown_kind'];
                continue;
            }
            if (!self::shape_ok($kind, $op)) {
                $refused[] = ['index' => $index, 'reason' => 'bad_shape'];
                continue;
            }
            if (in_array($kind, self::ROW_KINDS, true)) {
                if (!self::identifiers_ok($op)) {
                    $refused[] = ['index' => $index, 'reason' => 'bad_identifier'];
                    continue;
                }
                if (self::table_refused((string) $op['table'], $prefix)) {
                    $refused[] = ['index' => $index, 'reason' => 'refused_table'];
                    continue;
                }
            }
            $ok[] = $op;
        }
        return ['ok' => $ok, 'refused' => $refused];
    }

    /** table/pkCol, plus every column name in 'new' (and 'old' for row_update), must match IDENT_RE. */
    private static function identifiers_ok(array $op): bool
    {
        if (!self::valid_ident((string) $op['table']) || !self::valid_ident((string) $op['pkCol'])) {
            return false;
        }
        $cols = [];
        if (isset($op['new']) && is_array($op['new'])) {
            $cols = array_merge($cols, array_keys($op['new']));
        }
        if ($op['kind'] === 'row_update' && isset($op['old']) && is_array($op['old'])) {
            $cols = array_merge($cols, array_keys($op['old']));
        }
        foreach ($cols as $col) {
            if (!self::valid_ident((string) $col)) {
                return false;
            }
        }
        return true;
    }

    private static function valid_ident(string $name): bool
    {
        return preg_match(self::IDENT_RE, $name) === 1;
    }

    /** Case-insensitive: MySQL table names are effectively case-insensitive on the usual
     *  collations/filesystems, and a bare-case-only rename must not smuggle content past this. */
    private static function table_refused(string $table, string $prefix): bool
    {
        $lowerTable = strtolower($table);
        $lowerPrefix = strtolower($prefix);
        $bare = (strpos($lowerTable, $lowerPrefix) === 0) ? substr($lowerTable, strlen($lowerPrefix)) : $lowerTable;
        if (in_array($bare, self::REFUSED_TABLES, true)) {
            return true;
        }
        foreach (self::REFUSED_PATTERNS as $pattern) {
            if (preg_match($pattern, $bare)) {
                return true;
            }
        }
        return false;
    }

    private static function shape_ok(string $kind, array $op): bool
    {
        switch ($kind) {
            case 'option_set':
                return array_key_exists('name', $op) && array_key_exists('old', $op) && array_key_exists('new', $op);
            case 'option_delete':
                return array_key_exists('name', $op) && array_key_exists('old', $op);
            case 'postmeta_set':
                return array_key_exists('postId', $op) && array_key_exists('key', $op) && array_key_exists('old', $op) && array_key_exists('new', $op);
            case 'postmeta_delete':
                return array_key_exists('postId', $op) && array_key_exists('key', $op) && array_key_exists('old', $op);
            case 'row_update':
                return array_key_exists('table', $op) && array_key_exists('pkCol', $op) && array_key_exists('pk', $op) && array_key_exists('old', $op) && array_key_exists('new', $op);
            case 'row_insert':
                return array_key_exists('table', $op) && array_key_exists('pkCol', $op) && array_key_exists('pk', $op) && array_key_exists('new', $op);
            case 'row_delete':
                return array_key_exists('table', $op) && array_key_exists('pkCol', $op) && array_key_exists('pk', $op) && array_key_exists('old', $op);
            default:
                return false;
        }
    }

    /**
     * One read-set entry per op target, plus one per option/row precondition.
     * `file_hash` preconditions are not DB reads - they join the file drift
     * step (Task 9), not this transaction.
     *
     * No $wpdb here by design, but every literal value still passes through
     * `$wpdb->prepare()` - just not in this method. Each entry's `sql` is a
     * template with `%s`/`%d` placeholders for literal values (never a
     * hand-escaped literal concatenated into the string); `args` carries the
     * literal values in placeholder order. `apply_in_transaction` - which does
     * have `$wpdb` - resolves each entry via `$wpdb->prepare($entry['sql'], ...$entry['args'])`
     * immediately before executing it, so every literal gets wpdb's real,
     * charset-aware escaping. Identifiers (table/column names) have no
     * placeholder syntax in SQL, so those are still baked into `sql` directly
     * via `quote_ident`.
     *
     * Each entry also carries an internal `whole` flag (beyond the documented
     * {sql,key,expected} shape) used only by `apply_in_transaction` to know
     * whether the query selects one column (extract the scalar) or a full row
     * via `SELECT *` (compare column-by-column) - see `apply_in_transaction`.
     *
     * @return array{sql:string,args:array,key:string,expected:mixed,whole:bool}[]
     */
    public static function read_set(array $ops, array $preconditions, string $prefix): array
    {
        $entries = [];
        foreach ($ops as $op) {
            $entries[] = self::op_entry($op, $prefix);
        }
        foreach ($preconditions as $pre) {
            $type = isset($pre['type']) ? $pre['type'] : null;
            if ($type === 'option') {
                $entries[] = self::option_entry((string) $pre['name'], $prefix, $pre['expected']);
            } elseif ($type === 'row') {
                $entries[] = self::row_column_entry((string) $pre['table'], (string) $pre['pkCol'], (int) $pre['pk'], (string) $pre['column'], $pre['expected']);
            }
            // 'file_hash' intentionally not handled here.
        }
        // An op and its matching precondition target the same key with the same expected
        // value - keep one entry so a single drifted value reports a single conflict.
        // Same key with a DIFFERENT expected stays duplicated on purpose: both checks ran.
        $unique = [];
        foreach ($entries as $entry) {
            $unique[$entry['key'] . '|' . serialize($entry['expected'])] = $entry;
        }
        return array_values($unique);
    }

    private static function op_entry(array $op, string $prefix): array
    {
        switch ($op['kind']) {
            case 'option_set':
            case 'option_delete':
                return self::option_entry((string) $op['name'], $prefix, $op['old']);
            case 'postmeta_set':
            case 'postmeta_delete':
                return self::postmeta_entry((int) $op['postId'], (string) $op['key'], $prefix, $op['old']);
            default: // row_update / row_insert / row_delete
                $table = (string) $op['table'];
                $pkCol = (string) $op['pkCol'];
                $pk = (int) $op['pk'];
                return [
                    'sql' => "SELECT * FROM " . self::quote_ident($table) . " WHERE " . self::quote_ident($pkCol) . " = %d FOR UPDATE",
                    'args' => [$pk],
                    'key' => "row:{$table}:{$pkCol}={$pk}",
                    'expected' => $op['kind'] === 'row_insert' ? null : $op['old'], // absent-row semantics: row_insert must find nothing
                    'whole' => true,
                ];
        }
    }

    private static function option_entry(string $name, string $prefix, $expected): array
    {
        return [
            'sql' => "SELECT option_value FROM " . $prefix . "options WHERE option_name = %s LIMIT 1 FOR UPDATE",
            'args' => [$name],
            'key' => 'option:' . $name,
            'expected' => $expected,
            'whole' => false,
        ];
    }

    private static function postmeta_entry(int $postId, string $key, string $prefix, $expected): array
    {
        // A (post_id, meta_key) pair is not unique in wp_postmeta - multiple rows
        // can share it. This targets a single row (LIMIT 1); which row is undefined
        // without an ORDER BY. Matches the op's own semantics: it operates on one row.
        return [
            'sql' => "SELECT meta_value FROM " . $prefix . "postmeta WHERE post_id = %d AND meta_key = %s LIMIT 1 FOR UPDATE",
            'args' => [$postId, $key],
            'key' => "postmeta:{$postId}:{$key}",
            'expected' => $expected,
            'whole' => false,
        ];
    }

    private static function row_column_entry(string $table, string $pkCol, int $pk, string $column, $expected): array
    {
        return [
            'sql' => "SELECT " . self::quote_ident($column) . " FROM " . self::quote_ident($table)
                . " WHERE " . self::quote_ident($pkCol) . " = %d LIMIT 1 FOR UPDATE",
            'args' => [$pk],
            'key' => "row:{$table}:{$pkCol}={$pk}:{$column}",
            'expected' => $expected,
            'whole' => false,
        ];
    }

    /** Backtick-quoted identifier (table/column names sourced from op/precondition data). */
    private static function quote_ident(string $name): string
    {
        return '`' . str_replace('`', '``', $name) . '`';
    }

    /**
     * Spec §9, verbatim: START TRANSACTION -> SELECT ... FOR UPDATE every
     * read-set row (always - locks are taken even under $force) -> compare
     * found vs expected (skipped under $force) -> any mismatch: ROLLBACK,
     * return every conflict (never stop at the first) -> all match: apply
     * each op; if any apply statement fails (InnoDB fails only that
     * statement, e.g. a unique violation or NOT NULL/strict-mode error - it
     * does not abort the transaction on its own), ROLLBACK immediately and
     * report a distinct `apply_error` instead of committing a partial write;
     * else COMMIT.
     *
     * @return array{committed:bool, conflicts: array{key:string,expected:mixed,found:mixed}[], apply_error?: array{key:string,detail:string}}
     */
    public static function apply_in_transaction($wpdb, array $ops, array $preconditions, string $prefix, bool $force): array
    {
        $entries = self::read_set($ops, $preconditions, $prefix);

        $wpdb->query('START TRANSACTION');

        $conflicts = [];
        foreach ($entries as $entry) {
            $row = $wpdb->get_row($wpdb->prepare($entry['sql'], ...$entry['args']), ARRAY_A);
            if ($force) {
                continue; // still locked above; compare intentionally skipped
            }
            $found = $entry['whole'] ? $row : ($row === null ? null : reset($row));
            if (!self::values_match($entry['expected'], $found)) {
                $conflicts[] = ['key' => $entry['key'], 'expected' => $entry['expected'], 'found' => $found];
            }
        }

        if ($conflicts !== []) {
            $wpdb->query('ROLLBACK');
            return ['committed' => false, 'conflicts' => $conflicts];
        }

        foreach ($ops as $op) {
            if (self::apply($wpdb, $op, $prefix) === false) {
                $wpdb->query('ROLLBACK');
                return ['committed' => false, 'conflicts' => [], 'apply_error' => ['key' => self::label($op), 'detail' => $op['kind'] . ' apply failed']];
            }
        }

        $wpdb->query('COMMIT');
        self::invalidate_caches($ops);
        return ['committed' => true, 'conflicts' => []];
    }

    /** Security skim: raw-SQL writes bypass persistent object caches (Redis/Memcached) -
     *  without this the running site (and the push's own smoke check) keeps reading the
     *  stale cached value. Covers commit AND rollback (both route through
     *  apply_in_transaction). row_* ops have no reliable cache key - accepted; the
     *  refused-table policy keeps those away from WP's hot cached entities anyway. */
    private static function invalidate_caches(array $ops): void
    {
        $touchedOptions = false;
        foreach ($ops as $op) {
            switch ($op['kind']) {
                case 'option_set':
                case 'option_delete':
                    wp_cache_delete((string) $op['name'], 'options');
                    $touchedOptions = true;
                    break;
                case 'postmeta_set':
                case 'postmeta_delete':
                    wp_cache_delete((int) $op['postId'], 'post_meta');
                    break;
            }
        }
        if ($touchedOptions) {
            wp_cache_delete('alloptions', 'options'); // WP's option API also caches the autoload bundle
        }
    }

    private static function label(array $op): string
    {
        switch ($op['kind']) {
            case 'option_set':
            case 'option_delete':
                return 'option:' . $op['name'];
            case 'postmeta_set':
            case 'postmeta_delete':
                return 'postmeta:' . $op['postId'] . ':' . $op['key'];
            default:
                return 'row:' . $op['table'] . ':' . $op['pkCol'] . '=' . $op['pk'];
        }
    }

    private static function values_match($expected, $found): bool
    {
        if ($expected === null || $found === null) {
            return $expected === $found; // absent-row semantics: null means "no row"
        }
        if (is_array($expected) && is_array($found)) {
            foreach ($expected as $col => $val) {
                if (!array_key_exists($col, $found) || $found[$col] !== $val) {
                    return false;
                }
            }
            return true;
        }
        return $expected === $found;
    }

    /** @return mixed the underlying $wpdb->query() result (false on failure - checked by the caller) */
    private static function apply($wpdb, array $op, string $prefix)
    {
        switch ($op['kind']) {
            case 'option_set':
                if ($op['old'] === null) {
                    return $wpdb->query($wpdb->prepare(
                        "INSERT INTO " . $prefix . "options (option_name, option_value, autoload) VALUES (%s, %s, 'yes')",
                        $op['name'], $op['new']
                    ));
                }
                return $wpdb->query($wpdb->prepare(
                    "UPDATE " . $prefix . "options SET option_value = %s WHERE option_name = %s",
                    $op['new'], $op['name']
                ));
            case 'option_delete':
                return $wpdb->query($wpdb->prepare(
                    "DELETE FROM " . $prefix . "options WHERE option_name = %s",
                    $op['name']
                ));
            case 'postmeta_set':
                if ($op['old'] === null) {
                    return $wpdb->query($wpdb->prepare(
                        "INSERT INTO " . $prefix . "postmeta (post_id, meta_key, meta_value) VALUES (%d, %s, %s)",
                        $op['postId'], $op['key'], $op['new']
                    ));
                }
                // Same multi-row caveat as the read-set query above: LIMIT 1 keeps
                // this scoped to a single row.
                return $wpdb->query($wpdb->prepare(
                    "UPDATE " . $prefix . "postmeta SET meta_value = %s WHERE post_id = %d AND meta_key = %s LIMIT 1",
                    $op['new'], $op['postId'], $op['key']
                ));
            case 'postmeta_delete':
                return $wpdb->query($wpdb->prepare(
                    "DELETE FROM " . $prefix . "postmeta WHERE post_id = %d AND meta_key = %s LIMIT 1",
                    $op['postId'], $op['key']
                ));
            case 'row_update':
                $sets = [];
                $args = [];
                foreach ($op['new'] as $col => $val) {
                    // %s/%d render a PHP null as '' on WP < 6.2 (silent corruption on a
                    // nullable column) - emit SQL NULL directly instead, no placeholder.
                    if ($val === null) {
                        $sets[] = self::quote_ident($col) . ' = NULL';
                    } else {
                        $sets[] = self::quote_ident($col) . ' = %s';
                        $args[] = $val;
                    }
                }
                $args[] = (int) $op['pk'];
                $sql = "UPDATE " . self::quote_ident($op['table']) . " SET " . implode(', ', $sets)
                    . " WHERE " . self::quote_ident($op['pkCol']) . " = %d";
                return $wpdb->query($wpdb->prepare($sql, ...$args));
            case 'row_insert':
                $cols = [];
                $placeholders = [];
                $args = [];
                foreach ($op['new'] as $col => $val) {
                    $cols[] = self::quote_ident($col);
                    if ($val === null) {
                        $placeholders[] = 'NULL'; // same rationale as row_update above
                    } else {
                        $placeholders[] = '%s';
                        $args[] = $val;
                    }
                }
                $sql = "INSERT INTO " . self::quote_ident($op['table']) . " (" . implode(', ', $cols) . ") VALUES (" . implode(', ', $placeholders) . ")";
                return $wpdb->query($wpdb->prepare($sql, ...$args));
            case 'row_delete':
                $sql = "DELETE FROM " . self::quote_ident($op['table']) . " WHERE " . self::quote_ident($op['pkCol']) . " = %d";
                return $wpdb->query($wpdb->prepare($sql, (int) $op['pk']));
        }
    }
}
