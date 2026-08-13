<?php
namespace Ferry;

final class Auth
{
    const CODE_TTL = 600;          // pairing code lifetime, seconds (device flow, SaaS spec §13)
    const SIGNATURE_WINDOW = 60;   // max clock skew for signed requests, seconds (§4.5)
    const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // no 0/O, 1/I/L, U
    const MAX_ATTEMPTS = 5;        // failed claims per code; the 5th failure deletes the code

    // ---- pairing (WordPress-dependent) ----

    /** @return array{code: string, expires: int} */
    public static function issue_pairing_code(): array
    {
        $code = '';
        for ($i = 0; $i < 8; $i++) {
            $code .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
        }
        $code = substr($code, 0, 4) . '-' . substr($code, 4);
        $pairing = ['code' => $code, 'expires' => time() + self::CODE_TTL];
        update_option('ferry_pairing', $pairing, false);
        return $pairing;
    }

    /** @return array{code: string, expires: int}|null null when already paired or expired */
    public static function current_pairing_code()
    {
        if (get_option('ferry_secret')) {
            return null;
        }
        $pairing = get_option('ferry_pairing');
        if (!is_array($pairing) || !isset($pairing['code'], $pairing['expires']) || $pairing['expires'] < time()) {
            return null;
        }
        return $pairing;
    }

    /** Single-use exchange: valid code -> fresh secret, code invalidated. Null on a bad or
     *  expired code; false when THIS attempt spent the budget (code deleted — same as expiry). */
    public static function complete_pairing(string $code)
    {
        $pairing = get_option('ferry_pairing');
        if (!is_array($pairing) || !isset($pairing['code'], $pairing['expires']) || $pairing['expires'] < time()) {
            return null;
        }
        if (!hash_equals($pairing['code'], strtoupper(trim($code)))) {
            $attempts = (int) ($pairing['attempts'] ?? 0) + 1;
            if ($attempts >= self::MAX_ATTEMPTS) {
                // Brute-force budget spent: the code dies like an expired one. update_option
                // is not atomic — a small race around the threshold is acceptable here.
                delete_option('ferry_pairing');
                return false;
            }
            $pairing['attempts'] = $attempts;
            update_option('ferry_pairing', $pairing, false);
            return null;
        }
        $secret = bin2hex(random_bytes(32));
        update_option('ferry_secret', $secret, false);
        delete_option('ferry_pairing');
        return $secret;
    }

    // ---- signatures (pure, mirror of ferry-cli/src/signing.ts) ----

    public static function canonical(string $method, string $route, array $query, string $body, int $timestamp, string $nonce): string
    {
        unset($query['rest_route'], $query['_locale']);
        ksort($query);
        $pairs = [];
        foreach ($query as $k => $v) {
            $pairs[] = rawurlencode((string) $k) . '=' . rawurlencode((string) $v);
        }
        return strtoupper($method) . "\n" . $route . "\n" . implode('&', $pairs) . "\n" . $body . "\n" . $timestamp . "\n" . $nonce;
    }

    public static function sign(string $secret, string $method, string $route, array $query, string $body, int $timestamp, string $nonce): string
    {
        return hash_hmac('sha256', self::canonical($method, $route, $query, $body, $timestamp, $nonce), $secret);
    }

    public static function verify(string $secret, string $method, string $route, array $query, string $body, $timestamp, $signature, $nonce, int $now): bool
    {
        if (!is_string($timestamp) || !is_string($signature) || $timestamp === '' || $signature === '') {
            return false;
        }
        if (!is_string($nonce) || $nonce === '') {
            return false;
        }
        if (abs($now - (int) $timestamp) > self::SIGNATURE_WINDOW) {
            return false;
        }
        $expected = self::sign($secret, $method, $route, $query, $body, (int) $timestamp, $nonce);
        return hash_equals($expected, strtolower($signature));
    }
}
