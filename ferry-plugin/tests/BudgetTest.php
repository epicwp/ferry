<?php
use Ferry\Budget;
use PHPUnit\Framework\TestCase;

final class BudgetTest extends TestCase
{
    public function test_zero_budget_is_immediately_exhausted(): void
    {
        $this->assertTrue((new Budget(0.0))->exhausted());
    }

    public function test_generous_budget_is_not_exhausted(): void
    {
        $this->assertFalse((new Budget(10.0))->exhausted());
    }

    public function test_default_budget_treats_unlimited_max_execution_time_as_positive_window(): void
    {
        // PHPUnit runs under CLI where max_execution_time is 0 (unlimited);
        // the fallback must yield 15s (30 * 0.5, clamped by min(15, 20) = 15), not instant exhaustion.
        $this->assertSame('0', ini_get('max_execution_time'));
        $this->assertFalse((new Budget())->exhausted());
    }

    public function test_default_budget_uses_half_of_max_execution_time(): void
    {
        $before = ini_get('max_execution_time');
        ini_set('max_execution_time', '10');
        try {
            $start = microtime(true);
            $window = $this->deadline_window(new Budget(), $start);
        } finally {
            ini_set('max_execution_time', $before);
        }
        // 10 * 0.5 = 5s, well under the 20s clamp.
        $this->assertGreaterThan(4.9, $window);
        $this->assertLessThan(5.1, $window);
    }

    public function test_default_budget_window_is_clamped_to_twenty_seconds(): void
    {
        $before = ini_get('max_execution_time');
        ini_set('max_execution_time', '120'); // without the clamp this would be 120 * 0.5 = 60s
        try {
            $start = microtime(true);
            $window = $this->deadline_window(new Budget(), $start);
        } finally {
            ini_set('max_execution_time', $before);
        }
        $this->assertLessThanOrEqual(20.05, $window, 'default window must be clamped to <=20s regardless of max_execution_time');
        $this->assertGreaterThan(19.9, $window, 'sanity: clamp should land at ~20s, not collapse to something tiny');
    }

    private function deadline_window(Budget $budget, float $since): float
    {
        $prop = new \ReflectionProperty(Budget::class, 'deadline');
        $prop->setAccessible(true);
        return $prop->getValue($budget) - $since;
    }
}
