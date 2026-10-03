'use strict';

// Real image files for upload tests, made with sharp: a phone-like JPEG
// carrying EXIF (an owner's name, a GPS position) and a sideways orientation
// tag, a PNG with transparency, and GIFs with and without animation, with a
// comment and an XMP block spliced in.

const sharp = require('sharp');

const SECRET = 'SECRET-OWNER-NAME';

/** 120×60 red JPEG with EXIF text and GPS, tagged "rotate 90° clockwise" (orientation 6). */
async function jpegWithExif({ width = 120, height = 60 } = {}) {
  const base = await sharp({ create: { width, height, channels: 3, background: '#cc0000' } })
    .jpeg()
    .withExif({
      IFD0: { Copyright: SECRET, Artist: SECRET },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '30/1 2/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '31/1 14/1 0/1' },
    })
    .toBuffer();
  return sharp(base).withMetadata({ orientation: 6 }).toBuffer();
}

/** 40×40 PNG with a transparent half. */
async function pngWithAlpha() {
  return sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0.5 } } })
    .png()
    .toBuffer();
}

/** A GIF (2 frames when `animated`) with a comment block and an XMP application block after the header. */
async function gifWithMetadata({ animated = true } = {}) {
  const frame = (color) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
  const gif = animated
    ? await sharp([await frame('#ff0000'), await frame('#0000ff')], { join: { animated: true } })
        .gif({ delay: [100, 100], loop: 0 })
        .toBuffer()
    : await sharp(await frame('#ff0000')).gif().toBuffer();
  // Insert right after the logical screen descriptor and global colour table.
  const packed = gif[10];
  const at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  const text = Buffer.from(SECRET, 'latin1');
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, text.length]), text, Buffer.from([0x00])]);
  const xmpPayload = Buffer.from(`<x:xmpmeta>${SECRET}</x:xmpmeta>`, 'latin1');
  const xmp = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('XMP DataXMP', 'latin1'),
    Buffer.from([xmpPayload.length]),
    xmpPayload,
    Buffer.from([0x00]),
  ]);
  return Buffer.concat([gif.subarray(0, at), comment, xmp, gif.subarray(at)]);
}

/** Starts like a JPEG, then garbage: sharp cannot decode it. */
function corruptJpeg() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x41)]);
}

module.exports = { SECRET, jpegWithExif, pngWithAlpha, gifWithMetadata, corruptJpeg };
