'use strict';

/**
 * One-off: re-processes every image already in the merchants' media libraries
 * the way uploads are processed now (modules/media/imageProcessing.js) —
 * turned upright, re-encoded in its own format, and stripped of EXIF / XMP /
 * IPTC; a GIF keeps its frames and only loses its comment and XMP blocks —
 * then writes it back under the SAME key, so every URL already pointing at it
 * keeps working. media_assets.size_bytes is updated to the new size.
 *
 * Dry run by default: it reads and processes, reports what it would change,
 * and writes nothing. Pass --apply to write.
 *
 *   node scripts/strip-media-exif.js                       # dry run, everything
 *   node scripts/strip-media-exif.js --apply               # do it
 *   node scripts/strip-media-exif.js --workspace <uuid>    # one store only
 *   node scripts/strip-media-exif.js --batch 25 --limit 200 --after <media id>
 *
 * --batch   rows read per page (default 50)
 * --limit   stop after this many rows (default: all)
 * --after   resume after this media_assets id (the last one a previous run printed)
 *
 * Runs against whatever database and storage src/config/env resolves
 * (DATABASE_URL / DB_*, STORAGE_PROVIDER and the R2_* variables) — on Railway,
 * in a shell of the backend service. Objects are served with
 * `Cache-Control: immutable`, so after --apply purge the CDN cache for the
 * media domain (R2_PUBLIC_URL) or browsers may keep the old copy for a while.
 * An image that cannot be decoded is reported and left as it is.
 */

const db = require('../src/db/models');
const { getStorage } = require('../src/modules/media/storage');
const { detectImage } = require('../src/modules/media/mediaService');
const { processMerchantImage, imageProcessingStatus } = require('../src/modules/media/imageProcessing');

function readArgs(argv) {
  const args = { apply: false, batch: 50, limit: Infinity, workspace: null, after: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--batch') args.batch = Math.max(1, Math.min(500, parseInt(argv[++i], 10) || 50));
    else if (a === '--limit') args.limit = Math.max(1, parseInt(argv[++i], 10) || Infinity);
    else if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--after') args.after = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const kb = (n) => `${Math.round(n / 1024)}KB`;

async function hasMetadata(buffer, mime) {
  if (mime === 'image/gif') return buffer.includes(Buffer.from([0x21, 0xfe])) || buffer.includes(Buffer.from('XMP DataXMP', 'latin1'));
  // eslint-disable-next-line global-require
  const sharp = require('sharp');
  const meta = await sharp(buffer).metadata();
  return Boolean(meta.exif || meta.xmp || meta.iptc || (meta.orientation && meta.orientation !== 1));
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const storage = getStorage();
  console.log(`[strip-media-exif] ${args.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
  console.log(`[strip-media-exif] image processing: ${imageProcessingStatus()}`);
  const { Op } = db.Sequelize;
  const where = { mimeType: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] };
  if (args.workspace) where.workspaceId = args.workspace;
  const total = await db.MediaAsset.count({ where });
  console.log(`[strip-media-exif] ${total} image(s) in scope`);

  const stats = { seen: 0, withMetadata: 0, written: 0, skipped: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 };
  let cursor = args.after;
  while (stats.seen < args.limit) {
    const page = await db.MediaAsset.findAll({
      where: cursor ? { ...where, id: { [Op.gt]: cursor } } : where,
      order: [['id', 'ASC']],
      limit: Math.min(args.batch, args.limit - stats.seen),
    });
    if (page.length === 0) break;
    for (const asset of page) {
      stats.seen += 1;
      cursor = asset.id;
      const label = `[${stats.seen}/${total}] ${asset.id} ${asset.path}`;
      try {
        const object = await storage.get(asset.path);
        if (!object) {
          stats.skipped += 1;
          console.log(`${label} — missing from storage, skipped`);
          continue;
        }
        const detected = detectImage(object.buffer);
        if (!detected) {
          stats.skipped += 1;
          console.log(`${label} — not a recognised image, skipped`);
          continue;
        }
        const dirty = await hasMetadata(object.buffer, detected.mime).catch(() => true);
        if (dirty) stats.withMetadata += 1;
        const processed = await processMerchantImage(object.buffer, detected);
        stats.bytesBefore += object.buffer.length;
        stats.bytesAfter += processed.length;
        const change = `${kb(object.buffer.length)} → ${kb(processed.length)}${dirty ? ' (metadata removed)' : ''}`;
        if (!args.apply) {
          console.log(`${label} — would write ${change}`);
          continue;
        }
        // Same key: split "/<workspaceId>/<file>" (r2) or "/uploads/<workspaceId>/<file>" (local).
        const parts = asset.path.replace(/^\/+/, '').replace(/^uploads\//, '').split('/');
        const filename = parts.pop();
        const workspaceId = parts.pop();
        await storage.put({ workspaceId, filename, buffer: processed, contentType: detected.mime });
        await asset.update({ sizeBytes: processed.length });
        stats.written += 1;
        console.log(`${label} — written ${change}`);
      } catch (err) {
        stats.failed += 1;
        console.log(`${label} — FAILED: ${err.message}`);
      }
    }
    console.log(`[strip-media-exif] progress: ${stats.seen}/${total} (last id ${cursor})`);
  }

  console.log(
    `[strip-media-exif] done: ${stats.seen} checked, ${stats.withMetadata} carried metadata, ` +
      `${args.apply ? `${stats.written} written` : 'nothing written (dry run)'}, ${stats.skipped} skipped, ${stats.failed} failed, ` +
      `${kb(stats.bytesBefore)} → ${kb(stats.bytesAfter)}`
  );
  if (!args.apply) console.log('[strip-media-exif] run again with --apply to write these changes.');
}

main()
  .catch((err) => {
    console.error(`[strip-media-exif] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
