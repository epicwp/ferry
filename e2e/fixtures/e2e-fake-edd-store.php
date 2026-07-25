<?php
/* E2E fixture: answers EDD license API calls so the production fixture has a real,
   reachable licensing "store". Never needed in the clone - the harness stub answers there. */
add_action('init', function () {
    if (!isset($_REQUEST['edd_action'])) { return; }
    wp_send_json([
        'success'          => true,
        'license'          => 'valid',
        'item_name'        => isset($_REQUEST['item_name']) ? sanitize_text_field(wp_unslash($_REQUEST['item_name'])) : '',
        'expires'          => 'lifetime',
        'activations_left' => 'unlimited',
    ]);
});
