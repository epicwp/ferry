<?php
use Ferry\Db;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/helpers/FakeWpdb.php';

final class DbTablesTest extends TestCase
{
    public function test_single_pk_returns_integer_primary_key_column(): void
    {
        $wpdb = new FakeWpdb([
            [['Column_name' => 'ID']],                              // SHOW KEYS ... PRIMARY
            ['Field' => 'ID', 'Type' => 'bigint(20) unsigned'],     // SHOW COLUMNS ... LIKE
        ]);
        $this->assertSame('ID', Db::single_pk($wpdb, 'wp_posts'));
    }

    public function test_single_pk_rejects_composite_primary_key(): void
    {
        $wpdb = new FakeWpdb([
            [['Column_name' => 'a'], ['Column_name' => 'b']],       // two PRIMARY key parts
        ]);
        $this->assertNull(Db::single_pk($wpdb, 'wp_composite'));
    }

    public function test_single_pk_rejects_non_integer_primary_key(): void
    {
        $wpdb = new FakeWpdb([
            [['Column_name' => 'uuid']],
            ['Field' => 'uuid', 'Type' => 'varchar(36)'],
        ]);
        $this->assertNull(Db::single_pk($wpdb, 'wp_uuid'));
    }

    public function test_tables_snapshots_maxpk_for_keyset_tables_only(): void
    {
        $wpdb = new FakeWpdb([
            [
                ['Name' => 'wp_posts', 'Rows' => '42', 'Data_length' => '1000', 'Index_length' => '200'],
                ['Name' => 'wp_nopk', 'Rows' => '3', 'Data_length' => '100', 'Index_length' => '0'],
            ],                                                       // SHOW TABLE STATUS
            [['Column_name' => 'ID']],                               // single_pk(wp_posts): SHOW KEYS
            ['Field' => 'ID', 'Type' => 'bigint(20) unsigned'],      // single_pk(wp_posts): SHOW COLUMNS
            '4210',                                                  // SELECT MAX(`ID`)
            [],                                                      // single_pk(wp_nopk): SHOW KEYS -> none
        ]);
        $tables = Db::tables($wpdb);
        $this->assertSame(
            ['name' => 'wp_posts', 'rows' => 42, 'bytes' => 1200, 'pk' => 'ID', 'maxpk' => 4210],
            $tables[0]
        );
        $this->assertSame(
            ['name' => 'wp_nopk', 'rows' => 3, 'bytes' => 100, 'pk' => null, 'maxpk' => null],
            $tables[1]
        );
    }
}
