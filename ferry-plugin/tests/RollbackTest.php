<?php
require_once __DIR__ . '/helpers/FakeWpdb.php';

use Ferry\Commit;
use Ferry\Staging;
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
}
