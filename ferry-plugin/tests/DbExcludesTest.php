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
