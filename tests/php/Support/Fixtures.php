<?php

declare(strict_types=1);

namespace CapMetro\Tests\Support;

/**
 * Fixture access. Every test input is a committed file; nothing hits the network.
 */
final class Fixtures
{
    public static function dir(string $sub = ''): string
    {
        return rtrim(Runtime::root() . '/tests/fixtures/' . $sub, '/');
    }

    public static function text(string $rel): string
    {
        $path = self::dir() . '/' . $rel;
        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException("cannot read fixture {$rel}");
        }

        return $raw;
    }

    /** @return array<mixed> */
    public static function json(string $rel): array
    {
        return json_decode(self::text($rel), true, 512, JSON_THROW_ON_ERROR);
    }

    /** @return array<mixed> */
    public static function feed(string $name): array
    {
        return self::json("feeds-20260819/{$name}");
    }

    /** @return array<mixed> */
    public static function synthetic(string $name): array
    {
        return self::json("synthetic/{$name}");
    }

    /** @return array<mixed> */
    public static function goldenRoute4(): array
    {
        return self::json('golden/route-4-20260819.json');
    }

    /** Where the runtime job writes. Absent until that lane lands. */
    public static function webroot(): string
    {
        return getenv('CAPMETRO_WEBROOT') ?: Runtime::root() . '/webroot';
    }

    /** @return list<string> every generated JSON file under the webroot */
    public static function generatedFiles(): array
    {
        $api = self::webroot() . '/api';
        if (!is_dir($api)) {
            return [];
        }

        $out = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($api, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if ($file->isFile() && str_ends_with($file->getFilename(), '.json')) {
                $out[] = $file->getPathname();
            }
        }
        sort($out);

        return $out;
    }
}
