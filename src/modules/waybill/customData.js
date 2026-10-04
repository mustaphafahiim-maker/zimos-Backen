'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { drawText, hasArabic } = require('../../core/pdf/bidiText');

/**
 * The shopper's answers to a product's custom fields ("name to engrave",
 * "message on the card", their photo) printed on the waybill (SPEC §7.2), so
 * whoever packs the parcel sees them without opening the order. Read from the
 * order lines' snapshots (catalog/customFields.js); a photo is only named —
 * it is on the order page.
 */

const MAX_LINES = 8;
const MAX_CHARS = 140;
const clip = (s) => {
  const text = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return [...text].length > MAX_CHARS ? `${[...text].slice(0, MAX_CHARS - 1).join('')}…` : text;
};

/** "<product> — <field>: <answer>" for every answered field of the order, at most MAX_LINES (+ "…and N more"). */
async function customDataLines(orderId) {
  const items = await db.OrderItem.findAll({
    where: { orderId, customizations: { [Op.ne]: null } },
    attributes: ['productNameSnapshot', 'quantity', 'customizations'],
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
  });
  const lines = [];
  for (const item of items) {
    if (!Array.isArray(item.customizations)) continue;
    const product = item.quantity > 1 ? `${item.productNameSnapshot} ×${item.quantity}` : item.productNameSnapshot;
    for (const entry of item.customizations) {
      const label = (entry.label && (entry.label.ar || entry.label.en)) || entry.fieldId;
      const answer = entry.type === 'image' ? 'photo on the order page' : entry.value;
      if (!answer) continue;
      lines.push(clip(`${product} — ${label}: ${answer}`));
    }
  }
  if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES), `… +${lines.length - MAX_LINES}`];
  return lines;
}

/**
 * Draws the lines from `y` down, at `size`, stopping before `maxY`; returns
 * the y under the last line drawn. Arabic lines sit on the right.
 */
function drawCustomData(doc, lines, { x, y, width, size = 9, maxY = Infinity }) {
  let cursor = y;
  for (const line of lines) {
    const height = size * (hasArabic(line) ? 1.6 : 1.25);
    if (cursor + height > maxY) break;
    cursor = drawText(doc, line, { x, y: cursor, width, size, align: hasArabic(line) ? 'right' : 'left' });
  }
  return cursor;
}

module.exports = { customDataLines, drawCustomData };
