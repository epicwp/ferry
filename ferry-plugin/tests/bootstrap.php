<?php
// WP array-output constants, needed by classes unit-tested without WordPress.
if (!defined('ARRAY_A')) { define('ARRAY_A', 'ARRAY_A'); }
if (!defined('ARRAY_N')) { define('ARRAY_N', 'ARRAY_N'); }

spl_autoload_register(function ($class) {
    if (strpos($class, 'Ferry\\') === 0) {
        $path = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, 6)) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});
