<?php
use Ferry\Auth;
use PHPUnit\Framework\TestCase;

final class PairingTest extends TestCase
{
    protected function setUp(): void
    {
        $GLOBALS['ferry_options'] = [];
    }

    public function test_correct_code_pairs_and_consumes_the_code(): void
    {
        $pairing = Auth::issue_pairing_code();
        $secret = Auth::complete_pairing(strtolower($pairing['code'])); // case-insensitive input
        $this->assertIsString($secret);
        $this->assertSame(64, strlen($secret));
        $this->assertArrayNotHasKey('ferry_pairing', $GLOBALS['ferry_options']);
        $this->assertSame($secret, $GLOBALS['ferry_options']['ferry_secret']);
    }

    public function test_failed_attempts_count_and_code_survives_below_the_budget(): void
    {
        Auth::issue_pairing_code();
        for ($i = 0; $i < 4; $i++) {
            $this->assertNull(Auth::complete_pairing('0000-0000'));
        }
        $this->assertSame(4, $GLOBALS['ferry_options']['ferry_pairing']['attempts']);
    }

    public function test_fifth_failed_attempt_deletes_the_code_and_reports_lockout(): void
    {
        $pairing = Auth::issue_pairing_code();
        for ($i = 0; $i < 4; $i++) {
            Auth::complete_pairing('0000-0000');
        }
        $this->assertFalse(Auth::complete_pairing('0000-0000'));
        $this->assertArrayNotHasKey('ferry_pairing', $GLOBALS['ferry_options']);
        // afterwards indistinguishable from expiry — even the real code is dead
        $this->assertNull(Auth::complete_pairing($pairing['code']));
    }

    public function test_correct_code_within_the_budget_still_pairs(): void
    {
        $pairing = Auth::issue_pairing_code();
        Auth::complete_pairing('0000-0000');
        $this->assertIsString(Auth::complete_pairing($pairing['code']));
    }

    public function test_a_fresh_code_starts_with_a_fresh_budget(): void
    {
        Auth::issue_pairing_code();
        for ($i = 0; $i < 5; $i++) {
            Auth::complete_pairing('0000-0000');
        }
        $pairing = Auth::issue_pairing_code(); // re-activation / wp ferry pair path
        $this->assertIsString(Auth::complete_pairing($pairing['code']));
    }

    public function test_expired_code_returns_null_without_counting(): void
    {
        Auth::issue_pairing_code();
        $GLOBALS['ferry_options']['ferry_pairing']['expires'] = time() - 1;
        $this->assertNull(Auth::complete_pairing('0000-0000'));
        $this->assertArrayNotHasKey('attempts', $GLOBALS['ferry_options']['ferry_pairing']);
    }
}
