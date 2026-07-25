<?php
use PHPUnit\Framework\TestCase;

if (!defined('FERRY_FALLBACK_TEST')) {
    define('FERRY_FALLBACK_TEST', true);
}
require_once __DIR__ . '/../../ferry-cli/assets/ferry-uploads-fallback.php';

final class FallbackScriptTest extends TestCase
{
    public function test_path_validation(): void
    {
        $this->assertTrue(ferry_fallback_valid_path('2026/07/photo.jpg'));
        $this->assertTrue(ferry_fallback_valid_path('fonts/custom.woff2'));
        $this->assertFalse(ferry_fallback_valid_path(''));
        $this->assertFalse(ferry_fallback_valid_path('/etc/passwd'));
        $this->assertFalse(ferry_fallback_valid_path('a/../b.jpg'));
        $this->assertFalse(ferry_fallback_valid_path('..'));
        $this->assertFalse(ferry_fallback_valid_path('a//b.jpg'));
        $this->assertFalse(ferry_fallback_valid_path('a\\b.jpg'));
        $this->assertFalse(ferry_fallback_valid_path("a.jpg\0x"));
        $this->assertFalse(ferry_fallback_valid_path('.htaccess'));
        $this->assertFalse(ferry_fallback_valid_path('2026/.hidden/x.jpg'));
        $this->assertFalse(ferry_fallback_valid_path('shell.php'));
        $this->assertFalse(ferry_fallback_valid_path('shell.PHP'));
        $this->assertFalse(ferry_fallback_valid_path('shell.php5'));
        $this->assertFalse(ferry_fallback_valid_path('x.phtml'));
        $this->assertFalse(ferry_fallback_valid_path('x.phar'));
        $this->assertFalse(ferry_fallback_valid_path('dir/'));
    }

    public function test_content_types(): void
    {
        $this->assertSame('image/jpeg', ferry_fallback_content_type('a/b.jpg'));
        $this->assertSame('image/jpeg', ferry_fallback_content_type('a/b.JPEG'));
        $this->assertSame('font/woff2', ferry_fallback_content_type('f.woff2'));
        $this->assertSame('image/svg+xml', ferry_fallback_content_type('i.svg'));
        $this->assertSame('application/pdf', ferry_fallback_content_type('d.pdf'));
        $this->assertSame('application/octet-stream', ferry_fallback_content_type('x.unknownext'));
    }

    public function test_remote_url_encodes_segments_but_keeps_slashes(): void
    {
        $this->assertSame(
            'https://prod.example/wp-content/uploads/2026/07/my%20file.jpg',
            ferry_fallback_remote_url('https://prod.example', '2026/07/my file.jpg')
        );
    }
}
