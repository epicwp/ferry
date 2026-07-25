<?php
/**
 * Ferry uploads fallback (§2.8 v0.2) - materialize-on-first-request.
 * Copied into the clone docroot by the CLI (origin token substituted); routed to
 * by nginx/apache when a file under wp-content/uploads/ is missing. Standalone by
 * design: WordPress never loads, so the harness (which governs WP's outbound
 * HTTP) does not apply - this fetch targets the customer's own public uploads.
 * The clone holds no pairing secret; this is a plain public GET.
 * Serving from the clone's own origin is what makes fonts work (no CORS).
 */

define('FERRY_UPLOADS_CAP_BYTES', 50 * 1024 * 1024); // bigger files 302 to production instead of buffering

/** Path must stay under uploads/: no traversal, no dot-segments, never PHP. */
function ferry_fallback_valid_path($rel)
{
    if (!is_string($rel) || $rel === '' || strpos($rel, "\0") !== false || strpos($rel, '\\') !== false) {
        return false;
    }
    if (preg_match('/\.(php\d*|phtml|phar)$/i', $rel)) {
        return false;
    }
    foreach (explode('/', $rel) as $seg) {
        if ($seg === '' || $seg[0] === '.') {
            return false;
        }
    }
    return true;
}

function ferry_fallback_content_type($rel)
{
    $map = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
        'gif' => 'image/gif', 'webp' => 'image/webp', 'avif' => 'image/avif',
        'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
        'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
        'otf' => 'font/otf', 'eot' => 'application/vnd.ms-fontobject',
        'css' => 'text/css', 'js' => 'application/javascript', 'json' => 'application/json',
        'pdf' => 'application/pdf', 'zip' => 'application/zip', 'txt' => 'text/plain',
        'mp3' => 'audio/mpeg', 'mp4' => 'video/mp4', 'webm' => 'video/webm',
    ];
    $ext = strtolower((string) pathinfo($rel, PATHINFO_EXTENSION));
    return isset($map[$ext]) ? $map[$ext] : 'application/octet-stream';
}

function ferry_fallback_remote_url($origin, $rel)
{
    return $origin . '/wp-content/uploads/' . implode('/', array_map('rawurlencode', explode('/', $rel)));
}

/** True if a raw response header line is a Content-Length that exceeds $cap. Lets the
 *  transfer be aborted from the header callback, before any body bytes are buffered. */
function ferry_fallback_content_length_too_big($header, $cap)
{
    if (preg_match('/^content-length:\s*(\d+)/i', trim($header), $m)) {
        return (int) $m[1] > $cap;
    }
    return false;
}

if (defined('FERRY_FALLBACK_TEST')) {
    return; // loaded for unit tests: definitions only
}

$origin = '__FERRY_PROD_ORIGIN__'; // substituted by the CLI at copy time
$rel = isset($_GET['path']) ? (string) $_GET['path'] : ''; // PHP has already urldecoded
if (!ferry_fallback_valid_path($rel)) {
    http_response_code(404);
    exit;
}
$dest = __DIR__ . '/wp-content/uploads/' . $rel;
$remote = ferry_fallback_remote_url($origin, $rel);
if (!is_file($dest)) {
    $dir = dirname($dest);
    // @-suppressed + is_dir() re-check: concurrent first-loads of the same new
    // directory must degrade to the 302 floor, not a "File exists" warning in the response.
    if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
        header('Location: ' . $remote, true, 302);
        exit;
    }
    $tmp = $dest . '.ferry-tmp-' . getmypid();
    $out = fopen($tmp, 'wb');
    if ($out === false) {
        header('Location: ' . $remote, true, 302);
        exit;
    }
    $too_big = false;
    $bytes = 0;
    $ch = curl_init($remote);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 120,
        CURLOPT_HEADERFUNCTION => function ($ch, $header) use (&$too_big) {
            if (ferry_fallback_content_length_too_big($header, FERRY_UPLOADS_CAP_BYTES)) {
                $too_big = true;
                return 0; // any length mismatch aborts the transfer before the body lands
            }
            return strlen($header);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, $data) use ($out, &$too_big, &$bytes) {
            $bytes += strlen($data);
            if ($bytes > FERRY_UPLOADS_CAP_BYTES) {
                $too_big = true;
                return 0; // aborts the transfer: backstop for chunked/missing Content-Length
            }
            return fwrite($out, $data);
        },
    ]);
    $ok = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    fclose($out);
    if ($ok === false || $too_big || $code !== 200) {
        @unlink($tmp);
        header('Location: ' . $remote, true, 302); // today's behavior is the floor
        exit;
    }
    rename($tmp, $dest);
}
header('Content-Type: ' . ferry_fallback_content_type($rel));
header('Content-Length: ' . (string) filesize($dest));
readfile($dest);
