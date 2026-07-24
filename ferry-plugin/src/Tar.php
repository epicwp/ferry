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
        ($this->write)($this->header($name, strlen($contents), $mtime, $mode));
        ($this->write)($contents);
        $this->pad(strlen($contents));
    }

    /** @param resource $fh */
    public function add_stream(string $name, $fh, int $size, int $mtime = 0, int $mode = 0644): void
    {
        ($this->write)($this->header($name, $size, $mtime, $mode));
        $sent = 0;
        while ($sent < $size && !feof($fh)) {
            $chunk = fread($fh, 512 * 1024);
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

    private function header(string $name, int $size, int $mtime, int $mode): string
    {
        $prefix = '';
        if (strlen($name) > 100) {
            $pos = strrpos(substr($name, 0, 155), '/');
            if ($pos === false || strlen($name) - $pos - 1 > 100) {
                throw new \RuntimeException("path does not fit ustar name/prefix fields: $name");
            }
            $prefix = substr($name, 0, $pos);
            $name = substr($name, $pos + 1);
        }
        $h  = str_pad($name, 100, "\0");
        $h .= sprintf("%07o\0", $mode);
        $h .= sprintf("%07o\0", 0);           // uid
        $h .= sprintf("%07o\0", 0);           // gid
        $h .= sprintf("%011o\0", $size);
        $h .= sprintf("%011o\0", $mtime);
        $h .= '        ';                     // chksum placeholder: 8 spaces
        $h .= '0';                            // typeflag: regular file
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
