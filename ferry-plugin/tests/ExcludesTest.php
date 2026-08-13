<?php
use Ferry\Excludes;
use PHPUnit\Framework\TestCase;

final class ExcludesTest extends TestCase
{
    /** @dataProvider excludedPaths */
    public function test_excluded(string $path): void
    {
        $this->assertTrue(Excludes::excluded($path), $path);
    }

    /** @dataProvider includedPaths */
    public function test_included(string $path): void
    {
        $this->assertFalse(Excludes::excluded($path), $path);
    }

    public function excludedPaths(): array
    {
        return [
            ['wp-content/uploads/2026/07/photo.jpg'],
            ['wp-content/uploads/'],
            ['wp-content/cache/page.html'],
            ['wp-content/cache/wp-rocket/site/index.html'],
            ['wp-content/updraft/backup.zip'],
            ['wp-content/ai1wm-backups/site.wpress'],
            ['wp-content/backups/db.sql'],
            ['wp-content/backups-dup-pro/archive.zip'],   // §3.1 "backups*/"
            ['wp-content/wp-rocket-config/site.php'],
            ['wp-content/ewww/image.jpg.bak'],
            ['wp-content/upgrade/plugin.tmp'],
            ['wp-content/upgrade-temp-backup/plugins/x/x.php'],
            ['wp-config.php'],                             // §4.4: never over the bridge
            ['wp-config.php.bak'],                         // security skim: backup copies carry DB creds
            ['wp-config-old.php'],
            ['wp-config.php~'],
            ['.wp-config.php.swp'],                        // editor swap file
            ['wp-content/debug.log'],
            ['error_log'],
            ['wp-admin/error_log'],                        // error_log appears in many directories
            ['wp-content/mu-plugins/ferry-overlay.php'],
            ['.ddev/config.yaml'],                         // §5: local dev tooling never travels
            ['.ddev/nginx/ferry-uploads.conf'],
        ];
    }

    public function test_ferry_mu_plugins_prefix_is_excluded(): void
    {
        $this->assertTrue(Excludes::excluded('wp-content/mu-plugins/ferry-overlay.php'));
        $this->assertTrue(Excludes::excluded('wp-content/mu-plugins/ferry-stubs.php'));
        $this->assertFalse(Excludes::excluded('wp-content/mu-plugins/loader.php'));
    }

    public function includedPaths(): array
    {
        return [
            ['wp-load.php'],
            ['index.php'],
            ['wp-content/themes/storefront/style.css'],
            ['wp-content/plugins/woocommerce/woocommerce.php'],
            ['wp-content/cachetest.php'],                  // prefix match must respect the slash
            ['wp-content/themes/storefront/config.php'],   // "config" alone is not "wp-config"
            ['wp-content/mu-plugins/loader.php'],
            ['wp-content/mu-plugins/other-plugin.php'],
        ];
    }

    public function test_allowed_upload(): void
    {
        $this->assertTrue(Excludes::allowed_upload('wp-content/uploads/2026/07/a.jpg'));
        $this->assertTrue(Excludes::allowed_upload('wp-content/uploads/2026/'));
        $this->assertFalse(Excludes::allowed_upload('wp-content/uploads/error_log'), 'logs stay blocked even under uploads');
        $this->assertFalse(Excludes::allowed_upload('wp-content/cache/x.jpg'));
        $this->assertFalse(Excludes::allowed_upload('wp-config.php'));
    }

    public function test_prefix_exclusions_are_case_insensitive(): void
    {
        $this->assertTrue(Excludes::excluded('WP-CONTENT/UPLOADS/photo.jpg'));
        $this->assertTrue(Excludes::excluded('Wp-Content/Cache/page.html'));
    }
}
