<?php
namespace Ferry;

/**
 * §8: the two-phase commit sequence and its rollback. Five reported steps -
 * hashes, drift, backup, swap, journal - implement the spec's six-step list
 * (its step 6 is the failure/reversal handling below, not a step of its own).
 * Renames are same-filesystem (staging/backup live under wp-content/uploads,
 * same volume as the rest of the docroot), so each individual rename is
 * atomic; the sequence as a whole is made all-or-nothing by reversing
 * completed renames on any later failure.
 */
final class Commit
{
    const MAX_FILES = 200;

    /**
     * @param array<int, array{path:string, new_hash:?string, old_hash:?string}> $files
     * @return array{committed:bool, steps:array, conflicts:array, apply_error?:array, error?:string}
     */
    public static function run(string $root, $wpdb, string $txid, array $files, array $ops, array $preconditions, bool $force): array
    {
        if (count($files) > self::MAX_FILES) {
            return ['committed' => false, 'steps' => [], 'conflicts' => [], 'error' => 'ferry_too_many_files'];
        }

        $stagingDir = Staging::dir($root, $txid);
        $backupDir = Staging::backup_dir($root, $txid);
        $steps = [];

        // Step 1: hashes - re-verify staged blobs against the manifest and the caller's new_hash.
        $t0 = microtime(true);
        [$hashesOk, $hashConflicts, $blobPaths] = self::verify_staged_blobs($stagingDir, $files);
        $steps[] = ['name' => 'hashes', 'ok' => $hashesOk, 'durationMs' => self::ms($t0)];
        if (!$hashesOk) {
            Tx::write($root, $txid, ['status' => 'conflict']);
            return ['committed' => false, 'steps' => $steps, 'conflicts' => $hashConflicts];
        }

        // Step 2: drift - each target's current content vs old_hash (null = must not exist),
        // plus any file_hash preconditions. Existence is recorded regardless of $force - needed
        // by the later steps and by rollback - only the compare itself is skipped under $force.
        $t0 = microtime(true);
        $fileState = [];
        $conflicts = [];
        foreach ($files as $f) {
            $path = (string) $f['path'];
            $oldHash = $f['old_hash'] ?? null;
            $newHash = $f['new_hash'] ?? null;
            $abs = $root . '/' . $path;
            $existed = is_file($abs);
            $current = $existed ? hash_file('sha256', $abs) : null;
            if (!$force && $current !== $oldHash) {
                $conflicts[] = ['key' => $path, 'expected' => $oldHash, 'found' => $current];
            }
            $fileState[$path] = ['existed' => $existed, 'new_hash' => $newHash];
        }
        foreach ($preconditions as $pre) {
            if (($pre['type'] ?? null) === 'file_hash') {
                $p = (string) $pre['path'];
                $abs = $root . '/' . $p;
                $current = is_file($abs) ? hash_file('sha256', $abs) : null;
                if (!$force && $current !== $pre['expected']) {
                    $conflicts[] = ['key' => $p, 'expected' => $pre['expected'], 'found' => $current];
                }
            }
        }
        $driftOk = $conflicts === [];
        $steps[] = ['name' => 'drift', 'ok' => $driftOk, 'durationMs' => self::ms($t0)];
        if (!$driftOk) {
            Tx::write($root, $txid, ['status' => 'conflict']);
            return ['committed' => false, 'steps' => $steps, 'conflicts' => $conflicts];
        }

        // Nothing mutates the filesystem before this point - safe to mark "committing" now.
        Tx::write($root, $txid, ['status' => 'committing']);

        // Step 3: backup - rename existing targets into backup/files/<relpath>.
        $t0 = microtime(true);
        $backedUp = [];
        $backupOk = true;
        foreach ($files as $f) {
            $path = (string) $f['path'];
            if (!$fileState[$path]['existed']) {
                continue;
            }
            $backupPath = $backupDir . '/files/' . $path;
            self::ensure_parent_dir($backupPath);
            if (!rename($root . '/' . $path, $backupPath)) {
                $backupOk = false;
                break;
            }
            $backedUp[] = $path;
        }
        $steps[] = ['name' => 'backup', 'ok' => $backupOk, 'durationMs' => self::ms($t0)];
        if (!$backupOk) {
            self::undo_backup($root, $backupDir, $backedUp);
            Tx::write($root, $txid, ['status' => 'conflict']);
            return ['committed' => false, 'steps' => $steps, 'conflicts' => []];
        }

        // Step 4: swap - rename staged blobs onto targets. Deletes (new_hash null) have no blob
        // to place - the backup rename above already achieved the deletion.
        $t0 = microtime(true);
        $swappedIn = [];
        $swapOk = true;
        foreach ($files as $f) {
            $path = (string) $f['path'];
            if ($fileState[$path]['new_hash'] === null) {
                continue;
            }
            $target = $root . '/' . $path;
            self::ensure_parent_dir($target);
            if (!rename($blobPaths[$path], $target)) {
                $swapOk = false;
                break;
            }
            $swappedIn[] = $path;
        }
        $steps[] = ['name' => 'swap', 'ok' => $swapOk, 'durationMs' => self::ms($t0)];
        if (!$swapOk) {
            self::undo_swap($root, $swappedIn, $blobPaths);
            self::undo_backup($root, $backupDir, $backedUp);
            Tx::write($root, $txid, ['status' => 'conflict']);
            return ['committed' => false, 'steps' => $steps, 'conflicts' => []];
        }

        // Step 5: journal - the DB transaction (spec §9, via DbOps).
        $t0 = microtime(true);
        $dbResult = DbOps::apply_in_transaction($wpdb, $ops, $preconditions, $wpdb->prefix, $force);
        $steps[] = ['name' => 'journal', 'ok' => $dbResult['committed'], 'durationMs' => self::ms($t0)];
        if (!$dbResult['committed']) {
            self::undo_swap($root, $swappedIn, $blobPaths);
            self::undo_backup($root, $backupDir, $backedUp);
            Tx::write($root, $txid, ['status' => 'conflict']);
            $response = ['committed' => false, 'steps' => $steps, 'conflicts' => $dbResult['conflicts']];
            if (isset($dbResult['apply_error'])) {
                $response['apply_error'] = $dbResult['apply_error'];
            }
            return $response;
        }

        // Success - record what was touched so /rollback can restore it later.
        Tx::write($root, $txid, [
            'status' => 'committed',
            'committed_at' => gmdate('c'),
            'files' => array_map(function ($f) use ($fileState) {
                $path = (string) $f['path'];
                return ['path' => $path, 'existed' => $fileState[$path]['existed'], 'new_hash' => $fileState[$path]['new_hash']];
            }, $files),
        ]);

        return ['committed' => true, 'steps' => $steps, 'conflicts' => []];
    }

