<?php
/**
 * Plugin Name: Ferry Connect
 * Description: Read-only transport layer for ferry - manifest, file batches, and database export over signed REST requests. No command execution, no write endpoints.
 * Version: 0.1.0
 * Requires PHP: 7.2
 * Author: Ferry
 */

if (!defined('ABSPATH')) {
    exit;
}

spl_autoload_register(function ($class) {
    if (strpos($class, 'Ferry\\') === 0) {
        $path = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, 6)) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});

register_activation_hook(__FILE__, function () {
    if (!get_option('ferry_secret')) {
        Ferry\Auth::issue_pairing_code();
    }
});

add_action('rest_api_init', ['Ferry\\Routes', 'register']);

add_action('admin_notices', function () {
    if (!current_user_can('manage_options')) {
        return;
    }
    $pairing = Ferry\Auth::current_pairing_code();
    if ($pairing === null) {
        return;
    }
    printf(
        '<div class="notice notice-info"><p><strong>Ferry pairing code:</strong> <code>%s</code> &mdash; expires in %d min. Paste it into your ferry client: <code>ferry link %s --code=%s</code></p></div>',
        esc_html($pairing['code']),
        max(1, (int) ceil(($pairing['expires'] - time()) / 60)),
        esc_html(get_option('siteurl')),
        esc_html($pairing['code'])
    );
});

if (defined('WP_CLI') && WP_CLI) {
    WP_CLI::add_command('ferry pair', function () {
        $pairing = Ferry\Auth::issue_pairing_code();
        WP_CLI::line('Pairing code: ' . $pairing['code'] . ' (expires in 10:00)');
    });
}
