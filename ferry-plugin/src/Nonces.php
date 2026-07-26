<?php
namespace Ferry;

/** §4.5 nonce check: replay protection for the write-capable plugin. Storage is one
 *  options row per nonce; the UNIQUE index on option_name makes consume atomic. */
final class Nonces
{
    const WINDOW = 120; // seconds kept; > 2x the 60s signature window

    public static function consume($wpdb, string $prefix, string $nonce, int $now): bool
    {
        if (!preg_match('/\A[0-9a-f]{32}\z/', $nonce)) {
            return false;
        }
        // prune first so the table cannot grow unboundedly
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$prefix}options WHERE option_name LIKE %s AND option_value < %d",
            'ferry_nonce_%', $now - self::WINDOW
        ));
        $inserted = $wpdb->insert("{$prefix}options", [
            'option_name'  => 'ferry_nonce_' . $nonce,
            'option_value' => (string) $now,
            'autoload'     => 'no',
        ]);
        return $inserted !== false; // false = duplicate key = replay
    }
}
