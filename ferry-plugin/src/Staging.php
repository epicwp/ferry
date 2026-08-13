<?php
namespace Ferry;

/**
 * §8 (write endpoints): staging area for /stage. Uploaded file bytes land as
 * content-addressed blobs under a per-transaction directory - never at their
 * eventual target path, and never under an executable name - so a partial or
 * still-in-flight transaction can't be served or executed by anything.
 */
final class Staging
{
    public static function dir(string $root, string $txid): string
    {
        return $root . '/wp-content/uploads/.ferry-staging/' . $txid;
    }

    public static function backup_dir(string $root, string $txid): string
    {
        return $root . '/wp-content/uploads/.ferry-backup/' . $txid;
    }

    /** Locks a staging/backup dir down: no directory listing, no execution. */
    public static function protect(string $dir): void
    {
        file_put_contents($dir . '/index.php', "<?php // ferry staging — nothing to see\n");
        file_put_contents($dir . '/.htaccess', "Require all denied\n");
    }

    /**
     * @param array<int, array{path?:string, data_b64?:string, hash?:string}> $files
     * @return array{staged?: string[], rejected?: array<int, array{path:string, code:string}>, error?: string}
     */
    public static function add(string $root, string $txid, array $files): array
    {
        if (!preg_match('/\A[0-9a-f]{32}\z/', $txid)) {
            return ['error' => 'ferry_bad_txid'];
        }

        $dir = self::dir($root, $txid);
        if (!is_dir($dir . '/blobs')) {
            mkdir($dir . '/blobs', 0777, true);
        }
        self::protect($dir);

        $manifest_path = $dir . '/manifest.json';
        $manifest = is_file($manifest_path) ? json_decode((string) file_get_contents($manifest_path), true) : null;
        if (!is_array($manifest) || !isset($manifest['files']) || !is_array($manifest['files'])) {
            $manifest = ['files' => []];
        }

        $staged = [];
        $rejected = [];
        foreach ($files as $file) {
            $path = (string) ($file['path'] ?? '');
            if (Paths::check_write($root, $path) !== null) {
                $rejected[] = ['path' => $path, 'code' => 'denied_path'];
                continue;
            }
            $decoded = base64_decode((string) ($file['data_b64'] ?? ''), true);
            if ($decoded === false) {
                $rejected[] = ['path' => $path, 'code' => 'bad_base64'];
                continue;
            }
            $sha = hash('sha256', $decoded);
            if ($sha !== ($file['hash'] ?? '')) {
                $rejected[] = ['path' => $path, 'code' => 'bad_hash'];
                continue;
            }
            $blob_path = $dir . '/blobs/' . $sha . '.bin';
            if (!is_file($blob_path)) {
                file_put_contents($blob_path, $decoded);
            }
            $manifest['files'][$path] = ['blob' => $sha, 'hash' => $sha];
            $staged[] = $path;
        }

        file_put_contents($manifest_path, (string) json_encode($manifest));

        // Issue #9: refresh the prune clock on every batch — a multi-batch stage resumed
        // near the 30-day retention edge must not lose its directory mid-transaction.
        touch($dir);

        return ['staged' => $staged, 'rejected' => $rejected];
    }
}
