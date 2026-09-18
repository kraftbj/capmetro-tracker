<?php

declare(strict_types=1);

namespace CapMetro\Tests\Support;

use PHPUnit\Framework\TestCase;

/**
 * Binds a test to runtime code, and skips with a reason when it is not there.
 *
 * The runtime lane exposes procedural cm_* functions from runtime/lib/. When a
 * function a test needs is missing, the skip message names it and the file it
 * was looked for in, so the gap reads as a to-do rather than a mystery.
 */
final class Runtime
{
    public static function root(): string
    {
        return dirname(__DIR__, 3);
    }

    /**
     * @param list<string> $functions
     * @param list<string> $files candidate files, for the skip message only
     */
    public static function functionsOrSkip(TestCase $test, array $functions, array $files): void
    {
        $missing = array_values(array_filter(
            $functions,
            static fn (string $fn): bool => !function_exists($fn)
        ));

        if ($missing === []) {
            return;
        }

        $present = array_values(array_filter(
            $files,
            static fn (string $rel): bool => is_file(self::root() . '/' . $rel)
        ));

        $test->markTestSkipped(sprintf(
            'not implemented yet: %s. Looked in %s (%s). See tests/NOTES.md.',
            implode(', ', $missing),
            implode(' or ', $files),
            $present === [] ? 'no such file' : implode(', ', $present) . ' present but defines no such function'
        ));
    }

    /** @param list<string> $relPaths */
    public static function dirOrSkip(TestCase $test, string $rel, string $why): string
    {
        $path = self::root() . '/' . ltrim($rel, '/');
        if (!is_dir($path)) {
            $test->markTestSkipped($why);
        }

        return $path;
    }

    /*
     * Skip unless one specific fixture FILE is present.
     *
     * dirOrSkip is the wrong guard for a directory that holds more than one capture. Both
     * differential pairs live in tests/fixtures/feeds-pb-differential/, and the trip updates
     * pair landed first, so a test guarding on the directory would see it exist and then fail
     * on its own missing file -- reporting a broken test where the honest answer is "that
     * capture has not been taken yet".
     */
    public static function fileOrSkip(TestCase $test, string $rel, string $why): string
    {
        $path = self::root() . '/' . ltrim($rel, '/');
        if (!is_file($path)) {
            $test->markTestSkipped($why);
        }

        return $path;
    }
}
