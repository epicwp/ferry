<?php
use Ferry\Config;
use PHPUnit\Framework\TestCase;

final class ConfigTest extends TestCase
{
    public function test_extracts_define_names_without_executing(): void
    {
        $src = <<<'PHP'
<?php
define( 'DB_NAME', 'prod_db' );
define('WP_DEBUG', false);
define("WP_MEMORY_LIMIT", '256M');
define('DYNAMIC_ONE', getenv('SOME_VAR'));
if (!defined('WP_CACHE')) define('WP_CACHE', true);
define ( 'SPACED_OUT', 1 );
$noise = 'define'; // string literal, not a call
// define('COMMENTED_OUT', 1); -- tokenizer sees a comment, not a call
PHP;
        $this->assertSame(
            ['DB_NAME', 'WP_DEBUG', 'WP_MEMORY_LIMIT', 'DYNAMIC_ONE', 'WP_CACHE', 'SPACED_OUT'],
            Config::names_from_source($src)
        );
    }

    public function test_denylist_contains_exactly_salts_and_db_credentials(): void
    {
        $this->assertSame([
            'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
            'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
            'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST',
        ], Config::DENYLIST);
    }
}
