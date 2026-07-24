<?php
use PHPUnit\Framework\TestCase;

final class SmokeTest extends TestCase
{
    public function test_harness_runs(): void
    {
        $this->assertTrue(PHP_VERSION_ID >= 70200);
    }
}
