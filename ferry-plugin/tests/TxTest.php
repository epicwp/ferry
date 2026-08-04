<?php
use Ferry\Staging;
use Ferry\Tx;
use PHPUnit\Framework\TestCase;

final class TxTest extends TestCase
{
    /** @var string */
    private $root;

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . '/ferry-tx-' . uniqid();
        mkdir($base . '/wp-content/themes/t', 0777, true);
        $this->root = realpath($base);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    private function meta(string $txid): array
    {
        return json_decode((string) file_get_contents(Staging::backup_dir($this->root, $txid) . '/meta.json'), true);
    }

    // ---- review fix 3: write() is atomic - no half-written meta.json is ever observable ----

    public function test_write_leaves_no_tmp_file_and_valid_json_behind(): void
    {
        $txid = str_repeat('a', 32);

        Tx::write($this->root, $txid, ['status' => 'committed', 'committed_at' => '2026-01-01T00:00:00+00:00']);

        $dir = Staging::backup_dir($this->root, $txid);
        $this->assertFileDoesNotExist($dir . '/meta.json.tmp');
        $this->assertSame(['status' => 'committed', 'committed_at' => '2026-01-01T00:00:00+00:00'], $this->meta($txid));
    }

    // ---- read(): a record stuck at "committing" or "rolling_back" reads as "dirty" ----

    public function test_read_reports_dirty_for_a_record_stuck_committing(): void
    {
        $txid = str_repeat('b', 32);
        Tx::write($this->root, $txid, ['status' => 'committing']);

        $this->assertSame('dirty', Tx::read($this->root, $txid)['status']);
    }

    public function test_read_reports_dirty_for_a_record_stuck_rolling_back(): void
    {
        $txid = str_repeat('c', 32);
        Tx::write($this->root, $txid, ['status' => 'rolling_back']);

        $this->assertSame('dirty', Tx::read($this->root, $txid)['status']);
    }

    // ---- (h) retention: 31-day-old backup pruned, 29-day-old kept ----

    public function test_prune_removes_31_day_old_backup_and_keeps_29_day_old(): void
    {
        $now = 2000000000;
        $old = Staging::backup_dir($this->root, str_repeat('d', 32));
        $recent = Staging::backup_dir($this->root, str_repeat('e', 32));
        mkdir($old, 0777, true);
        mkdir($recent, 0777, true);
        touch($old, $now - 31 * 86400);
        touch($recent, $now - 29 * 86400);

        $removed = Tx::prune($this->root, $now);

        $this->assertSame(1, $removed);
        $this->assertDirectoryDoesNotExist($old);
        $this->assertDirectoryExists($recent);
    }

    // ---- review fix 4: prune never deletes a non-terminal tx, no matter how old it looks ----

    public function test_prune_never_deletes_a_stuck_committing_backup_even_when_31_days_old(): void
    {
        $now = 2000000000;
        $txid = str_repeat('f', 32);
        Tx::write($this->root, $txid, ['status' => 'committing']);
        touch(Staging::backup_dir($this->root, $txid), $now - 31 * 86400);

        $removed = Tx::prune($this->root, $now);

        $this->assertSame(0, $removed);
        $this->assertDirectoryExists(Staging::backup_dir($this->root, $txid));
    }

    public function test_prune_never_deletes_a_stuck_rolling_back_backup_even_when_31_days_old(): void
    {
        $now = 2000000000;
        $txid = str_repeat('9', 32);
        Tx::write($this->root, $txid, ['status' => 'rolling_back']);
        touch(Staging::backup_dir($this->root, $txid), $now - 31 * 86400);

        $removed = Tx::prune($this->root, $now);

        $this->assertSame(0, $removed);
        $this->assertDirectoryExists(Staging::backup_dir($this->root, $txid));
    }

    // ---- final-review fix 7: prune also walks .ferry-staging (age alone - no meta there) ----

    public function test_prune_removes_31_day_old_staging_dir_and_keeps_29_day_old(): void
    {
        $now = 2000000000;
        $old = Staging::dir($this->root, str_repeat('1', 32));
        $recent = Staging::dir($this->root, str_repeat('2', 32));
        mkdir($old, 0777, true);
        mkdir($recent, 0777, true);
        touch($old, $now - 31 * 86400);
        touch($recent, $now - 29 * 86400);

        $removed = Tx::prune($this->root, $now);

        $this->assertSame(1, $removed);
        $this->assertDirectoryDoesNotExist($old);
        $this->assertDirectoryExists($recent);
    }
}
