'use strict';

// scripts/strip-media-exif.js against local storage and the test database:
// a dry run changes nothing, --apply rewrites the file under the same path
// without its metadata and records the new size.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { setupWorkspaceWithProduct } = require('../helpers/factories');
const { SECRET, jpegWithExif } = require('../helpers/images');
const db = require('../../src/db/models');
const { UPLOAD_ROOT } = require('../../src/modules/media/storage/localStorage');

const SCRIPT = path.join(__dirname, '../../scripts/strip-media-exif.js');

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
  });
}

afterAll(() => {
  try {
    for (const entry of fs.readdirSync(UPLOAD_ROOT)) {
      if (entry !== '.gitkeep') fs.rmSync(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true });
    }
  } catch {
    /* nothing written */
  }
});

it('reports in a dry run and rewrites only with --apply', async () => {
  const { workspace } = await setupWorkspaceWithProduct();
  // An image uploaded before processing existed: stored with its EXIF.
  const original = await jpegWithExif();
  const relative = `/uploads/${workspace.id}/legacy-photo.jpg`;
  const file = path.join(UPLOAD_ROOT, workspace.id, 'legacy-photo.jpg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, original);
  const asset = await db.MediaAsset.create({
    workspaceId: workspace.id,
    url: `http://localhost:4000${relative}`,
    path: relative,
    mimeType: 'image/jpeg',
    sizeBytes: original.length,
  });

  const dry = run(['--workspace', workspace.id]);
  expect(dry).toMatch(/DRY RUN/);
  expect(dry).toMatch(/would write .*\(metadata removed\)/);
  expect(fs.readFileSync(file).equals(original)).toBe(true);

  const applied = run(['--apply', '--workspace', workspace.id, '--batch', '10']);
  expect(applied).toMatch(/1 written/);
  const rewritten = fs.readFileSync(file);
  expect(rewritten.includes(Buffer.from(SECRET))).toBe(false);
  expect((await sharp(rewritten).metadata()).exif).toBeUndefined();
  await asset.reload();
  expect(asset.sizeBytes).toBe(rewritten.length);
});
