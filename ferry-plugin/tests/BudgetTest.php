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
}
