<?php
use Ferry\Paths;
use PHPUnit\Framework\TestCase;

final class PathsTest extends TestCase
{
    /** @var string */
    private $root;

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . '/ferry-paths-' . uniqid();
        mkdir($base . '/wp-content/themes/t', 0777, true);
        mkdir($base . '/wp-content/uploads/2026', 0777, true);
        mkdir($base . '/wp-content/plugins/ferry-connect', 0777, true);
        mkdir($base . '/wp-content/mu-plugins', 0777, true);
        mkdir($base . '/wp-content/uploads/.ferry-staging/x', 0777, true);
        file_put_contents($base . '/index.php', '<?php // ok');
        file_put_contents($base . '/wp-config.php', '<?php // secret');
        file_put_contents($base . '/wp-content/themes/t/style.css', 'body{}');
        file_put_contents($base . '/wp-content/uploads/2026/a.jpg', 'jpegbytes');
        // a directory whose target resolves outside $root - simulates a symlinked-out ancestor
        symlink(sys_get_temp_dir(), $base . '/wp-content/outside-link');
        $this->root = realpath($base);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    // ---- resolve_read: must stay IDENTICAL to today's /files + send_range behavior ----

    public function test_read_normal_path_resolves(): void
    {
        $this->assertSame('index.php', Paths::resolve_read($this->root, 'index.php'));
        $this->assertSame('wp-content/themes/t/style.css', Paths::resolve_read($this->root, 'wp-content/themes/t/style.css'));
    }

    public function test_read_traversal_is_rejected(): void
    {
        $this->assertNull(Paths::resolve_read($this->root, '../etc/passwd'));
        $this->assertNull(Paths::resolve_read($this->root, 'wp-content/../../etc/passwd'));
    }

    public function test_read_absolute_path_is_rejected(): void
    {
        $this->assertNull(Paths::resolve_read($this->root, '/etc/passwd'));
    }

    public function test_read_symlink_out_is_rejected(): void
    {
        $this->assertNull(Paths::resolve_read($this->root, 'wp-content/outside-link'));
    }

    public function test_read_excluded_file_is_rejected(): void
    {
        $this->assertNull(Paths::resolve_read($this->root, 'wp-config.php'));
    }

    public function test_read_nonexistent_path_is_rejected(): void
    {
        $this->assertNull(Paths::resolve_read($this->root, 'no-such-file.php'));
    }

    public function test_read_directory_target_is_rejected(): void
    {
        $this->assertNull(Paths::resolve_read($this->root, 'wp-content/themes/t'));
    }

    public function test_read_upload_allowed_via_explicit_fetch_escape_hatch(): void
    {
        // §2.8: uploads are excluded from the manifest walk, but an explicitly
        // requested path is still servable - resolve_read must preserve this.
        $this->assertSame('wp-content/uploads/2026/a.jpg', Paths::resolve_read($this->root, 'wp-content/uploads/2026/a.jpg'));
    }

    // ---- check_write: new write-side denylist ----

    /** @dataProvider deniedWritePaths */
    public function test_write_denied(string $path): void
    {
        $this->assertNotNull(Paths::check_write($this->root, $path), $path);
    }

    public function deniedWritePaths(): array
    {
        return [
            'wp-config.php exact'        => ['wp-config.php'],
            'wp-config.php.bak'          => ['wp-config.php.bak'],
            'WP-CONFIG-old.php (ci)'     => ['WP-CONFIG-old.php'],
            'ferry plugin self dir'      => ['wp-content/plugins/ferry-connect/ferry.php'],
            '.ferry-staging anywhere'    => ['wp-content/uploads/.ferry-staging/x/y.bin'],
            'mu-plugins ferry- prefix'   => ['wp-content/mu-plugins/ferry-overlay.php'],
            'uploads excluded on write'  => ['wp-content/uploads/2026/a.jpg'],
            'lexical traversal ..'       => ['../outside.php'],
            'embedded NUL byte'          => ["a.php\0.jpg"],
            'backslash separator'       => ['a\\b.php'],
            'leading slash (absolute)'   => ['/etc/passwd'],
        ];
    }

    public function test_write_denied_symlink_out_ancestor(): void
    {
        // The immediate parent directory doesn't exist yet, but the ancestor
        // one level up is itself a symlink resolving outside $root.
        $this->assertNotNull(Paths::check_write($this->root, 'wp-content/outside-link/new.php'));
    }

    public function test_write_allows_new_file_under_existing_dir(): void
    {
        // §Task brief note: check_write must NOT require the target to exist.
        $this->assertNull(Paths::check_write($this->root, 'wp-content/themes/t/functions.php'));
    }

    public function test_write_allows_new_file_under_new_nested_dirs(): void
    {
        // Neither "new-theme" nor "deep" exist - the nearest existing ancestor
        // (wp-content/themes) must still be walked up to and found under $root.
        $this->assertNull(Paths::check_write($this->root, 'wp-content/themes/new-theme/deep/file.php'));
    }

    // ---- review findings: denylist must run on the canonicalized path, and an
    // existing symlink LEAF must be containment-checked, not just its ancestor ----

    public function test_write_denied_dot_segment_alias_of_self_plugin_dir(): void
    {
        $this->assertNotNull(Paths::check_write($this->root, 'wp-content/plugins/./ferry-connect/backdoor.php'));
    }

    public function test_write_denied_doubled_slash_alias_of_self_plugin_dir(): void
    {
        $this->assertNotNull(Paths::check_write($this->root, 'wp-content//plugins/ferry-connect/backdoor.php'));
    }

    public function test_write_denied_mixed_case_self_plugin_dir(): void
    {
        $this->assertNotNull(Paths::check_write($this->root, 'Wp-Content/Plugins/Ferry-Connect/x.php'));
    }

    public function test_write_denied_dot_segment_alias_of_mu_plugins(): void
    {
        $this->assertNotNull(Paths::check_write($this->root, 'wp-content/mu-plugins/./ferry-overlay.php'));
    }

    public function test_write_denied_symlink_leaf_outside_root(): void
    {
        symlink('/etc/hosts', $this->root . '/wp-content/themes/t/evil-link.php');
        $this->assertNotNull(Paths::check_write($this->root, 'wp-content/themes/t/evil-link.php'));
    }
}
