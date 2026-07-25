<?php
namespace Ferry;

/**
 * Database export (§3.5): keyset pagination, byte budget, hex literals.
 * The literal encoder is pure and column-type-driven: hexing a numeric
 * column would corrupt it (0x31 = 49 in numeric context), and trusting
 * value shape would corrupt leading-zero varchars. Type decides, not value.
 */
final class Db
{
    /** @param array<int, array{Field: string, Type: string}> $show_columns_rows
     *  @return array<string, bool> */
    public static function numeric_map(array $show_columns_rows): array
    {
        $map = [];
        foreach ($show_columns_rows as $col) {
            $map[$col['Field']] = (bool) preg_match('/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/i', $col['Type']);
        }
        return $map;
    }

    /** @param string|null $value wpdb returns all values as strings or null */
    public static function literal($value, bool $numeric): string
    {
        if ($value === null) {
            return 'NULL';
        }
        $value = (string) $value;
        if ($numeric && preg_match('/\A-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?\z/', $value)) {
            return $value;
        }
        if ($value === '') {
            return "''";
        }
        return '0x' . bin2hex($value);
    }

    const CHUNK_ROWS = 50;                  // memory guard: rows can be MBs each (§3.5)
    const BYTE_BUDGET = 4194304;            // ~4MB output per batch (§3.5)

    /** @param \wpdb|\FakeWpdb $wpdb */
    public static function tables($wpdb): array
    {
        $tables = [];
        foreach ($wpdb->get_results('SHOW TABLE STATUS', ARRAY_A) as $t) {
            $name = $t['Name'];
            $pk = self::single_pk($wpdb, $name);
            $tables[] = [
                'name'  => $name,
                'rows'  => (int) $t['Rows'],   // approximate for InnoDB; informational only
                'bytes' => (int) $t['Data_length'] + (int) $t['Index_length'],
                'pk'    => $pk,
                'maxpk' => $pk !== null ? (int) $wpdb->get_var("SELECT MAX(`$pk`) FROM `$name`") : null,
            ];
        }
        return $tables;
    }

    /** Single-column integer primary key, or null (-> OFFSET fallback, §3.5). */
    public static function single_pk($wpdb, string $table)
    {
        $keys = $wpdb->get_results($wpdb->prepare('SHOW KEYS FROM %i WHERE Key_name = %s', $table, 'PRIMARY'), ARRAY_A);
        if (!is_array($keys) || count($keys) !== 1) {
            return null;
        }
        $col = $keys[0]['Column_name'];
        $type = $wpdb->get_row($wpdb->prepare('SHOW COLUMNS FROM %i LIKE %s', $table, $col), ARRAY_A);
        return (is_array($type) && stripos($type['Type'], 'int') !== false) ? $col : null;
    }

    /**
     * @return array{sql: string, last_key: int, complete: bool}
     */
    public static function export($wpdb, string $table, $pk, int $after, $before, Budget $budget, int $chunk_rows = self::CHUNK_ROWS, int $byte_budget = self::BYTE_BUDGET): array
    {
        $numeric = self::numeric_map($wpdb->get_results("SHOW COLUMNS FROM `$table`", ARRAY_A));
        $out = '';
        if ($after === 0) {
            $create = $wpdb->get_row("SHOW CREATE TABLE `$table`", ARRAY_N);
            $out .= "DROP TABLE IF EXISTS `$table`;\n" . $create[1] . ";\n";
        }
        $last = $after;
        $complete = false;
        while (strlen($out) < $byte_budget && !$budget->exhausted()) {
            $rows = self::fetch_chunk($wpdb, $table, $pk, $last, $before, $chunk_rows);
            if ($rows === []) {
                $complete = true;
                break;
            }
            $tuples = [];
            foreach ($rows as $row) {
                $vals = [];
                foreach ($row as $col => $value) {
                    $vals[] = self::literal($value, isset($numeric[$col]) ? $numeric[$col] : false);
                }
                $tuples[] = '(' . implode(',', $vals) . ')';
            }
            $out .= "INSERT INTO `$table` VALUES\n" . implode(",\n", $tuples) . ";\n";
            $last_row = $rows[count($rows) - 1];
            $last = $pk !== null ? (int) $last_row[$pk] : $last + count($rows);
            if (count($rows) < $chunk_rows) {
                $complete = true;
                break;
            }
        }
        return ['sql' => $out, 'last_key' => $last, 'complete' => $complete];
    }

    private static function fetch_chunk($wpdb, string $table, $pk, int $after, $before, int $chunk_rows): array
    {
        if ($pk !== null) {
            $sql = "SELECT * FROM `$table` WHERE `$pk` > %d" . ($before !== null ? " AND `$pk` <= %d" : '') . " ORDER BY `$pk` LIMIT %d";
            $args = $before !== null ? [$after, $before, $chunk_rows] : [$after, $chunk_rows];
            return $wpdb->get_results($wpdb->prepare($sql, ...$args), ARRAY_A);
        }
        // No usable pk: OFFSET fallback (§3.5). Without a key there is nothing
        // stable to ORDER BY; row order across chunks is best-effort and can
        // skip/duplicate under concurrent writes. Accepted for v0: these are
        // rare, small plugin tables, and the export's consistency posture is
        // already best-effort (base doc §3.5).
        return $wpdb->get_results($wpdb->prepare("SELECT * FROM `$table` LIMIT %d OFFSET %d", $chunk_rows, $after), ARRAY_A);
    }
}
