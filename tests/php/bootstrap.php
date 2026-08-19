<?php

declare(strict_types=1);

/*
 * PHPUnit bootstrap.
 *
 * Only runtime/lib/*.php is loaded. Those files are pure by design and safe to
 * require. runtime/generate-api.php and runtime/tools/* are entry points that
 * execute on include, so they are deliberately not loaded here; anything they
 * need to be tested for belongs in a library file.
 */

require_once __DIR__ . '/../../vendor/autoload.php';

require_once __DIR__ . '/Support/Runtime.php';
require_once __DIR__ . '/Support/Fixtures.php';

foreach (glob(__DIR__ . '/../../runtime/lib/*.php') ?: [] as $file) {
    require_once $file;
}
