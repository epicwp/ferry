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
                Auth::sign($data['secret'], $v['method'], $v['route'], $v['query'], $v['body'], $v['timestamp']),
                $v['name']
            );
        }
    }

    public function test_verify_accepts_fresh_valid_signature(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertTrue(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['timestamp'] + 59
        ));
    }

    public function test_verify_rejects_expired_timestamp(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['timestamp'] + 61
        ));
    }

    public function test_verify_rejects_bad_signature(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], str_repeat('0', 64), $v['timestamp']
        ));
    }

    public function test_verify_rejects_missing_headers(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            null, null, $v['timestamp']
        ));
    }

    public function test_verify_strips_rest_route_pollution(): void
    {
        $data = self::contract();
        $v = $data['vectors'][2];
        $polluted = array_merge($v['query'], ['rest_route' => '/ferry/v1/db']);
        $this->assertTrue(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $polluted, $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['timestamp']
        ));
    }
}
