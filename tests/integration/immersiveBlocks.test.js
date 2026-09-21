'use strict';

// Groundwork for the immersive storefront: GLB product models can be uploaded
// (up to 15MB, detected from the file bytes), and the four immersive element
// types are accepted in a page tree while raw HTML still is not.

const fs = require('fs');
const path = require('path');
const { app, request, registerAndActivate, createWorkspace, setupWorkspaceWithProduct } = require('../helpers/factories');
const { UPLOAD_ROOT } = require('../../src/modules/media/mediaService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

/** Smallest thing that is a real binary glTF header: 'glTF', version 2, length. */
function glb(payloadBytes = 64) {
  const body = Buffer.alloc(payloadBytes, 0x20);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

function treeWith(element) {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [
          {
            id: 'r1',
            type: 'row',
            settings: {},
            columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements: [element] }],
          },
        ],
      },
    ],
  };
}

afterAll(() => {
  try {
    for (const entry of fs.readdirSync(UPLOAD_ROOT)) {
      if (entry === '.gitkeep') continue;
      fs.rmSync(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true });
    }
  } catch { /* ignore */ }
});

describe('immersive storefront groundwork', () => {
  it('accepts a GLB model, rejects a file that only claims to be one, and rejects an oversized model', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const url = `/api/v1/workspaces/${workspace.id}/media`;

    const ok = await request(app).post(url).set(bearer(auth.accessToken)).attach('file', glb(), { filename: 'chair.glb', contentType: 'model/gltf-binary' });
    expect(ok.status).toBe(201);
    expect(ok.body.mimeType).toBe('model/gltf-binary');
    expect(ok.body.path).toMatch(/\.glb$/);

    const liar = await request(app)
      .post(url)
      .set(bearer(auth.accessToken))
      .attach('file', Buffer.from('not a model at all'), { filename: 'chair.glb', contentType: 'model/gltf-binary' });
    expect(liar.status).toBe(415);

    const tooBig = await request(app)
      .post(url)
      .set(bearer(auth.accessToken))
      .attach('file', glb(16 * 1024 * 1024), { filename: 'huge.glb', contentType: 'model/gltf-binary' });
    expect(tooBig.status).toBe(413);

    const listed = await request(app).get(url).set(bearer(auth.accessToken));
    expect(listed.status).toBe(200);
    expect(listed.body.media.filter((m) => m.mimeType === 'model/gltf-binary')).toHaveLength(1);
  });

  it('saves a page that uses the immersive element types, and still refuses raw HTML', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Immersive Store');
    const H = bearer(auth.accessToken);
    const base = `/api/v1/workspaces/${workspace.id}/websites`;

    const site = await request(app).post(base).set(H).send({ name: 'Immersive Store' });
    expect(site.status).toBe(201);
    const pages = `${base}/${site.body.website.id}/pages`;

    for (const type of ['shader_hero', 'product_3d', 'orbit_gallery', 'scroll_story', 'marquee', 'comparison']) {
      const page = await request(app)
        .post(pages)
        .set(H)
        .send({ title: `Page ${type}`, path: `p-${type.replace(/_/g, '-')}`, draftData: treeWith({ id: 'e1', type, props: { intensity: 2 } }) });
      expect(page.status).toBe(201);
      expect(page.body.page.draftData.sections[0].rows[0].columns[0].elements[0].type).toBe(type);
    }

    const html = await request(app)
      .post(pages)
      .set(H)
      .send({ title: 'Raw', path: 'raw', draftData: treeWith({ id: 'e1', type: 'raw_html', props: { html: '<script>x</script>' } }) });
    expect(html.status).toBe(422);
  });
});
