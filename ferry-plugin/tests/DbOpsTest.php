<?php
require_once __DIR__ . '/helpers/FakeWpdb.php';

use Ferry\DbOps;
use PHPUnit\Framework\TestCase;

final class DbOpsTest extends TestCase
{
    // ---- validate() ----

    public function test_validate_refuses_content_table_row_op(): void
    {
        $result = DbOps::validate([
            ['kind' => 'row_update', 'table' => 'wp_posts', 'pkCol' => 'ID', 'pk' => 1, 'old' => ['post_title' => 'a'], 'new' => ['post_title' => 'b']],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'refused_table']], $result['refused']);
    }

    public function test_validate_refuses_unknown_kind(): void
    {
        $result = DbOps::validate([
            ['kind' => 'schema_migrate'],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'unknown_kind']], $result['refused']);
    }

    public function test_validate_accepts_option_set(): void
    {
        $op = ['kind' => 'option_set', 'name' => 'ferry_test', 'old' => 'a', 'new' => 'b'];
        $result = DbOps::validate([$op], 'wp_');

        $this->assertSame([$op], $result['ok']);
        $this->assertSame([], $result['refused']);
    }

    public function test_validate_refuses_woocommerce_pattern_table(): void
    {
        $result = DbOps::validate([
            ['kind' => 'row_insert', 'table' => 'wp_woocommerce_order_items', 'pkCol' => 'order_item_id', 'pk' => 1, 'new' => ['order_item_id' => 1]],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'refused_table']], $result['refused']);
    }

    public function test_validate_accepts_row_op_on_non_refused_table(): void
    {
        $op = ['kind' => 'row_update', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'old' => ['val' => '1'], 'new' => ['val' => '2']];
        $result = DbOps::validate([$op], 'wp_');

        $this->assertSame([$op], $result['ok']);
        $this->assertSame([], $result['refused']);
    }

    // ---- final-review fix 1: lowercase table matching + identifier hygiene ----

    public function test_validate_refuses_mixed_case_content_table(): void
    {
        $result = DbOps::validate([
            ['kind' => 'row_update', 'table' => 'WP_POSTS', 'pkCol' => 'ID', 'pk' => 1, 'old' => ['post_title' => 'a'], 'new' => ['post_title' => 'b']],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'refused_table']], $result['refused']);
    }

    public function test_validate_refuses_bad_table_identifier(): void
    {
        $result = DbOps::validate([
            ['kind' => 'row_update', 'table' => 'wp_settings; DROP TABLE wp_users', 'pkCol' => 'id', 'pk' => 5, 'old' => ['val' => '1'], 'new' => ['val' => '2']],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'bad_identifier']], $result['refused']);
    }

    public function test_validate_refuses_bad_pkcol_identifier(): void
    {
        $result = DbOps::validate([
            ['kind' => 'row_update', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id`; --', 'pk' => 5, 'old' => ['val' => '1'], 'new' => ['val' => '2']],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'bad_identifier']], $result['refused']);
    }

    public function test_validate_refuses_bad_column_identifier_in_new(): void
    {
        $result = DbOps::validate([
            ['kind' => 'row_update', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'old' => ['val' => '1'], 'new' => ['val`; --' => '2']],
        ], 'wp_');

        $this->assertSame([], $result['ok']);
        $this->assertSame([['index' => 0, 'reason' => 'bad_identifier']], $result['refused']);
    }

    // ---- apply_in_transaction() happy path ----

    public function test_happy_path_records_exact_sql_sequence_and_commits(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
        ];
        $preconditions = [
            ['type' => 'option', 'name' => 'ferry_b', 'expected' => '9'],
        ];
        // get_row is called once per read-set entry, in order: op target, then precondition.
        $wpdb = new FakeWpdb([
            ['option_value' => '1'], // ferry_a current value matches expected old
            ['option_value' => '9'], // ferry_b precondition matches
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, $preconditions, 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertSame([], $result['conflicts']);

        $this->assertSame('START TRANSACTION', $wpdb->queries[0]);
        $this->assertStringContainsString('FOR UPDATE', $wpdb->queries[1]);
        $this->assertStringContainsString('ferry_a', $wpdb->queries[1]);
        $this->assertStringContainsString('FOR UPDATE', $wpdb->queries[2]);
        $this->assertStringContainsString('ferry_b', $wpdb->queries[2]);
        $this->assertStringContainsString('UPDATE wp_options', $wpdb->queries[3]);
        $this->assertSame('COMMIT', $wpdb->queries[4]);
        $this->assertCount(5, $wpdb->queries);
    }

    public function test_commit_invalidates_option_and_postmeta_object_caches(): void
    {
        // Security skim item: raw-SQL writes bypass persistent object caches (Redis/
        // Memcached) - without invalidation the site and even the smoke check keep
        // seeing the stale cached value after a pushed option change.
        $GLOBALS['ferry_cache_deletes'] = [];
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
            ['kind' => 'postmeta_set', 'postId' => 7, 'key' => 'k', 'old' => 'x', 'new' => 'y'],
        ];
        $wpdb = new FakeWpdb([
            ['option_value' => '1'],
            ['meta_value' => 'x'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertContains(['ferry_a', 'options'], $GLOBALS['ferry_cache_deletes']);
        $this->assertContains(['alloptions', 'options'], $GLOBALS['ferry_cache_deletes']);
        $this->assertContains([7, 'post_meta'], $GLOBALS['ferry_cache_deletes']);
    }

    public function test_conflict_invalidates_no_caches(): void
    {
        $GLOBALS['ferry_cache_deletes'] = [];
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
        ];
        $wpdb = new FakeWpdb([
            ['option_value' => 'drifted'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([], $GLOBALS['ferry_cache_deletes']);
    }

    public function test_op_with_matching_precondition_reports_one_conflict_not_two(): void
    {
        // Live finding (Plan 5a acceptance): the op's old-value check and its matching
        // precondition produced two identical read-set entries, so one drifted option
        // reported the same conflict twice.
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => 'V1', 'new' => 'V2'],
        ];
        $preconditions = [
            ['type' => 'option', 'name' => 'ferry_a', 'expected' => 'V1'],
        ];
        $wpdb = new FakeWpdb([
            ['option_value' => 'drifted'], // one read for the single deduped entry
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, $preconditions, 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'option:ferry_a', 'expected' => 'V1', 'found' => 'drifted'],
        ], $result['conflicts']);
    }

    // ---- mismatch -> rollback, all conflicts reported ----

    public function test_mismatch_among_three_keys_rolls_back_and_reports_all_conflicts(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
            ['kind' => 'option_set', 'name' => 'ferry_b', 'old' => '5', 'new' => '6'],
            ['kind' => 'option_set', 'name' => 'ferry_c', 'old' => '7', 'new' => '8'],
        ];
        // ferry_a matches, ferry_b mismatches (found '99' not '5'), ferry_c matches.
        $wpdb = new FakeWpdb([
            ['option_value' => '1'],
            ['option_value' => '99'],
            ['option_value' => '7'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'option:ferry_b', 'expected' => '5', 'found' => '99'],
        ], $result['conflicts']);

        $this->assertSame('START TRANSACTION', $wpdb->queries[0]);
        $this->assertCount(5, $wpdb->queries); // START TRANSACTION + 3 SELECTs + ROLLBACK
        $this->assertSame('ROLLBACK', $wpdb->queries[4]);
        foreach ($wpdb->queries as $q) {
            $this->assertStringNotContainsStringIgnoringCase('UPDATE wp_options SET', $q);
        }
    }

    public function test_all_conflicts_reported_not_just_first(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
            ['kind' => 'option_set', 'name' => 'ferry_b', 'old' => '5', 'new' => '6'],
            ['kind' => 'option_set', 'name' => 'ferry_c', 'old' => '7', 'new' => '8'],
        ];
        // ferry_a and ferry_c both mismatch.
        $wpdb = new FakeWpdb([
            ['option_value' => '11'],
            ['option_value' => '5'],
            ['option_value' => '77'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'option:ferry_a', 'expected' => '1', 'found' => '11'],
            ['key' => 'option:ferry_c', 'expected' => '7', 'found' => '77'],
        ], $result['conflicts']);
    }

    // ---- force skips compares but still transactional ----

    public function test_force_skips_compare_but_still_locks_and_commits(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
        ];
        // Current value does NOT match "old" - would normally conflict.
        $wpdb = new FakeWpdb([
            ['option_value' => 'anything-else'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', true);

        $this->assertTrue($result['committed']);
        $this->assertSame([], $result['conflicts']);

        $this->assertSame('START TRANSACTION', $wpdb->queries[0]);
        $this->assertStringContainsString('FOR UPDATE', $wpdb->queries[1]); // still locked
        $this->assertStringContainsString('UPDATE wp_options', $wpdb->queries[2]);
        $this->assertSame('COMMIT', $wpdb->queries[3]);
    }

    // ---- option_set with old:null expects absence and INSERTs ----

    public function test_option_set_old_null_expects_absence_and_inserts(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_new', 'old' => null, 'new' => 'v1'],
        ];
        $wpdb = new FakeWpdb([
            null, // no existing row - matches "absent"
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertSame([], $result['conflicts']);
        $this->assertStringContainsString('INSERT INTO wp_options', $wpdb->queries[2]);
    }

    public function test_option_set_old_null_conflicts_when_row_already_exists(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_new', 'old' => null, 'new' => 'v1'],
        ];
        $wpdb = new FakeWpdb([
            ['option_value' => 'surprise'], // row exists after all
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'option:ferry_new', 'expected' => null, 'found' => 'surprise'],
        ], $result['conflicts']);
        $this->assertSame('ROLLBACK', $wpdb->queries[2]);
    }

    // ---- row_insert absent-row semantics + row_update whole-row compare ----

    public function test_row_insert_conflicts_when_pk_already_exists(): void
    {
        $ops = [
            ['kind' => 'row_insert', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'new' => ['id' => '5', 'val' => 'x']],
        ];
        $wpdb = new FakeWpdb([
            ['id' => '5', 'val' => 'already-there'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'row:wp_my_plugin_settings:id=5', 'expected' => null, 'found' => ['id' => '5', 'val' => 'already-there']],
        ], $result['conflicts']);
    }

    public function test_row_insert_happy_path_when_absent(): void
    {
        $ops = [
            ['kind' => 'row_insert', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'new' => ['id' => '5', 'val' => 'x']],
        ];
        $wpdb = new FakeWpdb([null]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertStringContainsString('INSERT INTO `wp_my_plugin_settings`', $wpdb->queries[2]);
    }

    public function test_row_update_whole_row_mismatch_reports_found_row(): void
    {
        $ops = [
            ['kind' => 'row_update', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'old' => ['id' => '5', 'val' => 'x'], 'new' => ['id' => '5', 'val' => 'y']],
        ];
        $wpdb = new FakeWpdb([
            ['id' => '5', 'val' => 'drifted'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'row:wp_my_plugin_settings:id=5', 'expected' => ['id' => '5', 'val' => 'x'], 'found' => ['id' => '5', 'val' => 'drifted']],
        ], $result['conflicts']);
    }

    public function test_row_update_happy_path_applies_update(): void
    {
        $ops = [
            ['kind' => 'row_update', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'old' => ['id' => '5', 'val' => 'x'], 'new' => ['id' => '5', 'val' => 'y']],
        ];
        $wpdb = new FakeWpdb([
            ['id' => '5', 'val' => 'x'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertStringContainsString('UPDATE `wp_my_plugin_settings`', $wpdb->queries[2]);
    }

    public function test_row_delete_happy_path(): void
    {
        $ops = [
            ['kind' => 'row_delete', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'old' => ['id' => '5', 'val' => 'x']],
        ];
        $wpdb = new FakeWpdb([
            ['id' => '5', 'val' => 'x'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertStringContainsString('DELETE FROM `wp_my_plugin_settings`', $wpdb->queries[2]);
    }

    // ---- postmeta ----

    public function test_postmeta_set_happy_path_updates_single_row(): void
    {
        $ops = [
            ['kind' => 'postmeta_set', 'postId' => 42, 'key' => '_price', 'old' => '10', 'new' => '20'],
        ];
        $wpdb = new FakeWpdb([
            ['meta_value' => '10'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertStringContainsString('post_id', $wpdb->queries[1]);
        $this->assertStringContainsString('_price', $wpdb->queries[1]);
        $this->assertStringContainsString('UPDATE wp_postmeta', $wpdb->queries[2]);
    }

    public function test_postmeta_delete_happy_path(): void
    {
        $ops = [
            ['kind' => 'postmeta_delete', 'postId' => 42, 'key' => '_price', 'old' => '10'],
        ];
        $wpdb = new FakeWpdb([
            ['meta_value' => '10'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $this->assertStringContainsString('DELETE FROM wp_postmeta', $wpdb->queries[2]);
    }

    // ---- read_set() shape ----

    public function test_read_set_skips_file_hash_preconditions(): void
    {
        $entries = DbOps::read_set([], [
            ['type' => 'file_hash', 'path' => 'wp-content/x.php', 'expected' => 'abc123'],
        ], 'wp_');

        $this->assertSame([], $entries);
    }

    public function test_read_set_row_precondition_single_column(): void
    {
        $entries = DbOps::read_set([], [
            ['type' => 'row', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'column' => 'val', 'expected' => 'x'],
        ], 'wp_');

        $this->assertCount(1, $entries);
        $this->assertSame('row:wp_my_plugin_settings:id=5:val', $entries[0]['key']);
        $this->assertSame('x', $entries[0]['expected']);
        $this->assertStringContainsString('FOR UPDATE', $entries[0]['sql']);
    }

    // ---- fix round 1: literal values must flow through $wpdb->prepare(), never hand-escaped ----

    public function test_read_set_option_name_is_a_placeholder_not_an_inline_literal(): void
    {
        // Multi-byte-bypass-shaped payload: a hand-rolled backslash-doubling escaper can be
        // defeated by charset-aware clients (GBK/Big5) that consume the escaping backslash as
        // half of a multi-byte lead byte, letting the trailing quote close the string early.
        $adversarial = "foo\xbf' OR '1'='1";

        $entries = DbOps::read_set([
            ['kind' => 'option_set', 'name' => $adversarial, 'old' => null, 'new' => 'v'],
        ], [], 'wp_');

        $this->assertCount(1, $entries);
        // The raw value must never be concatenated into the SQL text - only a placeholder.
        $this->assertStringNotContainsString($adversarial, $entries[0]['sql']);
        $this->assertStringContainsString('%s', $entries[0]['sql']);
        $this->assertSame([$adversarial], $entries[0]['args']);
    }

    public function test_read_set_postmeta_key_is_a_placeholder_not_an_inline_literal(): void
    {
        $adversarial = "k\xbf'; DROP TABLE wp_postmeta; --";

        $entries = DbOps::read_set([
            ['kind' => 'postmeta_set', 'postId' => 1, 'key' => $adversarial, 'old' => null, 'new' => 'v'],
        ], [], 'wp_');

        $this->assertStringNotContainsString($adversarial, $entries[0]['sql']);
        $this->assertSame([1, $adversarial], $entries[0]['args']);
    }

    // ---- fix round 1: a failing apply statement must roll back, not commit a partial write ----

    public function test_apply_failure_rolls_back_and_reports_failure_without_committing(): void
    {
        $ops = [
            ['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2'],
            ['kind' => 'option_set', 'name' => 'ferry_b', 'old' => '5', 'new' => '6'],
            ['kind' => 'option_set', 'name' => 'ferry_c', 'old' => '7', 'new' => '8'],
        ];
        $wpdb = new FakeWpdb([
            ['option_value' => '1'],
            ['option_value' => '5'],
            ['option_value' => '7'],
        ]);
        // query() call order: 0=START TRANSACTION, 1=ferry_a UPDATE (ok), 2=ferry_b UPDATE (fails).
        $wpdb->fail_query_at_call = 2;

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertFalse($result['committed']);
        $this->assertSame([], $result['conflicts']);
        $this->assertSame(['key' => 'option:ferry_b', 'detail' => 'option_set apply failed'], $result['apply_error']);

        // ferry_a applied, ferry_b was attempted (and its query() call was scripted to
        // fail), ferry_c's UPDATE must never have been attempted at all - the apply loop
        // stops immediately. (ferry_c's read-set SELECT still ran: all locks are taken
        // upfront, per spec §9, before any apply.)
        $updates = array_values(array_filter($wpdb->queries, function ($q) {
            return strpos($q, 'UPDATE wp_options SET') === 0;
        }));
        $this->assertCount(2, $updates);
        $this->assertStringContainsString('ferry_a', $updates[0]);
        $this->assertStringContainsString('ferry_b', $updates[1]);
        $this->assertNotContains('COMMIT', $wpdb->queries);
        $this->assertSame('ROLLBACK', end($wpdb->queries));
    }

    // ---- fix round 1: null in a row op's `new` must render as SQL NULL, not '' ----

    public function test_row_update_null_value_renders_as_sql_null(): void
    {
        $ops = [
            ['kind' => 'row_update', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'old' => ['id' => '5', 'val' => 'x'], 'new' => ['id' => '5', 'val' => null]],
        ];
        $wpdb = new FakeWpdb([
            ['id' => '5', 'val' => 'x'],
        ]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $applySql = $wpdb->queries[2];
        $this->assertStringContainsString('`val` = NULL', $applySql);
        $this->assertStringNotContainsString("`val` = ''", $applySql);
    }

    public function test_row_insert_null_value_renders_as_sql_null(): void
    {
        $ops = [
            ['kind' => 'row_insert', 'table' => 'wp_my_plugin_settings', 'pkCol' => 'id', 'pk' => 5, 'new' => ['id' => '5', 'val' => null]],
        ];
        $wpdb = new FakeWpdb([null]);

        $result = DbOps::apply_in_transaction($wpdb, $ops, [], 'wp_', false);

        $this->assertTrue($result['committed']);
        $applySql = $wpdb->queries[2];
        $this->assertStringContainsString('VALUES', $applySql);
        $this->assertMatchesRegularExpression('/,\s*NULL\)|,\s*NULL,/', $applySql);
    }
}