    /**
     * `{txid, ops}` - ops are the inverse of what was pushed, with CAS expectations equal to
     * the pushed new values (DbOps's own read-set compare is the DB-side CAS). File-side CAS
     * (current target content vs what the push installed) is checked here, up front, against
     * the file list recorded by `run()` above - any mismatch refuses the whole rollback.
     *
     * @return array{rolled_back:bool, conflicts:array}
     */
    public static function rollback(string $root, $wpdb, string $txid, array $ops): array
    {
        $meta = Tx::read($root, $txid);
        $files = (is_array($meta) && isset($meta['files']) && is_array($meta['files'])) ? $meta['files'] : [];
        $backupDir = Staging::backup_dir($root, $txid);

        $conflicts = [];
        foreach ($files as $f) {
            $path = (string) $f['path'];
            $abs = $root . '/' . $path;
            $current = is_file($abs) ? hash_file('sha256', $abs) : null;
            if ($current !== $f['new_hash']) {
                $conflicts[] = ['key' => $path, 'expected' => $f['new_hash'], 'found' => $current];
            }
        }
        if ($conflicts !== []) {
            return ['rolled_back' => false, 'conflicts' => $conflicts];
        }

        $restored = [];  // existed=true: backup/files/<path> -> target
        $discarded = []; // existed=false: target -> backup/discarded/<path>
        foreach ($files as $f) {
            $path = (string) $f['path'];
            $abs = $root . '/' . $path;
            if ($f['existed']) {
                self::ensure_parent_dir($abs);
                rename($backupDir . '/files/' . $path, $abs);
                $restored[] = $path;
            } elseif (is_file($abs)) {
                $discardPath = $backupDir . '/discarded/' . $path;
                self::ensure_parent_dir($discardPath);
                rename($abs, $discardPath);
                $discarded[] = $path;
            }
        }

        $dbResult = DbOps::apply_in_transaction($wpdb, $ops, [], $wpdb->prefix, false);
        if (!$dbResult['committed']) {
            foreach (array_reverse($discarded) as $path) {
                rename($backupDir . '/discarded/' . $path, $root . '/' . $path);
            }
            foreach (array_reverse($restored) as $path) {
                rename($root . '/' . $path, $backupDir . '/files/' . $path);
            }
            return ['rolled_back' => false, 'conflicts' => $dbResult['conflicts']];
        }

        Tx::write($root, $txid, ['status' => 'rolled_back']);
        return ['rolled_back' => true, 'conflicts' => []];
    }

    /** @return array{0: bool, 1: array, 2: array<string,string>} [ok, conflicts, path => blob path] */
    private static function verify_staged_blobs(string $stagingDir, array $files): array
    {
        $manifestPath = $stagingDir . '/manifest.json';
        $manifest = is_file($manifestPath) ? json_decode((string) file_get_contents($manifestPath), true) : null;
        $manifestFiles = (is_array($manifest) && isset($manifest['files']) && is_array($manifest['files'])) ? $manifest['files'] : [];

        $ok = true;
        $conflicts = [];
        $blobPaths = [];
        foreach ($files as $f) {
            $path = (string) $f['path'];
            $newHash = $f['new_hash'] ?? null;
            if ($newHash === null) {
                continue; // delete: no staged blob involved
            }
            $entry = $manifestFiles[$path] ?? null;
            $blobPath = $entry ? $stagingDir . '/blobs/' . $entry['blob'] . '.bin' : null;
            $actual = ($blobPath !== null && is_file($blobPath)) ? hash_file('sha256', $blobPath) : null;
            if ($actual !== $newHash) {
                $ok = false;
                $conflicts[] = ['key' => $path, 'expected' => $newHash, 'found' => $actual];
                continue;
            }
            $blobPaths[$path] = $blobPath;
        }
        return [$ok, $conflicts, $blobPaths];
    }

    private static function ensure_parent_dir(string $path): void
    {
        $dir = dirname($path);
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
    }

    /** Undoes completed backup renames (target -> backup/files/<path>), most-recent first. */
    private static function undo_backup(string $root, string $backupDir, array $paths): void
    {
        foreach (array_reverse($paths) as $path) {
            rename($backupDir . '/files/' . $path, $root . '/' . $path);
        }
    }

    /** Undoes completed swap renames (blob -> target), most-recent first, restoring the blob. */
    private static function undo_swap(string $root, array $paths, array $blobPaths): void
    {
        foreach (array_reverse($paths) as $path) {
            rename($root . '/' . $path, $blobPaths[$path]);
        }
    }

    private static function ms(float $t0): float
    {
        return round((microtime(true) - $t0) * 1000, 3);
    }
}
