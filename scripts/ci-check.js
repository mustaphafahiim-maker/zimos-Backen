'use strict';

/**
 * What CI runs for the backend (.github/workflows/ci.yml) — the JavaScript
 * counterpart of "typecheck and build":
 *
 *   1. every file under src/ and scripts/ parses (node --check);
 *   2. the whole app loads: every route file, model and jobs.js is required,
 *      so a missing module or a bad require fails here and not on deploy;
 *   3. docs/public-openapi.json is what scripts/build-public-openapi.js writes.
 *
 * It needs a migrated database only for nothing: models are defined, never
 * queried. Run it locally with `node scripts/ci-check.js`.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const problems = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 1. syntax
const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) problems.push(`syntax: ${path.relative(root, file)}\n${result.stderr.trim().split('\n').slice(0, 6).join('\n')}`);
}
console.log(`syntax: ${files.length} files checked`);

// 2. the app and the worker's registry load
if (problems.length === 0) {
  try {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    require(path.join(root, 'src', 'app.js'));
    const registry = require(path.join(root, 'src', 'core', 'queue', 'registry.js')).load();
    console.log(`load: app ok, ${registry.consumers.length} consumers, ${registry.processors.length} processors, ${registry.schedules.length} schedules`);
  } catch (err) {
    problems.push(`load: ${err.stack || err.message}`);
  }
}

// 3. the public OpenAPI file is up to date
try {
  const file = path.join(root, 'docs', 'public-openapi.json');
  const before = fs.readFileSync(file, 'utf8');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-public-openapi.js')], { encoding: 'utf8' });
  const after = fs.readFileSync(file, 'utf8');
  if (result.status !== 0) problems.push(`openapi: the generator failed\n${result.stderr}`);
  else if (before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n')) {
    fs.writeFileSync(file, before);
    problems.push('openapi: docs/public-openapi.json is stale — run `node scripts/build-public-openapi.js` and commit it');
  } else console.log('openapi: up to date');
} catch (err) {
  problems.push(`openapi: ${err.message}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n\n${problems.join('\n\n')}`);
  process.exit(1);
}
console.log('ok');
process.exit(0);
