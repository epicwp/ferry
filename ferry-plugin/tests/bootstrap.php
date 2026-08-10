<?php
// WP array-output constants, needed by classes unit-tested without WordPress.
if (!defined('ARRAY_A')) { define('ARRAY_A', 'ARRAY_A'); }
if (!defined('ARRAY_N')) { define('ARRAY_N', 'ARRAY_N'); }

// Recording stub for WP's object-cache invalidation (always defined inside WordPress);
// DbOps calls it after COMMIT. Tests reset and inspect $GLOBALS['ferry_cache_deletes'].
$GLOBALS['ferry_cache_deletes'] = [];
function wp_cache_delete($key, $group = '') {
    $GLOBALS['ferry_cache_deletes'][] = [$key, $group];
    return true;
}

spl_autoload_register(function ($class) {
    if (strpos($class, 'Ferry\\') === 0) {
        $path = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, 6)) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});
