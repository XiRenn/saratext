'use strict';

/**
 * Smoke test for the shell "Open with" argument pipeline.
 *
 * The bug this guards against is subtle: a path passed by Explorer arrives as
 * a *bare* argument in `process.argv`, sharing a list with Chromium's own
 * `--switch=value` entries. A naive `argv.includes('--flag')` test still works,
 * but a naive "every non-flag arg is a path" parse happily returns the value of
 * `--app-user-model-id` as a file. This asserts the separation both ways.
 *
 * The real `collectFileArgs` is extracted from main.js by source inspection -
 * importing main.js would boot Electron - so keep the two in sync if the
 * function is ever renamed.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(MAIN, 'utf8');

// --- pull the two declarations out of main.js verbatim ---------------------
const flagMatch = source.match(/const VALUE_FLAGS = new Set\(\[[\s\S]*?\]\);/);
const fnMatch = source.match(/function collectFileArgs\(argv\) \{[\s\S]*?\n\}/);

if (!flagMatch || !fnMatch) {
  console.error('FAIL: could not locate VALUE_FLAGS / collectFileArgs in main.js');
  process.exit(1);
}

// eslint-disable-next-line no-new-func
const collectFileArgs = new Function(
  `${flagMatch[0]}\n${fnMatch[0]}\nreturn collectFileArgs;`,
)();

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
    failures += 1;
  }
}

console.log('collectFileArgs:');

// A packaged launch with an inline switch plus a shell-supplied path.
check(
  'packaged: exe + path',
  collectFileArgs(['C:\\notes.txt']),
  ['C:\\notes.txt'],
);

check(
  'packaged: inline switch not mistaken for a path',
  collectFileArgs(['--app-user-model-id=com.whynot.saratext', 'C:\\notes.txt']),
  ['C:\\notes.txt'],
);

check(
  'packaged: separated switch value is consumed, not treated as a path',
  collectFileArgs(['--app-user-model-id', 'com.whynot.saratext', 'C:\\notes.txt']),
  ['C:\\notes.txt'],
);

check(
  'chromium switches are ignored entirely',
  collectFileArgs(['--type=gpu-process', '--user-data-dir=C:\\x', 'C:\\notes.txt']),
  ['C:\\notes.txt'],
);

check(
  'multiple files, spaces preserved',
  collectFileArgs(['D:\\a b\\x.log', 'D:\\a b\\y.log']),
  ['D:\\a b\\x.log', 'D:\\a b\\y.log'],
);

check(
  'dev launch (flags only) yields nothing',
  collectFileArgs(['--dev', '--force-gpu']),
  [],
);

check(
  'the software-gl marker is not a path',
  collectFileArgs(['--saratext-software-gl', 'C:\\notes.txt']),
  ['C:\\notes.txt'],
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
