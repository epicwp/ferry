<?php
namespace Ferry;

/**
 * Minimal ustar writer (§3.2): 512-byte headers, padded blocks, zero extensions.
 * ZipArchive needs a temp file and PharData is blocked on many hosts; this is
 * the ~60 lines that make streaming from shared hosting possible.
 */
final class Tar
{
    /** @var callable */
    private $write;

    public function __construct(callable $write)
    {
        $this->write = $write;
    }

    public function add_file(string $name, string $contents, int $mtime = 0, int $mode = 0644): void
    {
        $this->write_header($name, strlen($contents), $mtime, $mode);
        ($this->write)($contents);
        $this->pad(strlen($contents));
    }

    /** @param resource $fh */
    public function add_stream(string $name, $fh, int $size, int $mtime = 0, int $mode = 0644): void
    {
        $this->write_header($name, $size, $mtime, $mode);
        $sent = 0;
        while ($sent < $size && !feof($fh)) {
            $chunk = fread($fh, (int) min(512 * 1024, $size - $sent));
            if ($chunk === false || $chunk === '') {
                break;
            }
            ($this->write)($chunk);
            $sent += strlen($chunk);
        }
        if ($sent !== $size) {
            throw new \RuntimeException("short read for $name: $sent of $size bytes");
        }
        $this->pad($size);
    }

    public function finish(): void
    {
        ($this->write)(str_repeat("\0", 1024)); // two zero blocks = end of archive
    }

    private function pad(int $size): void
    {
        $pad = (512 - ($size % 512)) % 512;
        if ($pad > 0) {
            ($this->write)(str_repeat("\0", $pad));
        }
    }

    /**
     * Writes the header block(s) for one entry, emitting a GNU LongLink extension
     * first when $name doesn't fit the ustar name/prefix fields (§ GNU tar longname
     * extension: typeflag 'L', pseudo-name '././@LongLink', data = full path + NUL).
     * Readers that understand LongLink (incl. node-tar) use it instead of the
     * truncated name in the real header that follows.
     */
    private function write_header(string $name, int $size, int $mtime, int $mode): void
    {
        list($shortName, $prefix, $fits) = $this->split_name($name);
        if (!$fits) {
            $longpath = $name . "\0";
            ($this->write)($this->build_header('././@LongLink', strlen($longpath), 0, 0, '', 'L'));
            ($this->write)($longpath);
            $this->pad(strlen($longpath));
            $shortName = substr($name, 0, 100);
            $prefix = '';
        }
        ($this->write)($this->build_header($shortName, $size, $mtime, $mode, $prefix, '0'));
    }

    /**
     * Splits $name into the ustar name/prefix fields at a '/'. Returns
     * [name, prefix, fits]; when $fits is false, name/prefix are meaningless and
     * the caller must emit a LongLink extension instead.
     */
    private function split_name(string $name): array
    {
        if (strlen($name) <= 100) {
            return [$name, '', true];
        }
        $pos = strrpos(substr($name, 0, 156), '/');
        if ($pos === false || strlen($name) - $pos - 1 > 100) {
            return ['', '', false];
        }
        return [substr($name, $pos + 1), substr($name, 0, $pos), true];
    }

    private function build_header(string $name, int $size, int $mtime, int $mode, string $prefix, string $typeflag): string
    {
        $h  = str_pad($name, 100, "\0");
        $h .= sprintf("%07o\0", $mode);
        $h .= sprintf("%07o\0", 0);           // uid
        $h .= sprintf("%07o\0", 0);           // gid
        $h .= sprintf("%011o\0", $size);
        $h .= sprintf("%011o\0", $mtime);
        $h .= '        ';                     // chksum placeholder: 8 spaces
        $h .= $typeflag;
        $h .= str_repeat("\0", 100);          // linkname
        $h .= "ustar\0" . '00';               // magic + version
        $h .= str_repeat("\0", 32);           // uname
        $h .= str_repeat("\0", 32);           // gname
        $h .= sprintf("%07o\0", 0);           // devmajor
        $h .= sprintf("%07o\0", 0);           // devminor
        $h .= str_pad($prefix, 155, "\0");
        $h  = str_pad($h, 512, "\0");
        $sum = 0;
        for ($i = 0; $i < 512; $i++) {
            $sum += ord($h[$i]);
        }
        return substr_replace($h, sprintf("%06o\0 ", $sum), 148, 8);
    }
}
