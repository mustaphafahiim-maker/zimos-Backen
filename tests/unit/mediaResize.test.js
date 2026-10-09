'use strict';

// Library uploads are scaled down to MEDIA_MAX_DIMENSION on their long side
// (never up) and re-encoded at MEDIA_JPEG_QUALITY; icons of 512px or less and
// the EXIF script's call (no options) keep their pixels exactly.

const sharp = require('sharp');
const { processMerchantImage, SMALL_IMAGE_EDGE } = require('../../src/modules/media/imageProcessing');
const { jpegWithExif } = require('../helpers/images');

const JPEG = { mime: 'image/jpeg', ext: 'jpg' };
const PNG = { mime: 'image/png', ext: 'png' };
const WEBP = { mime: 'image/webp', ext: 'webp' };

const solid = (width, height, channels = 3) =>
  sharp({ create: { width, height, channels, background: channels === 4 ? { r: 0, g: 90, b: 0, alpha: 0.4 } : '#3366aa' } });

const size = async (buffer) => {
  const { width, height, format, hasAlpha } = await sharp(buffer).metadata();
  return { width, height, format, hasAlpha };
};

const OPTS = { maxDimension: 2000, quality: 85 };

describe('merchant image resize', () => {
  it('scales a big JPEG down to the limit on its long side, keeping the ratio', async () => {
    const out = await processMerchantImage(await solid(3000, 1500).jpeg().toBuffer(), JPEG, OPTS);
    expect(await size(out)).toMatchObject({ width: 2000, height: 1000, format: 'jpeg' });
  });

  it('scales a tall WebP by its height', async () => {
    const out = await processMerchantImage(await solid(900, 2400).webp().toBuffer(), WEBP, OPTS);
    expect(await size(out)).toMatchObject({ width: 750, height: 2000, format: 'webp' });
  });

  it('keeps a PNG a PNG with its transparency', async () => {
    const out = await processMerchantImage(await solid(2600, 1300, 4).png().toBuffer(), PNG, OPTS);
    expect(await size(out)).toMatchObject({ width: 2000, height: 1000, format: 'png', hasAlpha: true });
  });

  it('never upscales', async () => {
    const out = await processMerchantImage(await solid(800, 600).jpeg().toBuffer(), JPEG, OPTS);
    expect(await size(out)).toMatchObject({ width: 800, height: 600 });
  });

  it('turns a sideways phone photo upright before measuring it', async () => {
    // 3000×1000 stored, orientation 6 → 1000×3000 upright → 667×2000
    const out = await processMerchantImage(await jpegWithExif({ width: 3000, height: 1000 }), JPEG, OPTS);
    expect(await size(out)).toMatchObject({ width: 667, height: 2000 });
  });

  it('leaves a favicon-sized picture alone (no resize, the old quality)', async () => {
    const input = await solid(SMALL_IMAGE_EDGE, SMALL_IMAGE_EDGE).jpeg({ quality: 95 }).toBuffer();
    const withOpts = await processMerchantImage(input, JPEG, { maxDimension: 256, quality: 40 });
    const without = await processMerchantImage(input, JPEG);
    expect(await size(withOpts)).toMatchObject({ width: SMALL_IMAGE_EDGE, height: SMALL_IMAGE_EDGE });
    expect(withOpts.equals(without)).toBe(true);
  });

  it('does not resize at all without options (scripts/strip-media-exif.js)', async () => {
    const out = await processMerchantImage(await solid(3000, 1500).jpeg().toBuffer(), JPEG);
    expect(await size(out)).toMatchObject({ width: 3000, height: 1500 });
  });
});
