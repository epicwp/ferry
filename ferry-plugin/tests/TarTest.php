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

    public function test_path_with_no_early_slash_gets_longlink_instead_of_throwing(): void
    {
        // 160 'a's then a slash: the '/' falls outside the 156-byte prefix-split search
        // window, so the existing split logic can't find a valid split point even though
        // the final segment itself is short. This used to throw; the fix routes it
        // through GNU LongLink instead.
        $name = str_repeat('a', 160) . '/b.txt';
        [$out] = $this->extract(function (Tar $tar) use ($name) {
            $tar->add_file($name, 'x');
        });
        $b1 = substr($out, 0, 512);
        $this->assertSame('././@LongLink', rtrim(substr($b1, 0, 100), "\0"));
        $this->assertSame('L', $b1[156]);
        $b3 = substr($out, 1024, 512); // block2 is the longlink data (167 bytes -> 1 block)
        $this->assertSame(substr($name, 0, 100), rtrim(substr($b3, 0, 100), "\0"));
        $this->assertSame('0', $b3[156]);
        $this->assertSame('', rtrim(substr($b3, 345, 155), "\0"));
    }

    public function test_short_name_header_bytes_unchanged(): void
    {
        [$out] = $this->extract(function (Tar $tar) {
            $tar->add_file('dir/hello.txt', "hi\n", 1753351200, 0644);
        });
        $block = substr($out, 0, 512);
        $this->assertSame('dir/hello.txt', rtrim(substr($block, 0, 100), "\0"));
        $this->assertSame('', rtrim(substr($block, 345, 155), "\0"));
        $this->assertSame('0', $block[156]);
    }

    public function test_path_that_fits_via_prefix_split_does_not_emit_longlink(): void
    {
        $name = str_repeat('directory/', 12) . 'file.txt'; // 128 chars, final segment 8 bytes: fits via prefix
        [$out, $phar] = $this->extract(function (Tar $tar) use ($name) {
            $tar->add_file($name, 'deep');
        });
        $b1 = substr($out, 0, 512);
        $this->assertNotSame('././@LongLink', rtrim(substr($b1, 0, 100), "\0"));
        $this->assertSame('file.txt', rtrim(substr($b1, 0, 100), "\0"));
        $this->assertNotSame('', rtrim(substr($b1, 345, 155), "\0")); // prefix field carries the rest
        $this->assertSame('deep', file_get_contents($phar[$name]->getPathname()));
    }

    public function test_long_final_segment_emits_gnu_longlink(): void
    {
        // Root cause fixture: real WP path from a live fatal - 152 bytes total,
        // final filename segment 103 bytes (>100, the ustar name-field limit).
        $path = 'wp-content/plugins/elementor-pro/assets/js/notes/vendors-node_modules_radix-ui_react-alert-dialog_dist_index_module_js-node_modules_radix-ui_r-e4587e.js';
        $this->assertSame(152, strlen($path));
        $this->assertSame(103, strlen(basename($path)));

        [$out] = $this->extract(function (Tar $tar) use ($path) {
            $tar->add_file($path, 'js content', 1753351200);
        });

        // Block 1: the LongLink extension header.
        $b1 = substr($out, 0, 512);
        $this->assertSame('././@LongLink', rtrim(substr($b1, 0, 100), "\0"));
        $this->assertSame('L', $b1[156]);
        $expectedSize = strlen($path) + 1;
        $this->assertSame(sprintf('%011o', $expectedSize), substr($b1, 124, 11));

        // Block 2: the full path + NUL, padded to the next 512-byte boundary.
        $b2 = substr($out, 512, 512);
        $this->assertSame($path . "\0", substr($b2, 0, $expectedSize));
        $this->assertSame(str_repeat("\0", 512 - $expectedSize), substr($b2, $expectedSize));

        // Block 3: the real ustar header, name truncated to 100 bytes, prefix empty.
        $b3 = substr($out, 1024, 512);
        $this->assertSame(substr($path, 0, 100), rtrim(substr($b3, 0, 100), "\0"));
        $this->assertSame('0', $b3[156]);
        $this->assertSame('', rtrim(substr($b3, 345, 155), "\0"));

        // Block 4: the file content follows immediately.
        $this->assertSame('js content', substr($out, 1536, 10));
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
