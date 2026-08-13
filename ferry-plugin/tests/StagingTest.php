<?php
use Ferry\Staging;
use PHPUnit\Framework\TestCase;

final class StagingTest extends TestCase
{
    /** @var string */
    private $root;

    /** @var string 32 hex chars, per the txid contract. */
    private $txid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . '/ferry-staging-' . uniqid();
        mkdir($base . '/wp-content/themes/t', 0777, true);
        $this->root = realpath($base);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    private function file(string $path, string $content): array
    {
        return ['path' => $path, 'data_b64' => base64_encode($content), 'hash' => hash('sha256', $content)];
    }

    private function manifest(string $dir): array
    {
        return json_decode((string) file_get_contents($dir . '/manifest.json'), true);
    }

    public function test_stages_two_files_with_protections(): void
    {
        $result = Staging::add($this->root, $this->txid, [
            $this->file('wp-content/themes/t/a.css', 'body{color:red}'),
            $this->file('wp-content/themes/t/b.css', 'body{color:blue}'),
        ]);

        $this->assertSame(['wp-content/themes/t/a.css', 'wp-content/themes/t/b.css'], $result['staged']);
        $this->assertSame([], $result['rejected']);

        $dir = Staging::dir($this->root, $this->txid);
        $this->assertSame($this->root . '/wp-content/uploads/.ferry-staging/' . $this->txid, $dir);
        $this->assertFileExists($dir . '/index.php');
        $this->assertStringStartsWith('<?php', (string) file_get_contents($dir . '/index.php'));
        $this->assertFileExists($dir . '/.htaccess');
        $this->assertStringContainsString('Require all denied', (string) file_get_contents($dir . '/.htaccess'));

        $blob_a = $dir . '/blobs/' . hash('sha256', 'body{color:red}') . '.bin';
        $blob_b = $dir . '/blobs/' . hash('sha256', 'body{color:blue}') . '.bin';
        $this->assertFileExists($blob_a);
        $this->assertSame('body{color:red}', file_get_contents($blob_a));
        $this->assertFileExists($blob_b);
        $this->assertSame('body{color:blue}', file_get_contents($blob_b));

        $manifest = $this->manifest($dir);
        $this->assertSame(hash('sha256', 'body{color:red}'), $manifest['files']['wp-content/themes/t/a.css']['blob']);
        $this->assertSame(hash('sha256', 'body{color:blue}'), $manifest['files']['wp-content/themes/t/b.css']['blob']);
    }

    public function test_second_call_merges_manifest_for_resumability(): void
    {
        Staging::add($this->root, $this->txid, [
            $this->file('wp-content/themes/t/a.css', 'body{color:red}'),
            $this->file('wp-content/themes/t/b.css', 'body{color:blue}'),
        ]);
        $second = Staging::add($this->root, $this->txid, [
            $this->file('wp-content/themes/t/c.css', 'body{color:green}'),
        ]);

        $this->assertSame(['wp-content/themes/t/c.css'], $second['staged']);

        $dir = Staging::dir($this->root, $this->txid);
        $manifest = $this->manifest($dir);
        $this->assertCount(3, $manifest['files']);
        $this->assertArrayHasKey('wp-content/themes/t/a.css', $manifest['files']);
        $this->assertArrayHasKey('wp-content/themes/t/b.css', $manifest['files']);
        $this->assertArrayHasKey('wp-content/themes/t/c.css', $manifest['files']);
        $this->assertFileExists($dir . '/blobs/' . hash('sha256', 'body{color:green}') . '.bin');
    }

    public function test_restaging_same_path_overwrites_manifest_entry(): void
    {
        Staging::add($this->root, $this->txid, [
            $this->file('wp-content/themes/t/a.css', 'body{color:red}'),
        ]);
        Staging::add($this->root, $this->txid, [
            $this->file('wp-content/themes/t/a.css', 'body{color:purple}'),
        ]);

        $dir = Staging::dir($this->root, $this->txid);
        $manifest = $this->manifest($dir);
        $this->assertCount(1, $manifest['files']);
        $this->assertSame(hash('sha256', 'body{color:purple}'), $manifest['files']['wp-content/themes/t/a.css']['blob']);
        $this->assertFileExists($dir . '/blobs/' . hash('sha256', 'body{color:purple}') . '.bin');
    }

    public function test_bad_hash_is_rejected_and_writes_nothing(): void
    {
        $file = $this->file('wp-content/themes/t/a.css', 'body{color:red}');
        $file['hash'] = str_repeat('0', 64); // deliberately wrong

        $result = Staging::add($this->root, $this->txid, [$file]);

        $this->assertSame([], $result['staged']);
        $this->assertSame([['path' => 'wp-content/themes/t/a.css', 'code' => 'bad_hash']], $result['rejected']);

        $dir = Staging::dir($this->root, $this->txid);
        $this->assertFileDoesNotExist($dir . '/blobs/' . hash('sha256', 'body{color:red}') . '.bin');
        $manifest = $this->manifest($dir);
        $this->assertArrayNotHasKey('wp-content/themes/t/a.css', $manifest['files']);
    }

    public function test_wp_config_bak_is_rejected_as_denied_path(): void
    {
        $result = Staging::add($this->root, $this->txid, [
            $this->file('wp-config.php.bak', 'malicious'),
        ]);

        $this->assertSame([], $result['staged']);
        $this->assertSame([['path' => 'wp-config.php.bak', 'code' => 'denied_path']], $result['rejected']);
    }

    public function test_bad_base64_is_rejected(): void
    {
        $result = Staging::add($this->root, $this->txid, [
            ['path' => 'wp-content/themes/t/a.css', 'data_b64' => 'not base64!!', 'hash' => str_repeat('0', 64)],
        ]);

        $this->assertSame([], $result['staged']);
        $this->assertSame([['path' => 'wp-content/themes/t/a.css', 'code' => 'bad_base64']], $result['rejected']);
    }

    public function test_bad_txid_returns_error_shape_without_side_effects(): void
    {
        $result = Staging::add($this->root, 'not-a-valid-txid', [
            $this->file('wp-content/themes/t/a.css', 'body{color:red}'),
        ]);

        $this->assertSame(['error' => 'ferry_bad_txid'], $result);
        $this->assertDirectoryDoesNotExist($this->root . '/wp-content/uploads/.ferry-staging');
    }

    public function test_resumed_batch_refreshes_the_staging_dir_mtime(): void
    {
        $txid = str_repeat('a', 32);
        Staging::add($this->root, $txid, []);
        $dir = Staging::dir($this->root, $txid);
        touch($dir, time() - 40 * 86400); // aged past the 30-day retention
        clearstatcache();
        Staging::add($this->root, $txid, []); // resumed batch
        clearstatcache();
        $this->assertGreaterThan(time() - 60, filemtime($dir), 'resumed batch must refresh the prune clock');
    }
}
