<?php
require_once __DIR__ . '/helpers/FakeWpdb.php';

use Ferry\Nonces;
use PHPUnit\Framework\TestCase;

final class NonceTest extends TestCase
{
    protected function setUp(): void
    {
        $this->newRequest();
    }

    /** Clears Nonces' request-scoped consume memory, simulating a fresh HTTP request. */
    private function newRequest(): void
    {
        \Closure::bind(static function (): void { Nonces::$seen = []; }, null, Nonces::class)();
    }

    public function test_fresh_nonce_consumed_once(): void
    {
        $wpdb = new FakeWpdb();
        $n = str_repeat('ab', 16); // 32 hex chars
        $this->assertTrue(Nonces::consume($wpdb, 'wp_', $n, 1000));
        $this->newRequest();
        $this->assertFalse(Nonces::consume($wpdb, 'wp_', $n, 1010)); // replay from a later request
    }

    public function test_repeat_consume_within_one_request_is_not_replay(): void
    {
        // WP core re-invokes permission callbacks inside one request
        // (rest_send_allow_header on rest_post_dispatch) - that must not read as a replay.
        $wpdb = new FakeWpdb();
        $n = str_repeat('cd', 16);
        $this->assertTrue(Nonces::consume($wpdb, 'wp_', $n, 1000));
        $this->assertTrue(Nonces::consume($wpdb, 'wp_', $n, 1001));
        $this->assertCount(1, $wpdb->options);
    }

    public function test_duplicate_probe_never_prints_wpdb_errors(): void
    {
        // The duplicate-key INSERT is expected control flow: it must run under
        // suppress_errors so wpdb cannot print HTML into a REST response on WP_DEBUG sites.
        $wpdb = new FakeWpdb();
        $n = str_repeat('ef', 16);
        $this->assertTrue(Nonces::consume($wpdb, 'wp_', $n, 1000));
        $this->newRequest();
        $this->assertFalse(Nonces::consume($wpdb, 'wp_', $n, 1010));
        $this->assertSame([true, true], $wpdb->insert_suppress); // every probe ran suppressed
        $this->assertFalse($wpdb->suppress_errors);              // and the flag was restored
    }

    public function test_malformed_nonce_rejected(): void
    {
        $wpdb = new FakeWpdb();
        $this->assertFalse(Nonces::consume($wpdb, 'wp_', 'short', 1000));
        $this->assertFalse(Nonces::consume($wpdb, 'wp_', str_repeat('z', 32), 1000)); // non-hex
    }

    public function test_expired_nonces_pruned(): void
    {
        $wpdb = new FakeWpdb();
        $old = str_repeat('11', 16);
        $wpdb->options['ferry_nonce_' . $old] = ['option_value' => '1000'];
        $new = str_repeat('22', 16);
        $this->assertTrue(Nonces::consume($wpdb, 'wp_', $new, 1200)); // prune window 120s: 1200-120=1080 > 1000
        $this->assertArrayNotHasKey('ferry_nonce_' . $old, $wpdb->options);
    }
}
