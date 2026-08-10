<?php
namespace Ferry;

/**
 * §8: transaction status record (`meta.json` inside the backup dir) and
 * 30-day backup retention. Statuses: staged -> committing -> committed |
 * conflict | rolled_back, and committed -> rolling_back -> rolled_back |
 * committed (CAS/DB failure during rollback restores the prior status). A
 * record stuck at "committing" or "rolling_back" (the PHP process died
 * mid-operation, after the interim write but before the final one) reads
 * as "dirty" - the caller's remediation is rollback (retryable - see
 * Commit::rollback's idempotent CAS).
 */
final class Tx
{
    const RETENTION_SECONDS = 30 * 86400;
    const NON_TERMINAL_STATUSES = ['committing', 'rolling_back'];

    /** Atomic: writes to a temp file and renames onto meta.json, so a crash never leaves
     *  a truncated/partial read visible - readers see either the old content or the new. */
    public static function write(string $root, string $txid, array $meta): void
    {
        $dir = Staging::backup_dir($root, $txid);
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
        Staging::protect($dir);
        $tmp = $dir . '/meta.json.tmp';
        file_put_contents($tmp, (string) json_encode($meta));
        rename($tmp, $dir . '/meta.json');
    }

    /** @return array|null null when nothing at all is known about this txid. */
    public static function read(string $root, string $txid): ?array
    {
        $path = Staging::backup_dir($root, $txid) . '/meta.json';
        if (is_file($path)) {
            $meta = json_decode((string) file_get_contents($path), true);
            if (is_array($meta)) {
                if (in_array($meta['status'] ?? null, self::NON_TERMINAL_STATUSES, true)) {
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

    /** Deletes backup dirs older than 30 days - except a non-terminal tx (committing /
     *  rolling_back), which is never pruned mid-flight no matter how old it looks. Also walks
     *  the staging base (abandoned/never-committed transactions) on the same 30-day retention -
     *  staging dirs carry no meta.json, so age is the only signal there. */
    public static function prune(string $root, int $now): int
    {
        return self::prune_base(dirname(Staging::backup_dir($root, 'x')), $now, true)
            + self::prune_base(dirname(Staging::dir($root, 'x')), $now, false);
    }

    private static function prune_base(string $base, int $now, bool $checkMeta): int
    {
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
            if ($mtime === false || ($now - $mtime) <= self::RETENTION_SECONDS) {
                continue;
            }
            if ($checkMeta) {
                $metaPath = $dir . '/meta.json';
                if (is_file($metaPath)) {
                    $meta = json_decode((string) file_get_contents($metaPath), true);
                    $status = is_array($meta) ? ($meta['status'] ?? null) : null;
                    if (in_array($status, self::NON_TERMINAL_STATUSES, true)) {
                        continue;
                    }
                }
            }
            self::rrmdir($dir);
            $removed++;
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
