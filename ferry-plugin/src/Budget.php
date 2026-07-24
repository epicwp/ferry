<?php
namespace Ferry;

/** §3.3: stop cleanly at ~70% of max_execution_time - timeouts are answers, not errors. */
final class Budget
{
    /** @var float */
    private $deadline;

    public function __construct(?float $limit_seconds = null)
    {
        if ($limit_seconds === null) {
            $max = (int) ini_get('max_execution_time');
            $limit_seconds = ($max > 0 ? $max : 30) * 0.7;
        }
        $this->deadline = microtime(true) + $limit_seconds;
    }

    public function exhausted(): bool
    {
        return microtime(true) >= $this->deadline;
    }
}
