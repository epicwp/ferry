<?php
/**
 * Ferry license stubs - static asset, copied into wp-content/mu-plugins/ by the
 * CLI overlay. The harness interceptor (ferry-overlay.php) consults
 * ferry_stub_response() before blocking an outbound call. The DB snapshot already
 * carries production's license state; these stubs exist so revalidation pings
 * cannot flip it - responses are generic "still valid" shapes.
 * Runs on the clone's PHP, which mirrors production: classic syntax only.
 */

/** Merge URL query params and the request body (array or form-encoded string). */
function ferry_stub_request_params($url, $args)
{
    $params = [];
    $query = (string) parse_url($url, PHP_URL_QUERY);
    if ($query !== '') {
        parse_str($query, $params);
    }
    if (isset($args['body'])) {
        if (is_array($args['body'])) {
            $params = array_merge($params, $args['body']);
        } elseif (is_string($args['body'])) {
            parse_str($args['body'], $body_params);
            $params = array_merge($params, $body_params);
        }
    }
    return $params;
}

/** @return array WP_Http-shaped 200 response */
function ferry_stub_http_200($body)
{
    return [
        'headers'  => ['content-type' => 'application/json'],
        'body'     => is_string($body) ? $body : json_encode($body),
        'response' => ['code' => 200, 'message' => 'OK'],
        'cookies'  => [],
        'filename' => null,
    ];
}

function ferry_stub_edd($params)
{
    $action = $params['edd_action'];
    if ($action === 'get_version') {
        return ferry_stub_http_200([
            'new_version'    => '0.0.0', // never offer a phantom update in the clone
            'stable_version' => '0.0.0',
            'name'           => isset($params['item_name']) ? $params['item_name'] : '',
            'slug'           => isset($params['slug']) ? $params['slug'] : '',
            'url'            => '',
            'homepage'       => '',
            'package'        => '',
            'download_link'  => '',
            'sections'       => json_encode([]),
            'banners'        => json_encode([]),
            'last_updated'   => '',
            'requires'       => '',
            'tested'         => '',
        ]);
    }
    if ($action === 'deactivate_license') {
        return ferry_stub_http_200(['success' => true, 'license' => 'deactivated']);
    }
    // check_license / activate_license
    return ferry_stub_http_200([
        'success'          => true,
        'license'          => 'valid',
        'item_id'          => isset($params['item_id']) ? $params['item_id'] : 0,
        'item_name'        => isset($params['item_name']) ? $params['item_name'] : '',
        'expires'          => 'lifetime',
        'payment_id'       => 0,
        'customer_name'    => 'ferry',
        'customer_email'   => 'ferry@localhost',
        'license_limit'    => 0,
        'site_count'       => 1,
        'activations_left' => 'unlimited',
        'price_id'         => false,
    ]);
}

function ferry_stub_freemius($url)
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (strpos($path, '/ping') !== false) {
        return ferry_stub_http_200(['api' => 'pong', 'timestamp' => gmdate('Y-m-d H:i:s')]);
    }
    return ferry_stub_http_200(new stdClass()); // "{}": success-shaped, no 'error' key
}

function ferry_stub_woocommerce($url)
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (substr($path, -14) === '/subscriptions') {
        return ferry_stub_http_200('[]');
    }
    // WC_Admin_Addons::get_sections() array_maps over this response - must be a
    // list, not the generic {} shape, or WooCommerce's own Extensions page fatals.
    if (strpos($path, '/wccom-extensions/') !== false && substr($path, -11) === '/categories') {
        return ferry_stub_http_200('[]');
    }
    return ferry_stub_http_200(new stdClass());
}

/**
 * @param string $url outbound request URL
 * @param array  $args wp_remote_* args
 * @return array|null WP_Http-shaped response, or null to let the harness block
 */
function ferry_stub_response($url, $args)
{
    $params = ferry_stub_request_params($url, $args);
    if (isset($params['edd_action']) && in_array($params['edd_action'], ['check_license', 'activate_license', 'deactivate_license', 'get_version'], true)) {
        return ferry_stub_edd($params); // EDD is detected by request shape: every EDD store hosts its own API
    }
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    if ($host === 'api.freemius.com' || substr($host, -13) === '.freemius.com') {
        return ferry_stub_freemius($url);
    }
    if ($host === 'api.woocommerce.com' || $host === 'woocommerce.com') {
        return ferry_stub_woocommerce($url);
    }
    return null;
}
