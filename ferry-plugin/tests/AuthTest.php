<?php
use Ferry\Auth;
use PHPUnit\Framework\TestCase;

final class AuthTest extends TestCase
{
    private static function contract(): array
    {
        return json_decode(
            file_get_contents(__DIR__ . '/../../contracts/hmac-vectors.json'),
            true
        );
    }

    public function test_sign_matches_all_vectors(): void
    {
        $data = self::contract();
        foreach ($data['vectors'] as $v) {
            $this->assertSame(
                $v['expected'],
                Auth::sign($data['secret'], $v['method'], $v['route'], $v['query'], $v['body'], $v['timestamp'], $v['nonce']),
                $v['name']
            );
        }
    }

    public function test_canonical_appends_nonce_as_sixth_line(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $canonical = Auth::canonical($v['method'], $v['route'], $v['query'], $v['body'], $v['timestamp'], $v['nonce']);
        $this->assertStringEndsWith("\n" . $v['nonce'], $canonical);
    }

    public function test_verify_accepts_fresh_valid_signature(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertTrue(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['nonce'], $v['timestamp'] + 59
        ));
    }

    public function test_verify_rejects_expired_timestamp(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['nonce'], $v['timestamp'] + 61
        ));
    }

    public function test_verify_rejects_bad_signature(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], str_repeat('0', 64), $v['nonce'], $v['timestamp']
        ));
    }

    public function test_verify_rejects_missing_headers(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            null, null, $v['nonce'], $v['timestamp']
        ));
    }

    public function test_verify_rejects_missing_nonce(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], null, $v['timestamp']
        ));
    }

    public function test_verify_strips_rest_route_pollution(): void
    {
        $data = self::contract();
        $v = $data['vectors'][2];
        $polluted = array_merge($v['query'], ['rest_route' => '/ferry/v1/db']);
        $this->assertTrue(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $polluted, $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['nonce'], $v['timestamp']
        ));
    }

    /** Cross-parity vector: Task 3 (CLI) asserts the identical hex signature for these same inputs. */
    public function test_cross_parity_vector(): void
    {
        $sig = Auth::sign('s3cret', 'POST', '/ferry/v1/commit', ['a' => 'b'], '{"x":1}', 1753500000, 'aabbccddeeff00112233445566778899');
        $this->assertSame('6727de63de27fc264a3fa94e0541012e32271c739d1d74f1dde3969c8a57575c', $sig);
    }
}
