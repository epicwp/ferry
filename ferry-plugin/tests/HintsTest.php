<?php
use Ferry\Hints;
use PHPUnit\Framework\TestCase;

final class HintsTest extends TestCase
{
    public function test_plugins_maps_get_plugins_output(): void
    {
        $raw = [
            'akismet/akismet.php' => ['Name' => 'Akismet', 'Version' => '5.3.7'],
            'hello.php'           => ['Name' => 'Hello Dolly'], // no Version header
        ];
        $this->assertSame([
            ['file' => 'akismet/akismet.php', 'version' => '5.3.7'],
            ['file' => 'hello.php', 'version' => ''],
        ], Hints::plugins($raw));
    }

    public function test_themes_maps_stylesheet_version_pairs(): void
    {
        $this->assertSame(
            [['stylesheet' => 'twentytwentyfive', 'version' => '1.2']],
            Hints::themes(['twentytwentyfive' => '1.2'])
        );
    }
}
