<?php
namespace Ferry;

/**
 * §2.5: /info carries ALL user-defined wp-config constants minus the denylist.
 * Names are read from wp-config.php via the tokenizer (never executed);
 * values are read from the live runtime via constant(), so computed defines
 * (getenv etc.) report what production actually runs with.
 */
final class Config
{
    const DENYLIST = [
        'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
        'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
        'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST',
    ];

    /** @return string[] define()d constant names, in source order, deduplicated */
    public static function names_from_source(string $php): array
    {
        $names = [];
        $tokens = token_get_all($php);
        $count = count($tokens);
        for ($i = 0; $i < $count; $i++) {
            $t = $tokens[$i];
            if (!is_array($t) || $t[0] !== T_STRING || strtolower($t[1]) !== 'define') {
                continue;
            }
            for ($j = $i + 1; $j < min($i + 4, $count); $j++) {
                $n = $tokens[$j];
                if (is_array($n) && $n[0] === T_CONSTANT_ENCAPSED_STRING) {
                    $names[] = trim($n[1], "\"'");
                    break;
                }
            }
        }
        return array_values(array_unique($names));
    }

    /** @return array<string, scalar|null> */
    public static function constants(): array
    {
        // WP also supports wp-config.php one level above ABSPATH.
        $candidates = [ABSPATH . 'wp-config.php', dirname(ABSPATH) . '/wp-config.php'];
        $out = [];
        foreach ($candidates as $path) {
            if (!is_readable($path)) {
                continue;
            }
            foreach (self::names_from_source((string) file_get_contents($path)) as $name) {
                if (in_array($name, self::DENYLIST, true) || !defined($name)) {
                    continue;
                }
                $value = constant($name);
                if (is_scalar($value) || $value === null) {
                    $out[$name] = $value;
                }
            }
            break;
        }
        return $out;
    }
}
