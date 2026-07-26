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
    /** In-memory options table, keyed by option_name (mirrors the real UNIQUE index). */
    public $options = [];

    public function __construct(array $script = [])
    {
        $this->script = $script;
    }

    /** Mimics wpdb::insert(): false on duplicate key, like the real UNIQUE index on option_name. */
    public function insert($table, array $data)
    {
        $name = $data['option_name'];
        if (array_key_exists($name, $this->options)) {
            return false;
        }
        $this->options[$name] = $data;
        return 1;
    }

    /** Executes the one raw-SQL shape Nonces::consume issues: the prune DELETE. */
    public function query($sql)
    {
        $this->queries[] = $sql;
        if (preg_match("/DELETE FROM \\S+ WHERE option_name LIKE '([^']*)' AND option_value < (\\d+)/", $sql, $m)) {
            $pattern = '/\A' . str_replace('%', '.*', preg_quote($m[1], '/')) . '\z/';
            $threshold = (int) $m[2];
            foreach ($this->options as $name => $row) {
                if (preg_match($pattern, $name) && (int) $row['option_value'] < $threshold) {
                    unset($this->options[$name]);
                }
            }
        }
        return 0;
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
