<?php
namespace Ferry;

final class Routes
{
    public static function register(): void
    {
        register_rest_route('ferry/v1', '/pair', [
            'methods'             => 'POST',
            'permission_callback' => '__return_true', // guarded by the single-use, short-lived code itself
            'callback'            => [self::class, 'pair'],
        ]);
        $signed = [
            ['GET',  '/info',      'info'],
            ['GET',  '/manifest',  'manifest'],
            ['POST', '/files',     'files'],
            ['GET',  '/db/tables', 'db_tables'],
            ['GET',  '/db',        'db_export'],
        ];
        foreach ($signed as $r) {
            register_rest_route('ferry/v1', $r[1], [
                'methods'             => $r[0],
                'permission_callback' => [self::class, 'authorize'],
                'callback'            => [self::class, $r[2]],
            ]);
        }
    }

    /** @return true|\WP_Error */
    public static function authorize(\WP_REST_Request $request)
    {
        $secret = get_option('ferry_secret');
        if (!$secret) {
            return new \WP_Error('ferry_unpaired', 'This site is not paired yet. Activate the plugin and pair with the code it shows.', ['status' => 403]);
        }
        $nonce = $request->get_header('X-Ferry-Nonce');
        $ok = Auth::verify(
            $secret,
            $request->get_method(),
            $request->get_route(),
            $request->get_query_params(),
            $request->get_body(),
            $request->get_header('X-Ferry-Timestamp'),
            $request->get_header('X-Ferry-Signature'),
            $nonce,
            time()
        );
        if (!$ok) {
            return new \WP_Error('ferry_bad_signature', 'Invalid or expired request signature.', ['status' => 401]);
        }
        global $wpdb;
        if (!Nonces::consume($wpdb, $wpdb->prefix, (string) $nonce, time())) {
            return new \WP_Error('ferry_replay', 'Request nonce already used or invalid.', ['status' => 401]);
        }
        return true;
    }

    public static function pair(\WP_REST_Request $request)
    {
        if (is_multisite()) {
            return new \WP_Error('ferry_multisite', 'Multisite is not supported. Ferry refuses multisite installs by design.', ['status' => 409]);
        }
        $secret = Auth::complete_pairing((string) $request->get_param('code'));
        if ($secret === null) {
            return new \WP_Error('ferry_bad_code', 'Invalid or expired pairing code.', ['status' => 403]);
        }
        return ['secret' => $secret, 'siteurl' => get_option('siteurl')];
    }

    public static function info()
    {
        global $wpdb, $wp_version;
        return [
            'wp'  => $wp_version,
            'php' => [
                'version'    => PHP_VERSION,
                'extensions' => get_loaded_extensions(),
                'ini'        => [
                    'memory_limit'        => (string) ini_get('memory_limit'),
                    'max_execution_time'  => (int) ini_get('max_execution_time'),
                    'post_max_size'       => (string) ini_get('post_max_size'),
                    'upload_max_filesize' => (string) ini_get('upload_max_filesize'),
                    'max_input_vars'      => (int) ini_get('max_input_vars'),
                ],
            ],
            'db' => [
                'server'    => (stripos($wpdb->db_server_info(), 'mariadb') !== false) ? 'mariadb' : 'mysql',
                'version'   => $wpdb->db_version(),
                'charset'   => $wpdb->charset,
                'collation' => $wpdb->collate,
                'bytes'     => (int) $wpdb->get_var($wpdb->prepare(
                    'SELECT SUM(data_length + index_length) FROM information_schema.TABLES WHERE table_schema = %s',
                    DB_NAME
                )),
            ],
            'server'    => (stripos(isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : '', 'nginx') !== false) ? 'nginx' : 'apache',
            'constants' => Config::constants(),
            'multisite' => is_multisite(),
            'prefix'    => $wpdb->prefix,
            'abspath'   => ABSPATH,
            'siteurl'   => get_option('siteurl'),
            'locale'    => get_locale(),
            'plugins'   => Hints::plugins(self::installed_plugins()),
            'themes'    => Hints::themes(self::installed_themes()),
        ];
    }

    public static function manifest(\WP_REST_Request $request)
    {
        $scope = (string) $request->get_param('scope');
        if ($scope !== '' && $scope !== 'uploads') {
            return new \WP_Error('ferry_bad_scope', 'Unknown manifest scope.', ['status' => 400]);
        }
        $prefix = (string) $request->get_param('prefix');
        if ($prefix !== '' && preg_match('#(^/)|(\\\\)|(\.\.)|(\x00)#', $prefix)) {
            return new \WP_Error('ferry_bad_prefix', 'Invalid manifest prefix.', ['status' => 400]);
        }
        $after = max(0, (int) $request->get_param('after'));
        $result = Manifest::batch(untrailingslashit(ABSPATH), $after, new Budget(), 5000, $scope, $prefix);
        $response = new \WP_REST_Response(['files' => $result['files']]);
        $response->header('X-Complete', $result['complete'] ? '1' : '0');
        $response->header('X-Next-Index', (string) $result['next']);
        return $response;
    }

