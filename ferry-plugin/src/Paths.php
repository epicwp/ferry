<?php
namespace Ferry;

/**
 * Shared path guard for the docroot-relative paths that travel over the
 * wire, both directions.
 *
 * §4/§2.8: read guard used by `Routes::files`/`send_range` - realpath
 * containment under $root plus the Excludes::excluded/allowed_upload
 * interplay, unchanged from before this extraction.
 *
 * §8 (write endpoints): write guard for /stage, /commit, /rollback targets.
 * The target need not exist yet (new files) - normalize lexically first,
 * then realpath-check the nearest EXISTING ancestor stays under $root,
 * then apply the write denylist: wp-config* (pattern, covers .bak copies),
 * the ferry plugin's own directory (self-update = auth bypass),
 * .ferry-staging/.ferry-backup (staging/backup internals), ferry's
 * mu-plugins overlay, and anything Excludes::excluded (uploads/caches/
 * backups never crossed the bridge in either direction).
 */
final class Paths
{
    /** Ferry's own plugin directory - hardcoded, not detected at runtime. */
    const SELF_PLUGIN_DIRS = [
        'wp-content/plugins/ferry-connect/', // packaged plugin slug
        'wp-content/plugins/ferry-plugin/',  // this repo's directory name
    ];

    public static function resolve_read(string $root, string $relpath): ?string
    {
        $abs = realpath($root . '/' . $relpath);
        if ($abs === false || strpos($abs, $root . DIRECTORY_SEPARATOR) !== 0) {
            return null;
        }
        $resolved_rel = str_replace(DIRECTORY_SEPARATOR, '/', substr($abs, strlen($root) + 1));
        if ((Excludes::excluded($resolved_rel) && !Excludes::allowed_upload($resolved_rel)) || !is_file($abs)) {
            return null;
        }
        return $resolved_rel;
    }

    public static function check_write(string $root, string $relpath): ?string
    {
        if (strpos($relpath, "\0") !== false || strpos($relpath, '\\') !== false || strpos($relpath, '/') === 0) {
            return 'denied_path';
        }

        // Canonicalize lexically before ANY denylist check runs: dot segments and
        // doubled separators must not let a protected path alias past a literal
        // prefix/substring match. ".." is rejected outright rather than resolved -
        // realpath isn't safe here since the target may not exist yet.
        $segments = [];
        foreach (explode('/', $relpath) as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }
            if ($segment === '..') {
                return 'denied_path';
            }
            $segments[] = $segment;
        }
        if ($segments === []) {
            return 'denied_path';
        }
        $normalized = implode('/', $segments);

        $abs = $root . '/' . $normalized;
        $existing = realpath($abs);
        if ($existing !== false) {
            // Target already exists (e.g. overwriting a theme file) - an existing
            // symlink LEAF pointing outside $root must be refused too, not just
            // its containing directory.
            if ($existing !== $root && strpos($existing, $root . DIRECTORY_SEPARATOR) !== 0) {
                return 'denied_path';
            }
        } else {
            $dir = dirname($abs);
            $resolved_dir = realpath($dir);
            while ($resolved_dir === false) {
                $parent = dirname($dir);
                if ($parent === $dir) {
                    return 'denied_path'; // walked to filesystem root without finding an existing ancestor
                }
                $dir = $parent;
                $resolved_dir = realpath($dir);
            }
            if ($resolved_dir !== $root && strpos($resolved_dir, $root . DIRECTORY_SEPARATOR) !== 0) {
                return 'denied_path';
            }
        }

        if (stripos(basename($normalized), 'wp-config') === 0) {
            return 'denied_path';
        }
        $normalized_lower = strtolower($normalized);
        foreach (self::SELF_PLUGIN_DIRS as $prefix) {
            if (strpos($normalized_lower, strtolower($prefix)) === 0) {
                return 'denied_path';
            }
        }
        if (strpos($normalized, '.ferry-staging') !== false || strpos($normalized, '.ferry-backup') !== false) {
            return 'denied_path';
        }
        if (strpos($normalized_lower, 'wp-content/mu-plugins/ferry-') === 0) {
            return 'denied_path';
        }
        if (Excludes::excluded($normalized)) {
            return 'denied_path';
        }

        return null;
    }
}
