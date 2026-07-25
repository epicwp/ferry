<?php
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../../ferry-cli/assets/ferry-stubs.php';

final class StubsTest extends TestCase
{
    public function test_edd_check_license_in_body_returns_valid(): void
    {
        $r = ferry_stub_response('https://some-edd-store.example/', ['body' => ['edd_action' => 'check_license', 'license' => 'k', 'item_name' => 'Thing']]);
        $this->assertSame(200, $r['response']['code']);
        $data = json_decode($r['body'], true);
        $this->assertTrue($data['success']);
        $this->assertSame('valid', $data['license']);
        $this->assertSame('Thing', $data['item_name']);
    }

    public function test_edd_action_in_query_string_matches(): void
    {
        $r = ferry_stub_response('https://store.example/?edd_action=activate_license&license=k', []);
        $this->assertNotNull($r);
        $this->assertSame('valid', json_decode($r['body'], true)['license']);
    }

    public function test_edd_string_body_is_parsed(): void
    {
        $r = ferry_stub_response('https://store.example/', ['body' => 'edd_action=check_license&license=k']);
        $this->assertNotNull($r);
    }

    public function test_edd_get_version_never_offers_an_update(): void
    {
        $r = ferry_stub_response('https://store.example/', ['body' => ['edd_action' => 'get_version', 'slug' => 'demo']]);
        $data = json_decode($r['body'], true);
        $this->assertSame('0.0.0', $data['new_version']);
        $this->assertSame('', $data['package']);
        $this->assertSame('demo', $data['slug']);
    }

    public function test_edd_deactivate_reports_deactivated(): void
    {
        $r = ferry_stub_response('https://store.example/', ['body' => ['edd_action' => 'deactivate_license']]);
        $this->assertSame('deactivated', json_decode($r['body'], true)['license']);
    }

    public function test_freemius_api_host_is_stubbed(): void
    {
        $ping = ferry_stub_response('https://api.freemius.com/v1/ping.json', []);
        $this->assertSame(200, $ping['response']['code']);
        $this->assertSame('pong', json_decode($ping['body'], true)['api']);
        $other = ferry_stub_response('https://api.freemius.com/v1/installs/1.json', []);
        $this->assertSame('{}', $other['body']);
    }

    public function test_woocommerce_helper_host_is_stubbed(): void
    {
        $subs = ferry_stub_response('https://api.woocommerce.com/wp-json/helper/1.0/subscriptions', []);
        $this->assertSame('[]', $subs['body']);
        $other = ferry_stub_response('https://woocommerce.com/wp-json/helper/1.0/update-check', []);
        $this->assertSame('{}', $other['body']);
    }

    public function test_woocommerce_extensions_categories_is_a_list(): void
    {
        // WC_Admin_Addons::get_sections() array_maps over this response - a {}
        // shape fatals WooCommerce's own Extensions admin page (found via E2E gate 2).
        $categories = ferry_stub_response('https://woocommerce.com/wp-json/wccom-extensions/1.0/categories?locale=en_US', []);
        $this->assertSame('[]', $categories['body']);
        $other = ferry_stub_response('https://woocommerce.com/wp-json/wccom-extensions/1.0/search?term=x', []);
        $this->assertSame('{}', $other['body']);
    }

    public function test_unrelated_hosts_are_not_stubbed(): void
    {
        $this->assertNull(ferry_stub_response('https://api.stripe.com/v1/charges', ['body' => ['amount' => 1]]));
        $this->assertNull(ferry_stub_response('https://example.com/', []));
        $this->assertNull(ferry_stub_response('https://notfreemius.com/x', []), 'suffix match must require the dot');
    }
}
