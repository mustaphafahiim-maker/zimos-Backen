#!/usr/bin/env node
'use strict';

/**
 * Prints a new VAPID key pair for web push (src/modules/notifications/push/README.md).
 * Put both lines in the server's environment (never in git) with
 * WEB_PUSH_SUBJECT=mailto:<a monitored address>. Generate once per
 * environment: a new pair invalidates every browser subscription made with
 * the old public key, so dashboards and stores subscribe again.
 *
 *   node scripts/generate-vapid-keys.js
 */
const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(`WEB_PUSH_PUBLIC_KEY=${publicKey}\nWEB_PUSH_PRIVATE_KEY=${privateKey}\n`);
