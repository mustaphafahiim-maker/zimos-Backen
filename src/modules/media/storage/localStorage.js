'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../config/env');

// public/uploads at the project root — served statically by app.js at /uploads.
const UPLOAD_ROOT = path.resolve(__dirname, '../../../../public/uploads');
// Shoppers' photos: deliberately outside public/, so nothing serves them.
const PRIVATE_ROOT = path.resolve(__dirname, '../../../../storage/private');

function privateTarget(key) {
  const target = path.resolve(PRIVATE_ROOT, String(key).replace(/^\/+/, ''));
  if (!target.startsWith(PRIVATE_ROOT + path.sep)) throw new Error(`Refusing a path outside the private root: ${key}`);
  return target;
}

async function putPrivate({ key, buffer }) {
  const target = privateTarget(key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, buffer);
  return { path: key };
}

/** The object's bytes, or null when it is gone. The type is the caller's (the row's). */
async function getPrivate(key) {
  try {
    return { buffer: await fs.promises.readFile(privateTarget(key)), contentType: null };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function removePrivate(key) {
  try {
    await fs.promises.unlink(privateTarget(key));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function put({ workspaceId, filename, buffer }) {
  const dir = path.join(UPLOAD_ROOT, workspaceId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, filename), buffer);

  const relPath = `/uploads/${workspaceId}/${filename}`;
  return {
    url: `${env.appUrl.replace(/\/$/, '')}${relPath}`,
    path: relPath,
  };
}

/**
 * Deletes one stored object by the `path` put() returned. The caller treats a
 * failure as non-fatal, so this may throw freely (a missing file included —
 * the library row is what the merchant asked us to remove).
 */
async function remove(storagePath) {
  const relative = String(storagePath).replace(/^\/uploads\//, '');
  const target = path.resolve(UPLOAD_ROOT, relative);
  // These keys are ours, but a row rewritten by hand should still never make
  // us unlink something outside the upload root.
  if (target !== UPLOAD_ROOT && !target.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error(`Refusing to delete outside the upload root: ${storagePath}`);
  }
  await fs.promises.unlink(target);
}

/** Reads one stored object back by the `path` put() returned. Null when gone. */
async function get(storagePath) {
  const relative = String(storagePath).replace(/^\/uploads\//, '');
  const target = path.resolve(UPLOAD_ROOT, relative);
  if (!target.startsWith(UPLOAD_ROOT + path.sep)) throw new Error(`Refusing to read outside the upload root: ${storagePath}`);
  try {
    return { buffer: await fs.promises.readFile(target), contentType: null };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Health probe for /admin/system/services. Local disk is "configured" by
 * definition, so the only thing worth checking is that the upload root is
 * actually writable — an ephemeral container filesystem that has gone
 * read-only is exactly the failure this tile should catch.
 */
async function probe() {
  const marker = path.join(UPLOAD_ROOT, '.probe');
  await fs.promises.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.promises.writeFile(marker, String(Date.now()));
  await fs.promises.unlink(marker).catch(() => {});
  return { detail: `local disk (${UPLOAD_ROOT})` };
}

module.exports = { put, get, remove, probe, putPrivate, getPrivate, removePrivate, UPLOAD_ROOT, PRIVATE_ROOT };
