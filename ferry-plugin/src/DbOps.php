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
            if (in_array($kind, self::ROW_KINDS, true) && self::table_refused(isset($op['table']) ? (string) $op['table'] : '', $prefix)) {
                $refused[] = ['index' => $index, 'reason' => 'refused_table'];
                continue;
            }
            if (!self::shape_ok($kind, $op)) {
                $refused[] = ['index' => $index, 'reason' => 'bad_shape'];
                continue;
            }
            $ok[] = $op;
        }
        return ['ok' => $ok, 'refused' => $refused];
    }

    private static function table_refused(string $table, string $prefix): bool
    {
        $bare = (strpos($table, $prefix) === 0) ? substr($table, strlen($prefix)) : $table;
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
     * No $wpdb here by design: entries carry ready-to-run SQL text, built with
     * manual literal/identifier quoting (see `esc`/`quote_ident`) rather than
     * `$wpdb->prepare()`, since this method has no wpdb to call it on.
     *
     * Each entry also carries an internal `whole` flag (beyond the documented
     * {sql,key,expected} shape) used only by `apply_in_transaction` to know
     * whether the query selects one column (extract the scalar) or a full row
     * via `SELECT *` (compare column-by-column) - see `apply_in_transaction`.
     *
     * @return array{sql:string,key:string,expected:mixed,whole:bool}[]
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
                $name = (string) $pre['name'];
                $entries[] = [
                    'sql' => "SELECT option_value FROM " . $prefix . "options WHERE option_name = " . self::esc($name) . " LIMIT 1 FOR UPDATE",
                    'key' => 'option:' . $name,
                    'expected' => $pre['expected'],
                    'whole' => false,
                ];
            } elseif ($type === 'row') {
                $table = (string) $pre['table'];
                $pkCol = (string) $pre['pkCol'];
                $pk = (int) $pre['pk'];
                $col = (string) $pre['column'];
                $entries[] = [
                    'sql' => "SELECT " . self::quote_ident($col) . " FROM " . self::quote_ident($table)
                        . " WHERE " . self::quote_ident($pkCol) . " = {$pk} LIMIT 1 FOR UPDATE",
                    'key' => "row:{$table}:{$pkCol}={$pk}:{$col}",
                    'expected' => $pre['expected'],
                    'whole' => false,
                ];
            }
            // 'file_hash' intentionally not handled here.
        }
        return $entries;
    }

    private static function op_entry(array $op, string $prefix): array
    {
        switch ($op['kind']) {
            case 'option_set':
            case 'option_delete':
                $name = (string) $op['name'];
                return [
                    'sql' => "SELECT option_value FROM " . $prefix . "options WHERE option_name = " . self::esc($name) . " LIMIT 1 FOR UPDATE",
                    'key' => 'option:' . $name,
                    'expected' => $op['old'],
                    'whole' => false,
                ];
            case 'postmeta_set':
            case 'postmeta_delete':
                $postId = (int) $op['postId'];
                $key = (string) $op['key'];
                // A (post_id, meta_key) pair is not unique in wp_postmeta - multiple rows
                // can share it. This targets a single row (LIMIT 1); which row is undefined
                // without an ORDER BY. Matches the op's own semantics: it operates on one row.
                return [
                    'sql' => "SELECT meta_value FROM " . $prefix . "postmeta WHERE post_id = {$postId} AND meta_key = " . self::esc($key) . " LIMIT 1 FOR UPDATE",
                    'key' => "postmeta:{$postId}:{$key}",
                    'expected' => $op['old'],
                    'whole' => false,
                ];
            default: // row_update / row_insert / row_delete
                $table = (string) $op['table'];
                $pkCol = (string) $op['pkCol'];
                $pk = (int) $op['pk'];
                return [
                    'sql' => "SELECT * FROM " . self::quote_ident($table) . " WHERE " . self::quote_ident($pkCol) . " = {$pk} FOR UPDATE",
                    'key' => "row:{$table}:{$pkCol}={$pk}",
                    'expected' => $op['kind'] === 'row_insert' ? null : $op['old'], // absent-row semantics: row_insert must find nothing
                    'whole' => true,
                ];
        }
    }

    /** MySQL string literal, manually escaped (no $wpdb available in read_set - see class doc). */
    private static function esc(string $value): string
    {
        return "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $value) . "'";
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
     * each op, COMMIT.
     *
     * @return array{committed:bool, conflicts: array{key:string,expected:mixed,found:mixed}[]}
     */
    public static function apply_in_transaction($wpdb, array $ops, array $preconditions, string $prefix, bool $force): array
    {
        $entries = self::read_set($ops, $preconditions, $prefix);

        $wpdb->query('START TRANSACTION');

        $conflicts = [];
        foreach ($entries as $entry) {
            $row = $wpdb->get_row($entry['sql'], ARRAY_A);
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
            self::apply($wpdb, $op, $prefix);
        }

        $wpdb->query('COMMIT');
        return ['committed' => true, 'conflicts' => []];
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

    private static function apply($wpdb, array $op, string $prefix): void
    {
        switch ($op['kind']) {
            case 'option_set':
                if ($op['old'] === null) {
                    $wpdb->query($wpdb->prepare(
                        "INSERT INTO " . $prefix . "options (option_name, option_value, autoload) VALUES (%s, %s, 'yes')",
                        $op['name'], $op['new']
                    ));
                } else {
                    $wpdb->query($wpdb->prepare(
                        "UPDATE " . $prefix . "options SET option_value = %s WHERE option_name = %s",
                        $op['new'], $op['name']
                    ));
                }
                return;
            case 'option_delete':
                $wpdb->query($wpdb->prepare(
                    "DELETE FROM " . $prefix . "options WHERE option_name = %s",
                    $op['name']
                ));
                return;
            case 'postmeta_set':
                if ($op['old'] === null) {
                    $wpdb->query($wpdb->prepare(
                        "INSERT INTO " . $prefix . "postmeta (post_id, meta_key, meta_value) VALUES (%d, %s, %s)",
                        $op['postId'], $op['key'], $op['new']
                    ));
                } else {
                    // Same multi-row caveat as the read-set query above: LIMIT 1 keeps
                    // this scoped to a single row.
                    $wpdb->query($wpdb->prepare(
                        "UPDATE " . $prefix . "postmeta SET meta_value = %s WHERE post_id = %d AND meta_key = %s LIMIT 1",
                        $op['new'], $op['postId'], $op['key']
                    ));
                }
                return;
            case 'postmeta_delete':
                $wpdb->query($wpdb->prepare(
                    "DELETE FROM " . $prefix . "postmeta WHERE post_id = %d AND meta_key = %s LIMIT 1",
                    $op['postId'], $op['key']
                ));
                return;
            case 'row_update':
                $sets = [];
                $args = [];
                foreach ($op['new'] as $col => $val) {
                    $sets[] = self::quote_ident($col) . ' = %s';
                    $args[] = $val;
                }
                $args[] = (int) $op['pk'];
                $sql = "UPDATE " . self::quote_ident($op['table']) . " SET " . implode(', ', $sets)
                    . " WHERE " . self::quote_ident($op['pkCol']) . " = %d";
                $wpdb->query($wpdb->prepare($sql, ...$args));
                return;
            case 'row_insert':
                $cols = [];
                $placeholders = [];
                $args = [];
                foreach ($op['new'] as $col => $val) {
                    $cols[] = self::quote_ident($col);
                    $placeholders[] = '%s';
                    $args[] = $val;
                }
                $sql = "INSERT INTO " . self::quote_ident($op['table']) . " (" . implode(', ', $cols) . ") VALUES (" . implode(', ', $placeholders) . ")";
                $wpdb->query($wpdb->prepare($sql, ...$args));
                return;
            case 'row_delete':
                $sql = "DELETE FROM " . self::quote_ident($op['table']) . " WHERE " . self::quote_ident($op['pkCol']) . " = %d";
                $wpdb->query($wpdb->prepare($sql, (int) $op['pk']));
                return;
        }
    }
}
