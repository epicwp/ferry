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

// Array-backed WP option stubs for classes unit-tested without WordPress (Auth pairing).
// Tests reset $GLOBALS['ferry_options'] in setUp().
$GLOBALS['ferry_options'] = [];
function get_option($name, $default = false) {
    return array_key_exists($name, $GLOBALS['ferry_options']) ? $GLOBALS['ferry_options'][$name] : $default;
}
function update_option($name, $value, $autoload = null) {
    $GLOBALS['ferry_options'][$name] = $value;
    return true;
}
function delete_option($name) {
    unset($GLOBALS['ferry_options'][$name]);
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
