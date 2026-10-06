'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('../../../core/errors/AppError');

/**
 * The sandbox Google Sheets: no Google at all. "Authorising" hands back a code
 * at once, and each spreadsheet is a JSON file of rows on this machine
 * (GOOGLE_SHEETS_SANDBOX_DIR, default storage/private/sandbox-sheets), so the
 * sync can be watched end to end in development. Never used in production
 * (adapters/index.js).
 *
 * To try the failure paths: a spreadsheet id ending in "-revoked" answers as
 * Google does when the merchant took the app's access away, and one ending in
 * "-flaky" fails like a passing outage.
 */

const name = 'sandbox';
const sandbox = true;
const dir = () => process.env.GOOGLE_SHEETS_SANDBOX_DIR || path.join(process.cwd(), 'storage', 'private', 'sandbox-sheets');
const fileOf = (spreadsheetId) => path.join(dir(), `${spreadsheetId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);

function guard(spreadsheetId) {
  if (/-revoked$/.test(spreadsheetId)) throw new AppError('SHEETS_ACCESS_REVOKED', 'Access to the spreadsheet was removed', 403);
  if (/-flaky$/.test(spreadsheetId)) throw new AppError('SHEETS_UNREACHABLE', 'Google Sheets did not answer', 502);
}

function read(spreadsheetId) {
  guard(spreadsheetId);
  try {
    return JSON.parse(fs.readFileSync(fileOf(spreadsheetId), 'utf8'));
  } catch {
    throw new AppError('SHEETS_NOT_FOUND', 'The spreadsheet does not exist or was deleted', 404);
  }
}

function write(sheet) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(fileOf(sheet.spreadsheetId), JSON.stringify(sheet, null, 1));
}

/** Where to send the merchant to allow access; the sandbox sends them straight back with a code. */
function authorizeUrl({ redirectUri, state }) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', `sandbox-${crypto.randomBytes(6).toString('hex')}`);
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCode(code) {
  if (!/^sandbox-/.test(String(code))) throw new AppError('SHEETS_AUTH_FAILED', 'That authorisation code is not valid', 400);
  return { account: 'sandbox@example.com', credentials: { accessToken: `sandbox-token-${code}`, refreshToken: 'sandbox-refresh' } };
}

async function createSpreadsheet(credentials, { title }) {
  const spreadsheetId = `sbx${crypto.randomBytes(9).toString('hex')}`;
  write({ spreadsheetId, title, sheets: { Sheet1: [] } });
  return { spreadsheetId, sheetName: 'Sheet1', url: `sandbox://sheets/${spreadsheetId}` };
}

/** An existing spreadsheet the app may write to; `sheetName` is created when missing. */
async function openSpreadsheet(credentials, { spreadsheetId, sheetName }) {
  const sheet = read(spreadsheetId);
  const tab = sheetName || Object.keys(sheet.sheets)[0] || 'Sheet1';
  if (!sheet.sheets[tab]) {
    sheet.sheets[tab] = [];
    write(sheet);
  }
  return { spreadsheetId, sheetName: tab, url: `sandbox://sheets/${spreadsheetId}` };
}

/** Writes row 1 (the titles). */
async function setHeader(credentials, { spreadsheetId, sheetName, header }) {
  const sheet = read(spreadsheetId);
  const rows = sheet.sheets[sheetName] || [];
  rows[0] = header;
  sheet.sheets[sheetName] = rows;
  write(sheet);
}

/** Adds rows after the last one; answers the number of the first row written (1-based, row 1 = titles). */
async function appendRows(credentials, { spreadsheetId, sheetName, rows }) {
  const sheet = read(spreadsheetId);
  const tab = sheet.sheets[sheetName] || [];
  const firstRow = Math.max(tab.length, 1) + 1;
  while (tab.length < firstRow - 1) tab.push([]);
  tab.push(...rows);
  sheet.sheets[sheetName] = tab;
  write(sheet);
  return { firstRow };
}

/** Replaces the rows starting at `firstRow`. */
async function updateRows(credentials, { spreadsheetId, sheetName, firstRow, rows }) {
  const sheet = read(spreadsheetId);
  const tab = sheet.sheets[sheetName] || [];
  rows.forEach((row, i) => {
    tab[firstRow - 1 + i] = row;
  });
  sheet.sheets[sheetName] = tab;
  write(sheet);
}

/** The sandbox only: the rows of a tab, for looking at what the sync wrote. */
async function readRows(credentials, { spreadsheetId, sheetName }) {
  return read(spreadsheetId).sheets[sheetName] || [];
}

module.exports = { name, sandbox, authorizeUrl, exchangeCode, createSpreadsheet, openSpreadsheet, setHeader, appendRows, updateRows, readRows };
