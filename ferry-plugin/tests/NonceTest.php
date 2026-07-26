<?php
use Ferry\Nonces;
use PHPUnit\Framework\TestCase;

final class NonceTest extends TestCase
{
    public function test_fresh_nonce_consumed_once(): void
    {
        $wpdb = new FakeWpdb();
        $n = str_repeat('ab', 16); // 32 hex chars
        $this->assertTrue(Nonces::consume($wpdb, 'wp_', $n, 1000));
        $this->assertFalse(Nonces::consume($wpdb, 'wp_', $n, 1010)); // replay
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
