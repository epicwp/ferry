<?php
namespace Ferry;

/**
 * Resumable file listing (§3.3 applied to §4.4's /manifest). The walk is
 * deterministic (sorted scandir), so "skip the first N entries" is a stable
 * resume cursor even across requests.
 */
final class Manifest
{
    /**
     * @return array{files: array<int, array{path: string, size: int, hash: ?string}>, next: int, complete: bool}
     */
    public static function batch(string $root, int $after, Budget $budget, int $cap = 5000): array
    {
        $root = rtrim($root, '/');
        $files = [];
        $index = 0;
        $complete = true;
        foreach (self::walk($root, '') as $entry) {
            if ($index++ < $after) {
                continue;
            }
            // Hash after the resume-cursor check: a resumed request must never
            // re-read bytes already delivered in earlier batches. @: an unreadable
            // file is a null hash (CLI fetches it), not a PHP warning in the response.
            $hash = @md5_file($root . '/' . $entry['path']);
            $entry['hash'] = $hash === false ? null : $hash;
            $files[] = $entry;
            if (count($files) >= $cap || $budget->exhausted()) {
                $complete = false;
                break;
            }
        }
        return ['files' => $files, 'next' => $after + count($files), 'complete' => $complete];
    }

    /** @return \Generator<array{path: string, size: int, hash: ?string}> */
    private static function walk(string $root, string $rel): \Generator
    {
        $abs = $rel === '' ? $root : $root . '/' . $rel;
        $names = scandir($abs, SCANDIR_SORT_ASCENDING);
        if ($names === false) {
            return;
        }
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $relpath = $rel === '' ? $name : $rel . '/' . $name;
            $abspath = $root . '/' . $relpath;
            if (is_link($abspath)) {
                continue;
            }
            if (is_dir($abspath)) {
                if (!Excludes::excluded($relpath . '/')) {
                    yield from self::walk($root, $relpath);
                }
            } elseif (is_file($abspath) && !Excludes::excluded($relpath)) {
                yield ['path' => $relpath, 'size' => (int) filesize($abspath), 'hash' => null];
            }
        }
    }
}
