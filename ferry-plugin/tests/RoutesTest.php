<?php
use Ferry\Budget;
use Ferry\Routes;
use PHPUnit\Framework\TestCase;

/**
 * Unit tests for Routes::batch_should_stop() - the pure stop-decision extracted
 * from files()'s batch loop (byte-cap + time-budget hardening for hostile hosts).
 * files() itself streams to output and calls exit, so the decision logic is
 * tested here in isolation rather than through the endpoint.
 */
final class RoutesTest extends TestCase
{
    public function test_never_stops_with_zero_done_regardless_of_budget_or_bytes(): void
    {
        $exhausted = new Budget(0.0);
        $this->assertFalse(Routes::batch_should_stop(0, $exhausted, Routes::BATCH_BYTE_CAP + 1), 'must ship at least one file per response so next_index always advances');
    }

    public function test_stops_when_byte_cap_reached_after_at_least_one_file(): void
    {
        $generous = new Budget(10.0);
        $this->assertTrue(Routes::batch_should_stop(1, $generous, Routes::BATCH_BYTE_CAP));
    }

    public function test_does_not_stop_just_under_the_byte_cap(): void
    {
        $generous = new Budget(10.0);
        $this->assertFalse(Routes::batch_should_stop(1, $generous, Routes::BATCH_BYTE_CAP - 1));
    }

    public function test_stops_when_time_budget_is_exhausted_after_at_least_one_file(): void
    {
        $exhausted = new Budget(0.0);
        $this->assertTrue(Routes::batch_should_stop(1, $exhausted, 0));
    }

    public function test_does_not_stop_under_both_thresholds(): void
    {
        $generous = new Budget(10.0);
        $this->assertFalse(Routes::batch_should_stop(1, $generous, 0));
    }

    public function test_byte_cap_is_four_megabytes(): void
    {
        $this->assertSame(4 * 1024 * 1024, Routes::BATCH_BYTE_CAP);
    }
}
