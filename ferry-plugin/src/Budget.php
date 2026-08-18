<?php
namespace Ferry;

/**
 * §3.3: stop cleanly at ~50% of max_execution_time, clamped to a 20s ceiling -
 * timeouts are answers, not errors. The clamp matters on hosts that enforce a
 * CPU/resource limit that fires well before wall-clock max_execution_time.
 */
final class Budget
{
    /** @var float */
    private $deadline;

    public function __construct(?float $limit_seconds = null)
    {
        if ($limit_seconds === null) {
            $max = (int) ini_get('max_execution_time');
            $limit_seconds = min(($max > 0 ? $max : 30) * 0.5, 20.0);
        }
        $this->deadline = microtime(true) + $limit_seconds;
    }

    public function exhausted(): bool
    {
        return microtime(true) >= $this->deadline;
    }
}
