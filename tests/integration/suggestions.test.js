'use strict';

// Suggestions: a store's members send ideas, bugs and improvements and read
// the status and reply; the console lists, filters, searches, changes the
// status and replies (support.view / support.manage), and is notified of a
// new one. Lengths are capped, other stores' suggestions are never shown,
// and sending is limited per client IP.

const express = require('express');
const { app, request, setupWorkspaceWithProduct, makePlatformUser, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { createSuggestionLimiter } = require('../../src/modules/suggestions/suggestionRoutes');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const send = (ctx, body, token = ctx.auth.accessToken) =>
  request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/suggestions`).set(bearer(token)).send(body);
const IDEA = { title: 'Delivery zones by street', description: 'Let us price delivery per street inside the city.', category: 'feature' };

describe('suggestions (store side)', () => {
  it('sends one, lists only this store’s, and caps lengths and categories', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const sent = await send(ctx, { ...IDEA, contact: '01011112222', status: 'done', adminReply: 'forged' });
    expect(sent.status).toBe(201);
    expect(sent.body.suggestion).toMatchObject({ title: IDEA.title, category: 'feature', status: 'new', adminReply: null, contact: '01011112222' });

    expect((await send(ctx, { ...IDEA, title: 'x'.repeat(151) })).status).toBe(422);
    expect((await send(ctx, { ...IDEA, description: 'y'.repeat(4001) })).status).toBe(422);
    expect((await send(ctx, { ...IDEA, category: 'question' })).status).toBe(422);

    // Any member may send; another store sees none of it.
    const agent = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'confirmation_agent');
    expect((await send(ctx, { ...IDEA, category: 'bug', title: 'Sheet font' }, agent.accessToken)).status).toBe(201);
    const mine = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/suggestions`).set(bearer(ctx.auth.accessToken));
    expect(mine.body.suggestions.map((s) => s.title)).toEqual(['Sheet font', IDEA.title]);

    const other = await setupWorkspaceWithProduct();
    const theirs = await request(app).get(`/api/v1/workspaces/${other.workspace.id}/suggestions`).set(bearer(other.auth.accessToken));
    expect(theirs.body.suggestions).toEqual([]);
    expect((await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/suggestions`).set(bearer(other.auth.accessToken))).status).toBe(404);

    const audit = await db.AuditLog.count({ where: { workspaceId: ctx.workspace.id, action: 'suggestion.create' } });
    expect(audit).toBe(2);
  });

  it('limits sending per client IP (the limiter the route uses, without the test-suite skip)', async () => {
    const small = express();
    small.set('trust proxy', 1);
    small.use(express.json());
    small.post('/s', createSuggestionLimiter({ max: 2, skip: () => false }), (req, res) => res.status(201).json({ ok: true }));
    small.use(errorHandler);
    const from = (ip) => request(small).post('/s').set('X-Forwarded-For', ip).send({});
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await from('198.51.100.40')).status);
    expect(statuses).toEqual([201, 201, 429]);
    expect((await from('198.51.100.41')).status).toBe(201);
  });
});

describe('suggestions (console)', () => {
  it('lists with filters and search, changes the status and replies, and the store reads it', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const a = (await send(ctx, IDEA)).body.suggestion;
    await send(ctx, { title: 'Waybill crash', description: 'The waybill fails for long Arabic names.', category: 'bug' });
    const admin = await makePlatformUser('admin');

    const all = await request(app).get('/api/v1/admin/suggestions').set(admin.H);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.counts).toMatchObject({ new: 2, under_review: 0, planned: 0, done: 0 });
    expect(all.body.suggestions[0].workspace).toMatchObject({ id: ctx.workspace.id });
    expect((await request(app).get('/api/v1/admin/suggestions?category=bug').set(admin.H)).body.suggestions.map((s) => s.title)).toEqual(['Waybill crash']);
    expect((await request(app).get('/api/v1/admin/suggestions?q=street').set(admin.H)).body.suggestions.map((s) => s.id)).toEqual([a.id]);

    const answered = await request(app).patch(`/api/v1/admin/suggestions/${a.id}`).set(admin.H).send({ status: 'planned', adminReply: 'On the list for next month.' });
    expect(answered.status).toBe(200);
    expect(answered.body.suggestion).toMatchObject({ status: 'planned', adminReply: 'On the list for next month.' });
    expect((await request(app).patch(`/api/v1/admin/suggestions/${a.id}`).set(admin.H).send({ status: 'shipped' })).status).toBe(422);

    const mine = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/suggestions`).set(bearer(ctx.auth.accessToken));
    expect(mine.body.suggestions.find((s) => s.id === a.id)).toMatchObject({ status: 'planned', adminReply: 'On the list for next month.' });
    expect((await request(app).get('/api/v1/admin/suggestions?status=planned').set(admin.H)).body.total).toBe(1);
  });

  it('notifies the console of a new suggestion', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const admin = await makePlatformUser('admin');
    const s = (await send(ctx, IDEA)).body.suggestion;
    const notes = await request(app).get('/api/v1/admin/notifications?type=suggestion').set(admin.H);
    expect(notes.status).toBe(200);
    const items = notes.body.notifications || notes.body.items || [];
    expect(items.some((n) => n.type === 'suggestion' && String(n.link).includes(s.id))).toBe(true);
  });

  it('is closed to store owners and to console users without support permissions', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const s = (await send(ctx, IDEA)).body.suggestion;
    expect((await request(app).get('/api/v1/admin/suggestions').set(bearer(ctx.auth.accessToken))).status).toBe(403);
    const agent = await makePlatformUser('agent');
    expect((await request(app).get('/api/v1/admin/suggestions').set(agent.H)).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/suggestions/${s.id}`).set(agent.H).send({ status: 'done' })).status).toBe(403);
  });
});
