<?php
namespace Ferry;

/**
 * §2.14 provenance hints: which wp.org packages the CLI should try.
 * Hints only - the CLI verifies every file by hash; a lying Version
 * header costs bandwidth, never correctness.
 */
final class Hints
{
    /**
     * @param array<string, array<string, mixed>> $plugins get_plugins() output
     * @return array<int, array{file: string, version: string}>
     */
    public static function plugins(array $plugins): array
    {
        $out = [];
        foreach ($plugins as $file => $data) {
            $out[] = [
                'file'    => (string) $file,
                'version' => (string) (isset($data['Version']) ? $data['Version'] : ''),
            ];
        }
        return $out;
    }

    /**
     * @param array<string, string> $themes stylesheet => version
     * @return array<int, array{stylesheet: string, version: string}>
     */
    public static function themes(array $themes): array
    {
        $out = [];
        foreach ($themes as $stylesheet => $version) {
            $out[] = ['stylesheet' => (string) $stylesheet, 'version' => (string) $version];
        }
        return $out;
    }
}
