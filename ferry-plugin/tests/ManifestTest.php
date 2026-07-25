<?php
use Ferry\Budget;
use Ferry\Manifest;
use PHPUnit\Framework\TestCase;

final class ManifestTest extends TestCase
{
    /** @var string */
    private $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/ferry-manifest-' . uniqid();
        mkdir($this->root . '/wp-content/themes/t', 0777, true);
        mkdir($this->root . '/wp-content/uploads/2026', 0777, true);
        file_put_contents($this->root . '/index.php', '<?php // 14 bytes');
        file_put_contents($this->root . '/wp-config.php', '<?php // secret');
        file_put_contents($this->root . '/wp-content/themes/t/style.css', 'body{}');
        file_put_contents($this->root . '/wp-content/uploads/2026/skip.jpg', 'jpegbytes');
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    public function test_walk_is_sorted_and_applies_excludes(): void
    {
        $result = Manifest::batch($this->root, 0, new Budget(10.0));
        $paths = array_column($result['files'], 'path');
        $this->assertSame(['index.php', 'wp-content/themes/t/style.css'], $paths);
        $this->assertSame(6, $result['files'][1]['size']);
        $this->assertNull($result['files'][1]['hash']);
        $this->assertTrue($result['complete']);
        $this->assertSame(2, $result['next']);
    }

    public function test_resume_via_after_and_cap(): void
    {
        $first = Manifest::batch($this->root, 0, new Budget(10.0), 1);
        $this->assertFalse($first['complete']);
        $this->assertSame(1, $first['next']);
        $second = Manifest::batch($this->root, $first['next'], new Budget(10.0), 1);
        $all = array_merge(
            array_column($first['files'], 'path'),
            array_column($second['files'], 'path')
        );
        $this->assertSame(['index.php', 'wp-content/themes/t/style.css'], $all);
        $third = Manifest::batch($this->root, $second['next'], new Budget(10.0), 1);
        $this->assertSame([], $third['files']);
        $this->assertTrue($third['complete']);
    }

    public function test_exhausted_budget_still_makes_progress(): void
    {
        $result = Manifest::batch($this->root, 0, new Budget(0.0));
        $this->assertCount(1, $result['files'], 'must emit at least one entry per request');
        $this->assertFalse($result['complete']);
    }
}
