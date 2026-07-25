<?php
/**
 * Minimal scripted wpdb double. Results are returned in FIFO order for
 * get_results/get_row/get_var/get_col alike; tests script the exact call
 * sequence Db makes. Executed SQL is recorded for assertions.
 */
final class FakeWpdb
{
    /** @var array<int, mixed> */
    private $script;
    /** @var string[] */
    public $queries = [];

    public function __construct(array $script)
    {
        $this->script = $script;
    }

    public function prepare($query, ...$args)
    {
        foreach ($args as $arg) {
            $query = preg_replace_callback('/%[dsi]/', function ($m) use ($arg) {
                if ($m[0] === '%d') { return (string) (int) $arg; }
                if ($m[0] === '%i') { return '`' . $arg . '`'; }
                return "'" . $arg . "'";
            }, $query, 1);
        }
        return $query;
    }

    public function get_results($query, $output = ARRAY_A)
    {
        $this->queries[] = $query;
        return array_shift($this->script) ?: [];
    }

    public function get_row($query, $output = ARRAY_A)
    {
        $this->queries[] = $query;
        return array_shift($this->script);
    }

    public function get_var($query)
    {
        $this->queries[] = $query;
        return array_shift($this->script);
    }

    public function get_col($query)
    {
        $this->queries[] = $query;
        return array_shift($this->script) ?: [];
    }
}
