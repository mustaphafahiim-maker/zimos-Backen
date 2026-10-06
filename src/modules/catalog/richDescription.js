'use strict';

/**
 * Formatted product descriptions (SPEC §7.1 "description (rich text)"),
 * kept as text with a few marks — never as HTML:
 *
 *   ## A heading            - an item            1. an item
 *   **bold**   _italic_   [a link](https://…)
 *
 * The storefront and the dashboard draw these marks with their own elements
 * (api-client endpoints/richText.ts), escaping every character, so nothing
 * in a description can run in a shopper's browser.
 *
 * Descriptions often arrive as HTML: pasted from another site, imported from
 * Shopify, written by a tool. `normalizeDescription` turns the formatting
 * HTML can carry (paragraphs, line breaks, headings, lists, bold, italic,
 * http/mailto/tel links) into the marks, and drops everything else — scripts,
 * styles, iframes, attributes, event handlers, other tags — keeping only the
 * words. Text that is not HTML is kept as written.
 */

const MAX = 20000;
const LOOKS_LIKE_HTML = /<\s*\/?\s*(p|br|div|span|ul|ol|li|strong|b|em|i|u|h[1-6]|a|table|tr|td|img|script|style|iframe|section|article|font|blockquote)\b[^>]*>/i;
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)/i;

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const code = Number(n);
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&amp;/gi, '&');
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? m[2] ?? m[3] ?? m[4] ?? '' : '';
};

/** HTML → the marks. Whatever is not formatting is dropped; the words stay. */
function fromHtml(html) {
  let s = String(html || '');
  // Gone with their content.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\s*(script|style|iframe|object|embed|noscript|template|svg|math|head|title)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*\/?>/gi, ' ');
  // Links: kept as [text](href) when the address is a safe one.
  s = s.replace(/<\s*a\b([^>]*)>([\s\S]*?)<\s*\/\s*a\s*>/gi, (_, attrs, inner) => {
    const href = decodeEntities(attr(`<a ${attrs}>`, 'href')).trim();
    const text = inner.replace(/<[^>]*>/g, '').trim();
    return SAFE_HREF.test(href) && text && !/[\]\n]/.test(text) ? `[${text}](${href.replace(/[)\s]/g, encodeURIComponent)})` : text;
  });
  s = s.replace(/<\s*h[1-6]\b[^>]*>/gi, '\n\n## ').replace(/<\s*\/\s*h[1-6]\s*>/gi, '\n\n');
  s = s.replace(/<\s*(strong|b)\b[^>]*>/gi, '**').replace(/<\s*\/\s*(strong|b)\s*>/gi, '**');
  s = s.replace(/<\s*(em|i)\b[^>]*>/gi, '_').replace(/<\s*\/\s*(em|i)\s*>/gi, '_');
  // Lists: numbered ones count their items.
  s = s.replace(/<\s*ol\b[^>]*>([\s\S]*?)<\s*\/\s*ol\s*>/gi, (_, inner) => {
    let n = 0;
    return `\n\n${inner.replace(/<\s*li\b[^>]*>/gi, () => `\n${++n}. `)}\n\n`;
  });
  s = s.replace(/<\s*li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\s*\/\s*(ul|ol)\s*>|<\s*(ul|ol)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|section|article|blockquote|tr|table)\s*>/gi, '\n\n');
  s = s.replace(/<\s*\/\s*li\s*>|<\s*\/\s*td\s*>/gi, ' ');
  // Every other tag, and any stray "<" that opens one.
  s = s.replace(/<[^>]*>/g, '').replace(/<(?=[a-z!/?])/gi, '');
  s = decodeEntities(s);
  // Tidy the marks the tags left: empty bold/italic, spaces inside them.
  s = s.replace(/\*\*\s*\*\*/g, '').replace(/(^|\s)_\s*_(?=\s|$)/g, '$1');
  s = s.replace(/\*\*\s+([^*\n]+?)\s*\*\*/g, '**$1**');
  // HTML's own spacing means nothing: one space between words, none at a line's ends.
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n');
}

/** What is stored: HTML turned into the marks, line ends and blank runs tidied, control characters out. */
function normalizeDescription(value) {
  if (value === null || value === undefined) return value;
  let s = String(value);
  if (LOOKS_LIKE_HTML.test(s)) s = fromHtml(s);
  s = s
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.slice(0, MAX);
}

/** The description without its marks: for feeds and anywhere plain text is wanted. */
function plainDescription(value) {
  return normalizeDescription(value || '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?=[^A-Za-z0-9_]|$)/g, '$1$2')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1');
}

module.exports = { normalizeDescription, plainDescription, fromHtml };
