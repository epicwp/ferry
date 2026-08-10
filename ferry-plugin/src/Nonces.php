<?php
namespace Ferry;

/** §4.5 nonce check: replay protection for the write-capable plugin. Storage is one
 *  options row per nonce; the UNIQUE index on option_name makes consume atomic. */
final class Nonces
{
    const WINDOW = 120; // seconds kept; > 2x the 60s signature window

    /** @var array<string, true> nonces this request already consumed: WP core re-invokes
     *  permission callbacks within a single request (rest_send_allow_header on
     *  rest_post_dispatch), which must not read as a replay. PHP statics are
     *  request-scoped under FPM/mod_php, so this cannot leak across requests. */
    private static $seen = [];

    public static function consume($wpdb, string $prefix, string $nonce, int $now): bool
    {
        if (!preg_match('/\A[0-9a-f]{32}\z/', $nonce)) {
            return false;
        }
        if (isset(self::$seen[$nonce])) {
            return true;
        }
        // prune first so the table cannot grow unboundedly
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$prefix}options WHERE option_name LIKE %s AND option_value < %d",
            'ferry_nonce_%', $now - self::WINDOW
        ));
        // duplicate key = replay, an expected outcome: probe under suppress_errors so
        // wpdb cannot print HTML into the REST response body on WP_DEBUG sites
        $prev = $wpdb->suppress_errors(true);
        $inserted = $wpdb->insert("{$prefix}options", [
            'option_name'  => 'ferry_nonce_' . $nonce,
            'option_value' => (string) $now,
            'autoload'     => 'no',
        ]);
        $wpdb->suppress_errors($prev);
        if ($inserted === false) {
            return false; // duplicate key = replay
        }
        self::$seen[$nonce] = true;
        return true;
    }
}
