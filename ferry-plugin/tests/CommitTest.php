<?php
require_once __DIR__ . '/helpers/FakeWpdb.php';

use Ferry\Commit;
use Ferry\Staging;
use Ferry\Tx;
use PHPUnit\Framework\TestCase;

final class CommitTest extends TestCase
{
    /** @var string */
    private $root;

    /** @var string 32 hex chars, per the txid contract. */
    private $txid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . '/ferry-commit-' . uniqid();
        mkdir($base . '/wp-content/themes/t', 0777, true);
        $this->root = realpath($base);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    private function sha(string $content): string
    {
        return hash('sha256', $content);
    }

    private function stagedFile(string $path, string $content): array
    {
        return ['path' => $path, 'data_b64' => base64_encode($content), 'hash' => $this->sha($content)];
    }

    private function meta(): array
    {
        return json_decode((string) file_get_contents(Staging::backup_dir($this->root, $this->txid) . '/meta.json'), true);
    }

    // ---- (a) happy commit: files swapped, backup holds originals, meta committed, 5 steps ----

    public function test_happy_commit_swaps_files_and_records_backup(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $ops = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2']];
        $wpdb = new FakeWpdb([['option_value' => '1']]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, $ops, [], false);

        $this->assertTrue($result['committed']);
        $this->assertSame([], $result['conflicts']);
        $this->assertCount(5, $result['steps']);
        $this->assertSame(['hashes', 'drift', 'backup', 'swap', 'journal'], array_column($result['steps'], 'name'));
        foreach ($result['steps'] as $step) {
            $this->assertTrue($step['ok']);
            $this->assertIsFloat($step['durationMs']);
            $this->assertGreaterThanOrEqual(0, $step['durationMs']);
        }

        $this->assertSame('new content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $backupFile = Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css';
        $this->assertFileExists($backupFile);
        $this->assertSame('old content', file_get_contents($backupFile));

        $meta = $this->meta();
        $this->assertSame('committed', $meta['status']);
        $this->assertArrayHasKey('committed_at', $meta);
        $this->assertSame(
            [['path' => 'wp-content/themes/t/a.css', 'existed' => true, 'new_hash' => $this->sha('new content')]],
            $meta['files']
        );
    }

    // ---- (b) drift conflict: nothing renamed, staging intact, meta conflict ----

    public function test_drift_conflict_blocks_commit_and_leaves_everything_untouched(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'live-edited content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $files = [
            // old_hash reflects a stale expectation - production drifted since the agent read it.
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'wp-content/themes/t/a.css', 'expected' => $this->sha('old content'), 'found' => $this->sha('live-edited content')],
        ], $result['conflicts']);

        $this->assertSame('live-edited content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css');
        $this->assertFileExists(Staging::dir($this->root, $this->txid) . '/blobs/' . $this->sha('new content') . '.bin');

        $this->assertSame('conflict', $this->meta()['status']);
        $this->assertSame([], $wpdb->queries); // DB step never reached
    }

    // ---- (c) DB failure after renames: renames reversed, byte-identical ----

    public function test_db_apply_error_after_renames_reverses_files_byte_identical(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $ops = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2']];
        $wpdb = new FakeWpdb([['option_value' => '1']]); // read-set matches - no drift, no conflict
        $wpdb->fail_query_at_call = 1; // call 0 = START TRANSACTION, call 1 = the UPDATE itself

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, $ops, [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([], $result['conflicts']);
        $this->assertSame(['key' => 'option:ferry_a', 'detail' => 'option_set apply failed'], $result['apply_error']);

        $stepsByName = array_column($result['steps'], 'ok', 'name');
        $this->assertTrue($stepsByName['hashes']);
        $this->assertTrue($stepsByName['drift']);
        $this->assertTrue($stepsByName['backup']);
        $this->assertTrue($stepsByName['swap']);
        $this->assertFalse($stepsByName['journal']);

        // Renames reversed: target is byte-identical to before the commit attempt.
        $this->assertSame('old content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css');
        // Staged blob restored to its original location - a retry can reuse it.
        $blobPath = Staging::dir($this->root, $this->txid) . '/blobs/' . $this->sha('new content') . '.bin';
        $this->assertFileExists($blobPath);
        $this->assertSame('new content', file_get_contents($blobPath));

        $this->assertSame('conflict', $this->meta()['status']);
        $this->assertNotContains('COMMIT', $wpdb->queries);
    }

    // ---- (d) delete: target moved to backup, nothing renamed in ----

    public function test_delete_file_moves_target_to_backup_without_swap_in(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'to be deleted');
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => null, 'old_hash' => $this->sha('to be deleted')],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertTrue($result['committed']);
        $this->assertFileDoesNotExist($this->root . '/wp-content/themes/t/a.css');
        $backupFile = Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css';
        $this->assertFileExists($backupFile);
        $this->assertSame('to be deleted', file_get_contents($backupFile));
    }

    // ---- (g) > 200 files refused, before touching the filesystem ----

    public function test_commit_refuses_more_than_200_files(): void
    {
        $files = [];
        for ($i = 0; $i < 201; $i++) {
            $files[] = ['path' => "wp-content/themes/t/file{$i}.css", 'new_hash' => str_repeat('a', 64), 'old_hash' => null];
        }
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([], $result['steps']);
        $this->assertSame('ferry_too_many_files', $result['error']);
        $this->assertDirectoryDoesNotExist(Staging::backup_dir($this->root, $this->txid));
    }

    // ---- (h) retention: 31-day-old backup pruned, 29-day-old kept ----

    public function test_prune_removes_31_day_old_backup_and_keeps_29_day_old(): void
    {
        $now = 2000000000;
        $old = Staging::backup_dir($this->root, str_repeat('a', 32));
        $recent = Staging::backup_dir($this->root, str_repeat('b', 32));
        mkdir($old, 0777, true);
        mkdir($recent, 0777, true);
        touch($old, $now - 31 * 86400);
        touch($recent, $now - 29 * 86400);

        $removed = Tx::prune($this->root, $now);

        $this->assertSame(1, $removed);
        $this->assertDirectoryDoesNotExist($old);
        $this->assertDirectoryExists($recent);
    }

    // ---- Tx::read: a record stuck at "committing" (process died mid-commit) reads as "dirty" ----

    public function test_tx_read_reports_dirty_for_a_record_stuck_committing(): void
    {
        Tx::write($this->root, $this->txid, ['status' => 'committing']);

        $meta = Tx::read($this->root, $this->txid);

        $this->assertSame('dirty', $meta['status']);
    }
}
