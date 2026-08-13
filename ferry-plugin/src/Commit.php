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
        // Typed-op validation up front: an unknown kind, a refused content table, or a bad
        // identifier refuses the WHOLE commit, before any step runs - never let it fall through
        // apply()'s switch (default case returns null, which reads as "applied").
        $opsDenied = DbOps::validate($ops, $wpdb->prefix)['refused'];
        if ($opsDenied !== []) {
            return ['committed' => false, 'steps' => [], 'conflicts' => [], 'denied' => $opsDenied];
        }

        if (count($files) > self::MAX_FILES) {
            return ['committed' => false, 'steps' => [], 'conflicts' => [], 'error' => 'ferry_too_many_files'];
        }

        // Path safety is not a drift/business-logic check - it is unconditional (force does
        // not touch it) and refuses the whole commit before any step runs: nothing renamed,
        // tx meta untouched (stays whatever it was - staged, or unknown).
        $denied = self::check_write_paths($root, $files);
        if ($denied !== []) {
            return ['committed' => false, 'steps' => [], 'conflicts' => [], 'denied' => $denied];
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
        // plus any file_hash preconditions. Existence/old_hash are recorded regardless of
        // $force - needed by the later steps and by rollback - only the compare itself is
        // skipped under $force. file_hash preconditions are READS, not write targets: the
        // read guard applies (not check_write) - an unreadable path (wp-config.php, an
        // excluded dir, a traversal attempt) never leaks its real hash back in the response,
        // it always drifts as the 'unreadable' sentinel instead.
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
            $fileState[$path] = ['existed' => $existed, 'old_hash' => $current, 'new_hash' => $newHash];
        }
        foreach ($preconditions as $pre) {
            if (($pre['type'] ?? null) === 'file_hash') {
                $p = (string) $pre['path'];
                $resolved = Paths::resolve_read($root, $p);
                $current = $resolved === null ? 'unreadable' : hash_file('sha256', $root . '/' . $resolved);
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
        // touch() guards against a concurrent prune reclaiming this (possibly near-30-day-old,
        // on a retried txid) backup dir while the rename phase below is still in flight.
        Tx::write($root, $txid, ['status' => 'committing']);
        touch($backupDir);

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
            if (!@rename($root . '/' . $path, $backupPath)) {
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
            if (!@rename($blobPaths[$path], $target)) {
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

        // Success - record what was touched so /rollback can restore it later. old_hash is
        // the ACTUAL pre-commit content hash (not the caller's claimed old_hash, which under
        // $force may not match reality) - it's what rollback compares against to recognize a
        // file it already restored on a retried, previously-interrupted rollback.
        Tx::write($root, $txid, [
            'status' => 'committed',
            'committed_at' => gmdate('c'),
            'files' => array_map(function ($f) use ($fileState) {
                $path = (string) $f['path'];
                return [
                    'path' => $path,
                    'existed' => $fileState[$path]['existed'],
                    'old_hash' => $fileState[$path]['old_hash'],
                    'new_hash' => $fileState[$path]['new_hash'],
                ];
            }, $files),
        ]);

        // Blobs are consumed by the swap rename above - the staging dir (manifest, any
        // leftover blobs) is no longer needed. Backup dir stays: rollback needs it.
        self::remove_dir($stagingDir);

        return ['committed' => true, 'steps' => $steps, 'conflicts' => []];
    }

    /**
     * `{txid, ops}` - ops are the inverse of what was pushed, with CAS expectations equal to
     * the pushed new values (DbOps's own read-set compare is the DB-side CAS). File-side CAS
     * (current target content vs what the push installed) is checked here, up front, against
     * the file list recorded by `run()` above - any mismatch refuses the whole rollback.
     *
     * No reversal on a mid-rollback failure, by design - unlike `run()`'s clear-then-fill
     * renames (backup-away, then swap-in onto a now-empty target), a restore/discard rename
     * here lands directly onto an OCCUPIED target: `rename()` is an atomic overwrite, so the
     * content it replaces is gone the instant it succeeds. There is no second copy to put
     * back - "reversing" a successful restore by renaming the target away again just leaves
     * the target with nothing at all. So on any failure (a rename fails, or the DB step
     * fails) this simply stops where it is, leaves whatever succeeded so far exactly as it
     * is, and leaves tx meta at `rolling_back` (reads as `dirty`) rather than writing a
     * terminal status - a retry is the only recovery path, and it is safe because of:
     *
     * Idempotent, three-way CAS per file, covering every state a partial attempt can leave
     * behind: (a) current content matches the pushed `new_hash` -> not yet restored, pending;
     * (b) matches the pre-push `old_hash` -> already settled (restored, or - for a created
     * file, `old_hash` is null and an absent target matches that - already discarded) ->
     * satisfied, skip; (c) anything else -> a genuine conflict, refuses the whole rollback.
     * A retry only ever acts on the files still in state (a), so it converges regardless of
     * how far a prior attempt got.
     *
     * @return array{rolled_back:bool, conflicts:array, denied?:array, apply_error?:array}
     */
    public static function rollback(string $root, $wpdb, string $txid, array $ops): array
    {
        $opsDenied = DbOps::validate($ops, $wpdb->prefix)['refused'];
        if ($opsDenied !== []) {
            return ['rolled_back' => false, 'conflicts' => [], 'denied' => $opsDenied];
        }

        $meta = Tx::read($root, $txid);
        if (!is_array($meta)) {
            $meta = [];
        }

        if (($meta['status'] ?? null) === 'rolled_back') {
            // Idempotency (issue #9): a fully-succeeded rollback must not re-run — the
            // inverse ops' CAS expectations no longer hold and would wedge this record
            // to rolling_back/dirty. Nothing to do is success.
            return ['rolled_back' => true, 'conflicts' => []];
        }

        $files = isset($meta['files']) && is_array($meta['files']) ? $meta['files'] : [];
        $backupDir = Staging::backup_dir($root, $txid);

        // Defense in depth: these paths were already write-validated during commit - re-verify
        // anyway, the same way and for the same reason `run()` does.
        $denied = self::check_write_paths($root, $files);
        if ($denied !== []) {
            return ['rolled_back' => false, 'conflicts' => [], 'denied' => $denied];
        }

        $conflicts = [];
        $pending = [];
        foreach ($files as $f) {
            $path = (string) $f['path'];
            $abs = $root . '/' . $path;
            $current = is_file($abs) ? hash_file('sha256', $abs) : null;
            if ($current === $f['new_hash']) {
                $pending[] = $f; // not yet restored - needs action
            } elseif ($current === $f['old_hash']) {
                continue; // already settled (restored, or discarded and absent) - satisfied
            } else {
                $conflicts[] = ['key' => $path, 'expected' => $f['new_hash'], 'found' => $current];
            }
        }
        if ($conflicts !== []) {
            return ['rolled_back' => false, 'conflicts' => $conflicts];
        }

        // touch() guards against a concurrent prune reclaiming this backup dir mid-restore.
        $meta['status'] = 'rolling_back';
        Tx::write($root, $txid, $meta);
        touch($backupDir);

        foreach ($pending as $f) {
            $path = (string) $f['path'];
            $abs = $root . '/' . $path;
            if ($f['existed']) {
                self::ensure_parent_dir($abs);
                if (!@rename($backupDir . '/files/' . $path, $abs)) {
                    // Stop here, untouched: meta stays "rolling_back" (dirty) - retry it.
                    return ['rolled_back' => false, 'conflicts' => [
                        ['key' => $path, 'expected' => 'restorable', 'found' => 'rename_failed'],
                    ]];
                }
            } elseif (is_file($abs)) {
                $discardPath = $backupDir . '/discarded/' . $path;
                self::ensure_parent_dir($discardPath);
                if (!@rename($abs, $discardPath)) {
                    return ['rolled_back' => false, 'conflicts' => [
                        ['key' => $path, 'expected' => 'restorable', 'found' => 'rename_failed'],
                    ]];
                }
            }
        }

        $dbResult = DbOps::apply_in_transaction($wpdb, $ops, [], $wpdb->prefix, false);
        if (!$dbResult['committed']) {
            // Files are already correctly restored - that was never wrong, so it stands.
            // Meta stays "rolling_back" (not reset to "committed"): a retry re-checks every
            // file (all satisfied now, nothing pending) and just re-attempts the DB step.
            $response = ['rolled_back' => false, 'conflicts' => $dbResult['conflicts']];
            if (isset($dbResult['apply_error'])) {
                $response['apply_error'] = $dbResult['apply_error'];
            }
            return $response;
        }

        $meta['status'] = 'rolled_back';
        Tx::write($root, $txid, $meta);
        return ['rolled_back' => true, 'conflicts' => []];
    }

    /** @return array<int, array{path:string, code:string}> */
    private static function check_write_paths(string $root, array $files): array
    {
        $denied = [];
        foreach ($files as $f) {
            $path = (string) ($f['path'] ?? '');
            $code = Paths::check_write($root, $path);
            if ($code !== null) {
                $denied[] = ['path' => $path, 'code' => $code];
            }
        }
        return $denied;
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
            @rename($backupDir . '/files/' . $path, $root . '/' . $path);
        }
    }

    /** Undoes completed swap renames (blob -> target), most-recent first, restoring the blob. */
    private static function undo_swap(string $root, array $paths, array $blobPaths): void
    {
        foreach (array_reverse($paths) as $path) {
            @rename($root . '/' . $path, $blobPaths[$path]);
        }
    }

    private static function ms(float $t0): float
    {
        return round((microtime(true) - $t0) * 1000, 3);
    }

    /** Recursive delete - used to remove a consumed staging dir after a successful commit. */
    private static function remove_dir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? self::remove_dir($path) : @unlink($path);
        }
        @rmdir($dir);
    }
}
