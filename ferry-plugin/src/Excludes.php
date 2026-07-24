<?php
namespace Ferry;

/**
 * §3.1: exclusions are survival, not optimization. Hardcoded by design -
 * a constant in the plugin, extended per release, never configuration in v0.
 */
final class Excludes
{
    const PREFIXES = [
        'wp-content/uploads/',            // §2.8: media falls back to production
        'wp-content/cache/',              // also covers cache/wp-rocket/
        'wp-content/updraft/',
        'wp-content/ai1wm-backups/',
        'wp-content/backups',             // "backups*/": any wp-content/backups... directory
        'wp-content/wp-rocket-config/',
        'wp-content/ewww/',
        'wp-content/upgrade/',
        'wp-content/upgrade-temp-backup/',
    ];

    const FILES = [
        'wp-config.php',                  // §4.4: never over the bridge, even on explicit request
        'wp-content/debug.log',           // retrievable via control plane later, not pulled
        'wp-content/mu-plugins/ferry-overlay.php',  // ferry's own overlay - production must never clobber the clone's copy
    ];

    const BASENAMES = ['error_log'];

    public static function excluded(string $relpath): bool
    {
        $relpath = ltrim(str_replace('\\', '/', $relpath), '/');
        if (in_array($relpath, self::FILES, true)) {
            return true;
        }
        if (in_array(basename($relpath), self::BASENAMES, true)) {
            return true;
        }
        foreach (self::PREFIXES as $prefix) {
            if (strpos($relpath, $prefix) === 0) {
                return true;
            }
        }
        return false;
    }
}
