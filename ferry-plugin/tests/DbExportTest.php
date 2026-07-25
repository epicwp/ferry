<?php
use Ferry\Budget;
use Ferry\Db;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/helpers/FakeWpdb.php';

final class DbExportTest extends TestCase
{
    private const COLUMNS = [
        ['Field' => 'ID', 'Type' => 'bigint(20) unsigned'],
        ['Field' => 'title', 'Type' => 'text'],
    ];
    private const CREATE = ['wp_posts', "CREATE TABLE `wp_posts` (\n  `ID` bigint(20)\n)"];

    public function test_keyset_export_runs_to_completion(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,                                                        // SHOW COLUMNS
            self::CREATE,                                                         // SHOW CREATE TABLE
            [['ID' => '1', 'title' => 'Hello'], ['ID' => '2', 'title' => 'World']], // chunk 1 (full)
            [['ID' => '3', 'title' => 'Bye']],                                    // chunk 2 (short -> done)
        ]);
        $r = Db::export($wpdb, 'wp_posts', 'ID', 0, 3, new Budget(10.0), 2);
        $this->assertStringContainsString('DROP TABLE IF EXISTS `wp_posts`;', $r['sql']);
        $this->assertStringContainsString('CREATE TABLE `wp_posts`', $r['sql']);
        $this->assertStringContainsString("INSERT INTO `wp_posts` VALUES\n(1,0x48656c6c6f),\n(2,0x576f726c64);", $r['sql']);
        $this->assertStringContainsString('(3,0x427965);', $r['sql']);
        $this->assertSame(3, $r['last_key']);
        $this->assertTrue($r['complete']);
        $this->assertStringContainsString('WHERE `ID` > 0 AND `ID` <= 3', $wpdb->queries[2]);
    }

    public function test_byte_budget_stops_batch_early(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,
            self::CREATE,
            [['ID' => '1', 'title' => 'Hello'], ['ID' => '2', 'title' => 'World']],
        ]);
        // budget of 100 bytes: the schema prefix (~80) fits, schema + first chunk does not
        $r = Db::export($wpdb, 'wp_posts', 'ID', 0, null, new Budget(10.0), 2, 100);
        $this->assertFalse($r['complete']);
        $this->assertSame(2, $r['last_key'], 'resume cursor points at last emitted row');
    }

    public function test_resumed_batch_has_no_schema_prefix(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,
            [],           // empty chunk -> immediately complete
        ]);
        $r = Db::export($wpdb, 'wp_posts', 'ID', 5, null, new Budget(10.0), 2);
        $this->assertStringNotContainsString('DROP TABLE', $r['sql']);
        $this->assertTrue($r['complete']);
        $this->assertSame(5, $r['last_key']);
    }

    public function test_offset_fallback_without_usable_pk(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,
            self::CREATE,
            [['ID' => '9', 'title' => 'a'], ['ID' => '8', 'title' => 'b']],
            [['ID' => '7', 'title' => 'c']],
        ]);
        $r = Db::export($wpdb, 'wp_posts', null, 0, null, new Budget(10.0), 2);
        $this->assertSame(3, $r['last_key'], 'offset cursor advances by row count');
        $this->assertTrue($r['complete']);
        $this->assertStringContainsString('OFFSET 0', $wpdb->queries[2]);
        $this->assertStringContainsString('OFFSET 2', $wpdb->queries[3]);
    }
}
