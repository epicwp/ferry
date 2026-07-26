<?php
namespace Ferry;

/**
 * §8: transaction status record (`meta.json` inside the backup dir) and
 * 30-day backup retention. Statuses: staged -> committing -> committed |
 * conflict | rolled_back. A record stuck at "committing" (the PHP process
 * died mid-commit, after the interim write but before the final one) reads
 * as "dirty" - the caller's remediation is rollback.
 */
final class Tx
{
    const RETENTION_SECONDS = 30 * 86400;

    public static function write(string $root, string $txid, array $meta): void
    {
        $dir = Staging::backup_dir($root, $txid);
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
        Staging::protect($dir);
        file_put_contents($dir . '/meta.json', (string) json_encode($meta));
    }

    /** @return array|null null when nothing at all is known about this txid. */
    public static function read(string $root, string $txid): ?array
    {
        $path = Staging::backup_dir($root, $txid) . '/meta.json';
        if (is_file($path)) {
            $meta = json_decode((string) file_get_contents($path), true);
            if (is_array($meta)) {
                if (($meta['status'] ?? null) === 'committing') {
                    $meta['status'] = 'dirty';
                }
                return $meta;
            }
        }
        if (is_dir(Staging::dir($root, $txid))) {
            return ['status' => 'staged'];
        }
        return null;
    }

    /** Deletes backup dirs older than 30 days. Returns the count removed. */
    public static function prune(string $root, int $now): int
    {
        $base = $root . '/wp-content/uploads/.ferry-backup';
        if (!is_dir($base)) {
            return 0;
        }
        $removed = 0;
        foreach (scandir($base) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $dir = $base . '/' . $entry;
            $mtime = filemtime($dir);
            if ($mtime !== false && ($now - $mtime) > self::RETENTION_SECONDS) {
                self::rrmdir($dir);
                $removed++;
            }
        }
        return $removed;
    }

    private static function rrmdir(string $dir): void
    {
        foreach (scandir($dir) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? self::rrmdir($path) : unlink($path);
        }
        rmdir($dir);
    }
}
