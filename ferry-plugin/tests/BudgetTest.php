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
        // the fallback must yield ~21s (30 * 0.7), not instant exhaustion.
        $this->assertSame('0', ini_get('max_execution_time'));
        $this->assertFalse((new Budget())->exhausted());
    }
}