    /** Streams tar.gz; resume state travels in-band as the final .ferry-meta.json entry. */
    public static function files(\WP_REST_Request $request)
    {
        $params = $request->get_json_params();
        if (isset($params['path'], $params['offset'], $params['length'])) {
            self::send_range((string) $params['path'], (int) $params['offset'], (int) $params['length']);
        }
        $paths = (isset($params['paths']) && is_array($params['paths'])) ? $params['paths'] : [];
        $root = realpath(untrailingslashit(ABSPATH));
        $budget = new Budget();
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/gzip');
        $deflate = deflate_init(ZLIB_ENCODING_GZIP);
        $write = function (string $bytes) use ($deflate) {
            echo deflate_add($deflate, $bytes, ZLIB_NO_FLUSH);
        };
        $tar = new Tar($write);
        $done = 0;
        $skipped = [];
        foreach ($paths as $relpath) {
            if ($budget->exhausted()) {
                break;
            }
            $relpath = (string) $relpath;
            $abs = realpath($root . '/' . $relpath);
            if ($abs === false || strpos($abs, $root . DIRECTORY_SEPARATOR) !== 0) {
                $skipped[] = $relpath;
                $done++;
                continue;
            }
            $resolved_rel = str_replace(DIRECTORY_SEPARATOR, '/', substr($abs, strlen($root) + 1));
            if ((Excludes::excluded($resolved_rel) && !Excludes::allowed_upload($resolved_rel)) || !is_file($abs)) {
                $skipped[] = $relpath;
                $done++;
                continue;
            }
            $fh = fopen($abs, 'rb');
            if ($fh === false) {
                $skipped[] = $relpath;
                $done++;
                continue;
            }
            // If the file shrinks between fopen and read, add_stream throws mid-entry and the tar
            // (including its meta trailer) is truncated — the CLI fails loudly on the missing trailer
            // and the pull retries; accepted for v0.
            $tar->add_stream($relpath, $fh, (int) filesize($abs), (int) filemtime($abs));
            fclose($fh);
            $done++;
        }
        $tar->add_file('.ferry-meta.json', (string) json_encode([
            'complete'   => $done >= count($paths),
            'next_index' => $done,
            'skipped'    => $skipped,
        ]));
        $tar->finish();
        echo deflate_add($deflate, '', ZLIB_FINISH);
        exit;
    }

    /** §3.4: byte-range mode for single files larger than a batch. Raw bytes, no tar. */
    private static function send_range(string $relpath, int $offset, int $length): void
    {
        $offset = max(0, $offset);
        $length = max(0, $length);
        $root = realpath(untrailingslashit(ABSPATH));
        $abs = realpath($root . '/' . $relpath);
        if ($abs === false || strpos($abs, $root . DIRECTORY_SEPARATOR) !== 0) {
            status_header(404);
            exit;
        }
        $resolved_rel = str_replace(DIRECTORY_SEPARATOR, '/', substr($abs, strlen($root) + 1));
        if ((Excludes::excluded($resolved_rel) && !Excludes::allowed_upload($resolved_rel)) || !is_file($abs)) {
            status_header(404);
            exit;
        }
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/octet-stream');
        $fh = fopen($abs, 'rb');
        fseek($fh, $offset);
        $remaining = $length;
        while ($remaining > 0 && !feof($fh)) {
            $chunk = fread($fh, min(512 * 1024, $remaining));
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            $remaining -= strlen($chunk);
        }
        fclose($fh);
        exit;
    }

    public static function db_tables()
    {
        global $wpdb;
        return ['tables' => Db::tables($wpdb)];
    }

    public static function db_export(\WP_REST_Request $request)
    {
        global $wpdb;
        $table = (string) $request->get_param('table');
        if (!in_array($table, $wpdb->get_col('SHOW TABLES'), true)) {
            return new \WP_Error('ferry_unknown_table', 'Unknown table.', ['status' => 404]);
        }
        $skip = DbExcludes::parse($request->get_param('skip'));
        $unknown = DbExcludes::unknown($skip);
        if ($unknown !== []) {
            return new \WP_Error('ferry_unknown_skip', 'Unknown skip rule(s): ' . implode(', ', $unknown) . '. The CLI is newer than this plugin - update the Ferry Connect plugin on the site.', ['status' => 400]);
        }
        $after = max(0, (int) $request->get_param('after'));
        $before = $request->get_param('before') !== null ? (int) $request->get_param('before') : null;
        $filter = DbExcludes::plan($table, $wpdb->prefix, $skip);
        $result = Db::export($wpdb, $table, Db::single_pk($wpdb, $table), $after, $before, new Budget(), Db::CHUNK_ROWS, Db::BYTE_BUDGET, $filter);
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/gzip');
        header('X-Complete: ' . ($result['complete'] ? '1' : '0'));
        header('X-Last-Key: ' . $result['last_key']);
        header('X-Ferry-Skip: ' . implode(',', $skip));
        echo gzencode($result['sql'], 6);
        exit;
    }

    /** @return array<string, array<string, mixed>> */
    private static function installed_plugins(): array
    {
        if (!function_exists('get_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        return get_plugins();
    }

    /** @return array<string, string> stylesheet => version */
    private static function installed_themes(): array
    {
        $out = [];
        foreach (wp_get_themes() as $stylesheet => $theme) {
            $out[$stylesheet] = (string) $theme->get('Version');
        }
        return $out;
    }
}
