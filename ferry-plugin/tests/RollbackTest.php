<?php
require_once __DIR__ . '/helpers/FakeWpdb.php';

use Ferry\Commit;
use Ferry\Staging;
use Ferry\Tx;
use PHPUnit\Framework\TestCase;

final class RollbackTest extends TestCase
{
    /** @var string */
    private $root;

    /** @var string 32 hex chars, per the txid contract. */
    private $txid = 'cccccccccccccccccccccccccccccccc';

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . '/ferry-rollback-' . uniqid();
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

    /** Commits one modified file + one newly created file, so rollback exercises both restore paths. */
    private function commitModifyAndCreate(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [
            $this->stagedFile('wp-content/themes/t/a.css', 'new content'),
            $this->stagedFile('wp-content/themes/t/new.css', 'created content'),
        ]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
            ['path' => 'wp-content/themes/t/new.css', 'new_hash' => $this->sha('created content'), 'old_hash' => null],
        ];
        $ops = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '1', 'new' => '2']];
        $wpdb = new FakeWpdb([['option_value' => '1']]);
        $result = Commit::run($this->root, $wpdb, $this->txid, $files, $ops, [], false);
        $this->assertTrue($result['committed'], 'fixture setup: commit must succeed');
    }

    // ---- (e) rollback happy: originals restored, created file removed, meta rolled_back ----

    public function test_rollback_restores_original_and_removes_created_file(): void
    {
        $this->commitModifyAndCreate();

        $inverseOps = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '2', 'new' => '1']];
        $wpdb = new FakeWpdb([['option_value' => '2']]); // current DB value = what the push installed

        $result = Commit::rollback($this->root, $wpdb, $this->txid, $inverseOps);

        $this->assertTrue($result['rolled_back']);
        $this->assertSame([], $result['conflicts']);
        $this->assertSame('old content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertFileDoesNotExist($this->root . '/wp-content/themes/t/new.css');
        $this->assertSame('rolled_back', $this->meta()['status']);
    }

    // ---- (f) rollback CAS failure: target edited after push -> nothing restored ----

    public function test_rollback_refuses_when_target_was_edited_after_push(): void
    {
        $this->commitModifyAndCreate();
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'edited after push');

        $inverseOps = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '2', 'new' => '1']];
        $wpdb = new FakeWpdb([]);

        $result = Commit::rollback($this->root, $wpdb, $this->txid, $inverseOps);

        $this->assertFalse($result['rolled_back']);
        $this->assertSame([
            ['key' => 'wp-content/themes/t/a.css', 'expected' => $this->sha('new content'), 'found' => $this->sha('edited after push')],
        ], $result['conflicts']);

        // Nothing restored: the edited file stands, and the created file is untouched.
        $this->assertSame('edited after push', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertFileExists($this->root . '/wp-content/themes/t/new.css');
        $this->assertSame('created content', file_get_contents($this->root . '/wp-content/themes/t/new.css'));
        $this->assertSame([], $wpdb->queries); // DB step never reached
        $this->assertSame('committed', $this->meta()['status']);
    }

    // ---- supplementary: rollback of a delete op restores the removed file from backup ----

    public function test_rollback_restores_a_file_that_was_deleted_by_the_push(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/gone.css', 'deleted content');
        $files = [
            ['path' => 'wp-content/themes/t/gone.css', 'new_hash' => null, 'old_hash' => $this->sha('deleted content')],
        ];
        $wpdb = new FakeWpdb([]);
        $committed = Commit::run($this->root, $wpdb, $this->txid, $files, [], [], false);
        $this->assertTrue($committed['committed'], 'fixture setup: commit must succeed');
        $this->assertFileDoesNotExist($this->root . '/wp-content/themes/t/gone.css');

        $result = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

        $this->assertTrue($result['rolled_back']);
        $this->assertSame([], $result['conflicts']);
        $this->assertSame('deleted content', file_get_contents($this->root . '/wp-content/themes/t/gone.css'));
    }

    // ---- final-review fix 1: DbOps::validate wired into rollback too - a bad inverse op
    // refuses the whole rollback, nothing restored ----

    public function test_rollback_refuses_a_row_op_on_a_refused_table(): void
    {
        $this->commitModifyAndCreate();
        $badOps = [['kind' => 'row_update', 'table' => 'wp_posts', 'pkCol' => 'ID', 'pk' => 1, 'old' => ['post_title' => 'a'], 'new' => ['post_title' => 'b']]];

        $result = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, $badOps);

        $this->assertFalse($result['rolled_back']);
        $this->assertSame([['index' => 0, 'reason' => 'refused_table']], $result['denied']);
        // nothing restored: the pushed content still stands
        $this->assertSame('new content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertSame('committed', $this->meta()['status']);
    }

    // ---- review fix 1: defense in depth - rollback re-validates meta's paths too ----

    public function test_rollback_defense_in_depth_refuses_a_denied_path_found_in_meta(): void
    {
        // Paths are write-validated at commit time, so a real commit can never put this into
        // meta.json - fabricate it directly to exercise rollback's own independent guard.
        Tx::write($this->root, $this->txid, [
            'status' => 'committed',
            'files' => [
                ['path' => 'wp-config.php', 'existed' => true, 'old_hash' => $this->sha('a'), 'new_hash' => $this->sha('b')],
            ],
        ]);

        $result = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

        $this->assertFalse($result['rolled_back']);
        $this->assertSame([['path' => 'wp-config.php', 'code' => 'denied_path']], $result['denied']);
    }

    // ---- review fix 2: rollback is idempotent - a retry after a simulated crash completes ----

    public function test_rollback_retried_after_a_simulated_crash_completes(): void
    {
        $this->commitModifyAndCreate();
        $inverseOps = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '2', 'new' => '1']];

        // First call: a full, successful rollback.
        $first = Commit::rollback($this->root, new FakeWpdb([['option_value' => '2']]), $this->txid, $inverseOps);
        $this->assertTrue($first['rolled_back'], 'fixture setup: the first rollback must succeed');

        // Simulate the crash: as if the process died right after the interim write, leaving
        // meta stuck at "rolling_back" - even though, in this test, the files and DB are
        // already fully rolled back. /tx would read this as "dirty" and the caller retries.
        $meta = json_decode((string) file_get_contents(Staging::backup_dir($this->root, $this->txid) . '/meta.json'), true);
        $meta['status'] = 'rolling_back';
        Tx::write($this->root, $this->txid, $meta);
        $this->assertSame('dirty', Tx::read($this->root, $this->txid)['status']); // sanity: reads as dirty now

        // Retry: every file is already in its post-rollback state (satisfied, not a conflict) -
        // the retry must complete rather than CAS-fail against its own prior progress.
        $second = Commit::rollback($this->root, new FakeWpdb([['option_value' => '2']]), $this->txid, $inverseOps);

        $this->assertTrue($second['rolled_back']);
        $this->assertSame([], $second['conflicts']);
        $this->assertSame('old content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertFileDoesNotExist($this->root . '/wp-content/themes/t/new.css');
        $this->assertSame('rolled_back', Tx::read($this->root, $this->txid)['status']);
    }

    // ---- review fix 4: rollback touches the backup dir, surviving a concurrent prune mid-flight ----

    public function test_rollback_touches_backup_dir_to_survive_concurrent_prune(): void
    {
        $this->commitModifyAndCreate();
        $backupDir = Staging::backup_dir($this->root, $this->txid);
        touch($backupDir, time() - 29 * 86400); // simulate it sitting near the 30-day cliff

        $inverseOps = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '2', 'new' => '1']];
        Commit::rollback($this->root, new FakeWpdb([['option_value' => '2']]), $this->txid, $inverseOps);

        $this->assertGreaterThanOrEqual(time() - 5, filemtime($backupDir));
    }

    // ---- review fix (round 3): a failed restore rename must not read as success ----

    public function test_rollback_treats_a_failed_restore_rename_as_a_conflict_not_success(): void
    {
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'old content');
        Staging::add($this->root, $this->txid, [$this->stagedFile('wp-content/themes/t/a.css', 'new content')]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('new content'), 'old_hash' => $this->sha('old content')],
        ];
        $committed = Commit::run($this->root, new FakeWpdb([]), $this->txid, $files, [], [], false);
        $this->assertTrue($committed['committed'], 'fixture setup: commit must succeed');

        // Obstruct the restore rename's destination: no write/execute permission on the
        // target's parent means rename() into it fails.
        $parent = $this->root . '/wp-content/themes/t';
        chmod($parent, 0555);
        if (is_writable($parent)) {
            chmod($parent, 0777); // undo before skipping, so tearDown's rm -rf still works
            $this->markTestSkipped('running as a user that bypasses filesystem permissions (e.g. root) - chmod does not restrict writes here');
        }

        try {
            $result = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

            $this->assertFalse($result['rolled_back']);
            $this->assertSame([
                ['key' => 'wp-content/themes/t/a.css', 'expected' => 'restorable', 'found' => 'rename_failed'],
            ], $result['conflicts']);
            $this->assertSame('dirty', Tx::read($this->root, $this->txid)['status']); // stuck rolling_back
            // Nothing lost: the pushed content still stands, backup is still there to retry from.
            $this->assertSame('new content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
            $this->assertSame(
                'old content',
                file_get_contents(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css')
            );
        } finally {
            chmod($parent, 0777); // always restore, even if an assertion above failed
        }

        // Retry - the idempotent CAS makes this safe now that the permission is fixed, and
        // it must complete.
        $retry = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

        $this->assertTrue($retry['rolled_back']);
        $this->assertSame([], $retry['conflicts']);
        $this->assertSame('old content', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertSame('rolled_back', Tx::read($this->root, $this->txid)['status']);
    }

    // ---- review fix (round 4): a partial multi-file failure must not destroy an earlier restore ----

    public function test_rollback_partial_failure_leaves_earlier_restores_intact_and_retry_completes(): void
    {
        mkdir($this->root . '/wp-content/plugins/p', 0777, true);
        file_put_contents($this->root . '/wp-content/themes/t/a.css', 'a-original');
        file_put_contents($this->root . '/wp-content/plugins/p/b.css', 'b-original');
        Staging::add($this->root, $this->txid, [
            $this->stagedFile('wp-content/themes/t/a.css', 'a-pushed'),
            $this->stagedFile('wp-content/plugins/p/b.css', 'b-pushed'),
        ]);
        $files = [
            ['path' => 'wp-content/themes/t/a.css', 'new_hash' => $this->sha('a-pushed'), 'old_hash' => $this->sha('a-original')],
            ['path' => 'wp-content/plugins/p/b.css', 'new_hash' => $this->sha('b-pushed'), 'old_hash' => $this->sha('b-original')],
        ];
        $committed = Commit::run($this->root, new FakeWpdb([]), $this->txid, $files, [], [], false);
        $this->assertTrue($committed['committed'], 'fixture setup: commit must succeed');

        // f1 (a.css) restores fine; f2 (b.css)'s parent is obstructed, so its restore fails.
        $f2Parent = $this->root . '/wp-content/plugins/p';
        chmod($f2Parent, 0555);
        if (is_writable($f2Parent)) {
            chmod($f2Parent, 0777);
            $this->markTestSkipped('running as a user that bypasses filesystem permissions (e.g. root) - chmod does not restrict writes here');
        }

        try {
            $result = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

            $this->assertFalse($result['rolled_back']);
            $this->assertSame([
                ['key' => 'wp-content/plugins/p/b.css', 'expected' => 'restorable', 'found' => 'rename_failed'],
            ], $result['conflicts']);
            $this->assertSame('dirty', Tx::read($this->root, $this->txid)['status']);

            // f1 restored correctly - it must NOT have been reversed/destroyed because f2
            // failed afterward. A restore rename is a one-way atomic overwrite: there is no
            // second copy of the pushed content to put back, so undoing a successful restore
            // would leave the target with nothing at all.
            $this->assertSame('a-original', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
            $this->assertFileDoesNotExist(Staging::backup_dir($this->root, $this->txid) . '/files/wp-content/themes/t/a.css');
            // f2 untouched - the failed rename touched neither its source nor its destination.
            $this->assertSame('b-pushed', file_get_contents($this->root . '/wp-content/plugins/p/b.css'));
        } finally {
            chmod($f2Parent, 0777); // always restore, even if an assertion above failed
        }

        // Retry: f1 reads as already-satisfied (idempotent, matches old_hash) and is left
        // alone; f2 is still pending (matches new_hash) and gets restored now.
        $retry = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

        $this->assertTrue($retry['rolled_back']);
        $this->assertSame([], $retry['conflicts']);
        $this->assertSame('a-original', file_get_contents($this->root . '/wp-content/themes/t/a.css'));
        $this->assertSame('b-original', file_get_contents($this->root . '/wp-content/plugins/p/b.css'));
        $this->assertSame('rolled_back', Tx::read($this->root, $this->txid)['status']);
    }

    // ---- review fix (round 4): a created file's already-discarded target reads as satisfied ----

    public function test_rollback_partial_failure_with_a_created_file_treats_its_discard_as_satisfied_on_retry(): void
    {
        mkdir($this->root . '/wp-content/plugins/p', 0777, true);
        file_put_contents($this->root . '/wp-content/plugins/p/b.css', 'b-original');
        Staging::add($this->root, $this->txid, [
            $this->stagedFile('wp-content/themes/t/new.css', 'created content'),
            $this->stagedFile('wp-content/plugins/p/b.css', 'b-pushed'),
        ]);
        $files = [
            ['path' => 'wp-content/themes/t/new.css', 'new_hash' => $this->sha('created content'), 'old_hash' => null],
            ['path' => 'wp-content/plugins/p/b.css', 'new_hash' => $this->sha('b-pushed'), 'old_hash' => $this->sha('b-original')],
        ];
        $committed = Commit::run($this->root, new FakeWpdb([]), $this->txid, $files, [], [], false);
        $this->assertTrue($committed['committed'], 'fixture setup: commit must succeed');

        // The created file discards fine; b.css's parent is obstructed, so its restore fails
        // right after - a genuine partial failure, not a manually-simulated crash.
        $f2Parent = $this->root . '/wp-content/plugins/p';
        chmod($f2Parent, 0555);
        if (is_writable($f2Parent)) {
            chmod($f2Parent, 0777);
            $this->markTestSkipped('running as a user that bypasses filesystem permissions (e.g. root) - chmod does not restrict writes here');
        }

        try {
            $result = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

            $this->assertFalse($result['rolled_back']);
            $this->assertSame([
                ['key' => 'wp-content/plugins/p/b.css', 'expected' => 'restorable', 'found' => 'rename_failed'],
            ], $result['conflicts']);
            $this->assertFileDoesNotExist($this->root . '/wp-content/themes/t/new.css'); // discard already done
            $this->assertSame('dirty', Tx::read($this->root, $this->txid)['status']);
        } finally {
            chmod($f2Parent, 0777);
        }

        // Retry: the created file's absent target must read as satisfied (old_hash is null,
        // current is null - matches), not re-attempted and not reported as a conflict; only
        // b.css is still pending.
        $retry = Commit::rollback($this->root, new FakeWpdb([]), $this->txid, []);

        $this->assertTrue($retry['rolled_back']);
        $this->assertSame([], $retry['conflicts']);
        $this->assertFileDoesNotExist($this->root . '/wp-content/themes/t/new.css');
        $this->assertSame('b-original', file_get_contents($this->root . '/wp-content/plugins/p/b.css'));
        $this->assertSame('rolled_back', Tx::read($this->root, $this->txid)['status']);
    }
}
