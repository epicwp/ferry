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
            [['path' => 'wp-content/themes/t/a.css', 'existed' => true, 'old_hash' => $this->sha('old content'), 'new_hash' => $this->sha('new content')]],
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

    // ---- (h) retention + Tx::read status-mapping tests moved to TxTest.php ----

    // ---- review fix 1: a denied write path refuses the WHOLE commit, before any step runs ----

    public function test_denied_write_path_refuses_commit_before_any_step_runs(): void
    {
        $files = [
            ['path' => 'wp-config.php', 'new_hash' => str_repeat('a', 64), 'old_hash' => null],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([], $result['steps']);
        $this->assertSame([['path' => 'wp-config.php', 'code' => 'denied_path']], $result['denied']);
        $this->assertNull(Tx::read($this->root, $this->txid)); // tx meta untouched - nothing was ever written
    }

    public function test_denied_write_path_refuses_even_under_force(): void
    {
        // Path safety is not a drift check - force must never bypass it.
        $files = [
            ['path' => '../escape.txt', 'new_hash' => str_repeat('a', 64), 'old_hash' => null],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], true);

        $this->assertFalse($result['committed']);
        $this->assertSame([['path' => '../escape.txt', 'code' => 'denied_path']], $result['denied']);
    }

    public function test_file_hash_precondition_on_unreadable_path_reports_sentinel_not_real_hash(): void
    {
        file_put_contents($this->root . '/wp-config.php', 'DB_PASSWORD SECRET');
        $preconditions = [
            ['type' => 'file_hash', 'path' => 'wp-config.php', 'expected' => str_repeat('b', 64)],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, [], [], $preconditions, false);

        $this->assertFalse($result['committed']);
        $this->assertSame([
            ['key' => 'wp-config.php', 'expected' => str_repeat('b', 64), 'found' => 'unreadable'],
        ], $result['conflicts']);
        // never the real content hash of wp-config.php
        $this->assertNotSame($this->sha('DB_PASSWORD SECRET'), $result['conflicts'][0]['found']);
    }

    // ---- review fix 5: mid-loop swap failure (file 3 of 3) reverses files 1-2 byte-identically ----

    public function test_swap_failure_on_third_file_reverses_first_two_byte_identically(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'a-old');
        file_put_contents($this->root . '/wp-content/themes/t/b.css', 'b-old');
        // Obstruct file 3's target with a non-empty directory so its swap rename() fails.
        mkdir($this->root . '/wp-content/themes/t/c.css', 0777, true);
        file_put_contents($this->root . '/wp-content/themes/t/c.css/blocking.txt', 'in the way');

        Staging::add($this->root, $this->txid, [
            $this->stagedFile('wp-content/themes/t/a.css', 'a-new'),
            $this->stagedFile('wp-content/themes/t/b.css', 'b-new'),
            $this->stagedFile('wp-content/themes/t/c.css', 'c-new'),
        ]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('a-new'), 'old_hash' => $this->sha('a-old')],
            ['path' => 'wp-content/themes/t/b.css', 'new_hash' => $this->sha('b-new'), 'old_hash' => $this->sha('b-old')],
            // c.css is a directory right now, not a file - is_file() sees it as "did not exist".
            ['path' => 'wp-content/themes/t/c.css', 'new_hash' => $this->sha('c-new'), 'old_hash' => null],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertFalse($result['committed']);
        $stepsByName = array_column($result['steps'], 'ok', 'name');
        $this->assertTrue($stepsByName['hashes']);
        $this->assertTrue($stepsByName['drift']);
        $this->assertTrue($stepsByName['backup']);
        $this->assertFalse($stepsByName['swap']);

        $this->assertSame('a-old', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertSame('b-old', file_get_contents($this->root . '/wp-content/themes/t/b.css'));
        $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css');
        $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/b.css');
        // the obstruction itself was never touched
        $this->assertDirectoryExists($this->root . '/wp-content/themes/t/c.css');
        $this->assertSame('conflict', $this->meta()['status']);
    }

    // ---- final-review fix 1: DbOps::validate wired into the write path - a bad op refuses
    // the whole commit, nothing staged/renamed, before any step runs ----

    public function test_commit_refuses_a_row_op_on_wp_posts_end_to_end(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $ops = [['kind' => 'row_update', 'table' => 'wp_posts', 'pkCol' => 'ID', 'pk' => 1, 'old' => ['post_title' => 'a'], 'new' => ['post_title' => 'b']]];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, $ops, [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([], $result['steps']);
        $this->assertSame([['index' => 0, 'reason' => 'refused_table']], $result['denied']);
        $this->assertSame('old content', file_get_contents($this->root . '/wp-content/themes/t/a.css')); // nothing swapped
        $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css');
        $this->assertSame([], $wpdb->queries); // DB step never reached
        $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/meta.json'); // tx meta untouched
    }

    public function test_commit_refuses_an_unknown_op_kind(): void
    {
        $ops = [['kind' => 'schema_migrate']];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, [], $ops, [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([['index' => 0, 'reason' => 'unknown_kind']], $result['denied']);
    }

    public function test_commit_refuses_mixed_case_content_table(): void
    {
        $ops = [['kind' => 'row_update', 'table' => 'WP_POSTS', 'pkCol' => 'ID', 'pk' => 1, 'old' => ['post_title' => 'a'], 'new' => ['post_title' => 'b']]];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, [], $ops, [], false);

        $this->assertFalse($result['committed']);
        $this->assertSame([['index' => 0, 'reason' => 'refused_table']], $result['denied']);
    }

    // ---- final-review fix 7: staging dir is removed after a successful commit ----

    public function test_successful_commit_removes_the_staging_dir(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $this->assertDirectoryExists(Staging::dir($this->root, $this->txid));
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $wpdb = new FakeWpdb([]);

        $result = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertTrue($result['committed']);
        $this->assertDirectoryDoesNotExist(Staging::dir($this->root, $this->txid));
        // backup dir must survive - rollback needs it
        $this->assertDirectoryExists(Staging::backup_dir($this->root, $this->txid));
    }

    // ---- review fix 4: commit touches an existing backup dir, surviving a concurrent prune ----

    public function test_commit_touches_existing_backup_dir_to_survive_concurrent_prune(): void
    {
        // Simulate a prior attempt on this txid: the backup dir already exists and is aged
        // (a retried /commit call reuses the same txid after an earlier conflict).
        Tx::write($this->root, $this->txid, ['status' => 'conflict']);
        $backupDir = Staging::backup_dir($this->root, $this->txid);
        touch($backupDir, time() - 29 * 86400);

        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $wpdb = new FakeWpdb([]);

        Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);

        $this->assertGreaterThanOrEqual(time() - 5, filemtime($backupDir));
    }
}
