<?php
/*
Plugin Name: Ferry Demo Licensed
Description: E2E fixture - strict EDD-style licensed plugin. Any non-valid license answer (including network errors) flips status to invalid, so the harness stub is the only thing keeping it alive in the clone.
Version: 1.0.0
*/
if (!defined('ABSPATH')) { exit; }

define('FERRY_DEMO_STORE', home_url('/')); // the fake store mu-plugin answers on this same fixture site
define('FERRY_DEMO_ITEM', 'Ferry Demo Licensed');

require __DIR__ . '/EDD_SL_Plugin_Updater.php'; // genuine EDD client, vendored

add_action('admin_init', function () {
    new EDD_SL_Plugin_Updater(FERRY_DEMO_STORE, __FILE__, [
        'version'   => '1.0.0',
        'license'   => 'FERRY-E2E-KEY',
        'item_name' => FERRY_DEMO_ITEM,
        'author'    => 'ferry',
    ]);
    $response = wp_remote_post(FERRY_DEMO_STORE, [
        'timeout' => 10,
        'body'    => [
            'edd_action' => 'check_license',
            'license'    => 'FERRY-E2E-KEY',
            'item_name'  => FERRY_DEMO_ITEM,
            'url'        => home_url(),
        ],
    ]);
    $status = 'invalid';
    if (!is_wp_error($response)) {
        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (is_array($data) && isset($data['license']) && $data['license'] === 'valid') {
            $status = 'valid';
        }
    }
    update_option('ferry_demo_license_status', $status);
});

add_action('admin_notices', function () {
    $status = get_option('ferry_demo_license_status', 'unknown');
    if ($status === 'valid') {
        echo '<div class="notice notice-success"><p>Ferry Demo Licensed: license VALID - premium feature active.</p></div>';
    } else {
        echo '<div class="notice notice-error"><p>Ferry Demo Licensed: license ' . esc_html($status) . ' - premium feature DISABLED.</p></div>';
    }
});
