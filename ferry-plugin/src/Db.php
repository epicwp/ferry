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
}
