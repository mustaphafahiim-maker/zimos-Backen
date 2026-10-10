'use strict';

// Scheduled summary reports (modules/scheduledReports, STORE_FEATURES scheduled_reports):
// a daily or weekly email to the chosen team members, once per period.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const scheduled = require('../../src/modules/scheduledReports');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const SETTINGS = (userId) => ({ daily: { enabled: true, hour: 0 }, weekly: { enabled: false, weekday: 6, hour: 9 }, recipientUserIds: [userId] });
const reportsSent = (spy) => spy.mock.calls.filter(([o]) => o.template === 'summary_report');

describe('scheduled reports', () => {
  it('off: no route, and the schedule sends nothing whatever the settings hold', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/scheduled-reports`).set(H)).status).toBe(404);
    const ws = await db.Workspace.findByPk(workspace.id);
    await ws.update({ settings: { ...ws.settings, scheduled_reports: SETTINGS(auth.userId) } });
    const email = jest.spyOn(notify, 'email');
    await scheduled.runDue();
    expect(reportsSent(email)).toHaveLength(0);
  });

  it('on: the daily report goes once a day to the chosen member', async () => {
    env.storeFeatures.push('scheduled_reports');
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const url = `/api/v1/workspaces/${workspace.id}/scheduled-reports`;
    expect((await request(app).put(url).set(H).send({ ...SETTINGS(auth.userId), recipientUserIds: [] })).status).toBe(422);
    const put = await request(app).put(url).set(H).send(SETTINGS(auth.userId));
    expect(put.status).toBe(200);
    expect(put.body.members.map((m) => m.userId)).toContain(auth.userId);

    const email = jest.spyOn(notify, 'email');
    await scheduled.runDue();
    await scheduled.runDue();
    const sent = reportsSent(email);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({ recipient: auth.email, data: expect.objectContaining({ kind: 'daily', storeName: expect.any(String) }) });
    expect((await request(app).get(url).set(H)).body.lastSent).toEqual([expect.objectContaining({ kind: 'daily', sentCount: 1 })]);
  });
});
