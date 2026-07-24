<?php
use Ferry\Tar;
use PHPUnit\Framework\TestCase;

final class TarTest extends TestCase
{
    /** @return array{0: string, 1: \PharData} collected bytes + reopened archive */
    private function extract(callable $build): array
    {
        $out = '';
        $tar = new Tar(function (string $bytes) use (&$out) {
            $out .= $bytes;
        });
        $build($tar);
        $tar->finish();
        $file = tempnam(sys_get_temp_dir(), 'ferry') . '.tar';
        file_put_contents($file, $out);
        return [$out, new \PharData($file)];
    }

    public function test_single_file_roundtrip(): void
    {
        [$out, $phar] = $this->extract(function (Tar $tar) {
            $tar->add_file('dir/hello.txt', "hello world\n", 1753351200);
        });
        $this->assertSame(0, strlen($out) % 512, 'archive must be 512-byte aligned');
        $this->assertSame("hello world\n", file_get_contents($phar['dir/hello.txt']->getPathname()));
    }

    public function test_block_aligned_content_gets_no_extra_padding(): void
    {
        [, $phar] = $this->extract(function (Tar $tar) {
            $tar->add_file('exact.bin', str_repeat('x', 512));
            $tar->add_file('after.txt', 'still readable');
        });
        $this->assertSame(512, strlen(file_get_contents($phar['exact.bin']->getPathname())));
        $this->assertSame('still readable', file_get_contents($phar['after.txt']->getPathname()));
    }

    public function test_long_path_uses_ustar_prefix(): void
    {
        $name = str_repeat('directory/', 12) . 'file.txt'; // 128 chars, needs prefix split
        [, $phar] = $this->extract(function (Tar $tar) use ($name) {
            $tar->add_file($name, 'deep');
        });
        $this->assertSame('deep', file_get_contents($phar[$name]->getPathname()));
    }

    public function test_prefix_split_at_exact_155_boundary(): void
    {
        $name = str_repeat('a', 155) . '/' . str_repeat('b', 50); // slash at index 155: valid ustar split
        [, $phar] = $this->extract(function (Tar $tar) use ($name) {
            $tar->add_file($name, 'boundary');
        });
        $this->assertSame('boundary', file_get_contents($phar[$name]->getPathname()));
    }

    public function test_unsplittable_path_throws(): void
    {
        $this->expectException(\RuntimeException::class);
        $tar = new Tar(function () {});
        $tar->add_file(str_repeat('a', 160) . '/b.txt', 'x');
    }

    public function test_add_stream_roundtrip(): void
    {
        $src = tempnam(sys_get_temp_dir(), 'ferry');
        file_put_contents($src, str_repeat('AB', 650)); // 1300 bytes, crosses block boundary
        [, $phar] = $this->extract(function (Tar $tar) use ($src) {
            $fh = fopen($src, 'rb');
            $tar->add_stream('stream.bin', $fh, 1300);
            fclose($fh);
        });
        $this->assertSame(str_repeat('AB', 650), file_get_contents($phar['stream.bin']->getPathname()));
    }
}
