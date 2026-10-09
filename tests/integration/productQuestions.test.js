'use strict';

// Product questions and answers (modules/productQuestions, STORE_FEATURES product_questions).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const ask = (workspaceId, productId, body) =>
  request(app).post(`/api/v1/store/${workspaceId}/products/${productId}/questions`).send(body);

describe('product questions', () => {
  it('are off until STORE_FEATURES names them', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const res = await ask(workspace.id, product.id, { question: 'Is it cotton?' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    const staff = await request(app).get(`/api/v1/workspaces/${workspace.id}/product-questions`).set('Authorization', `Bearer ${auth.accessToken}`);
    expect(staff.status).toBe(404);
    expect(await db.ProductQuestion.count()).toBe(0);
  });

  it('a question waits for the store; the answer publishes it and tells the asker once', async () => {
    env.storeFeatures.push('product_questions');
    const email = jest.spyOn(notify, 'email').mockResolvedValue({});
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const answers = () => email.mock.calls.filter(([opts]) => opts.template === 'question_answered');

    expect((await ask(workspace.id, product.id, { question: 'Hi' })).status).toBe(422);
    const asked = await ask(workspace.id, product.id, { question: 'Is it cotton?', name: 'Mona', email: 'Mona@Example.com', locale: 'en' });
    expect(asked.status).toBe(201);
    expect(asked.body).toEqual({ received: true, status: 'pending' });
    expect(await db.MerchantNotification.count({ where: { workspaceId: workspace.id, type: 'product.question' } })).toBe(1);

    const publicList = () => request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}/questions`);
    expect((await publicList()).body.questions).toHaveLength(0);

    const staff = await request(app).get(`/api/v1/workspaces/${workspace.id}/product-questions`).set(H);
    expect(staff.body.pending).toBe(1);
    const [q] = staff.body.questions;
    expect(q).toMatchObject({ askerEmail: 'mona@example.com', status: 'pending', productName: product.name });

    const url = `/api/v1/workspaces/${workspace.id}/product-questions/${q.id}`;
    const noAnswer = await request(app).patch(url).set(H).send({ status: 'published' });
    expect(noAnswer.status).toBe(422);
    expect(noAnswer.body.error.code).toBe('ANSWER_REQUIRED');

    const answered = await request(app).patch(url).set(H).send({ answer: '100% cotton.' });
    expect(answered.status).toBe(200);
    expect(answered.body.status).toBe('published');
    expect(answers()).toHaveLength(1);
    expect(answers()[0][0]).toMatchObject({ recipient: 'mona@example.com', template: 'question_answered' });

    await request(app).patch(url).set(H).send({ answer: 'Cotton, machine washable.' });
    expect(answers()).toHaveLength(1);

    const shown = (await publicList()).body.questions;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ question: 'Is it cotton?', answer: 'Cotton, machine washable.', askerName: 'Mona' });
    expect(shown[0].askerEmail).toBeUndefined();
  });

  it('at most 5 questions an hour from one address', async () => {
    env.storeFeatures.push('product_questions');
    const { workspace, product } = await setupWorkspaceWithProduct();
    for (let i = 0; i < 5; i += 1) {
      expect((await ask(workspace.id, product.id, { question: `Question number ${i}` })).status).toBe(201);
    }
    const sixth = await ask(workspace.id, product.id, { question: 'One more question' });
    expect(sixth.status).toBe(429);
  });
});
