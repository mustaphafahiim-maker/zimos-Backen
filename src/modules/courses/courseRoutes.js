'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const env = require('../../config/env');
const service = require('./courseService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const wsId = (req) => req.tenant.workspaceId;
const url = Joi.string().uri({ scheme: ['http', 'https'] }).max(1000);

const courseFields = {
  title: Joi.string().trim().min(1).max(200),
  slug: Joi.string().trim().max(120).allow('', null),
  description: Joi.string().max(5000).allow('', null),
  coverUrl: url.allow('', null),
  productId: uuid.allow(null),
  status: Joi.string().valid('draft', 'published'),
};

const lesson = Joi.object({
  id: uuid,
  title: Joi.string().trim().min(1).max(200).required(),
  kind: Joi.string().valid('video', 'text', 'file').required(),
  videoUrl: url.allow('', null),
  body: Joi.string().max(50000).allow('', null),
  fileId: uuid.allow(null),
  durationSeconds: Joi.number().integer().min(0).max(86400).allow(null),
  isFreePreview: Joi.boolean().default(false),
  dripDays: Joi.number().integer().min(0).max(3650).default(0),
});
const outline = Joi.array()
  .items(Joi.object({ id: uuid, title: Joi.string().trim().min(1).max(200).required(), lessons: Joi.array().items(lesson).max(200).default([]) }))
  .max(100)
  .required();

// Courses (SPEC §18.3). Mounted at /api/v1/workspaces/:workspaceId/courses
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const view = requirePermission(P.PRODUCTS_VIEW);
const manage = requirePermission(P.PRODUCTS_MANAGE);
const one = Joi.object({ ...ws, courseId: uuid.required() });

staff.get('/', validate({ params: Joi.object(ws) }), view, asyncHandler(async (req, res) => res.json(await service.listCourses(wsId(req)))));
staff.post(
  '/',
  validate({ params: Joi.object(ws), body: Joi.object({ ...courseFields, title: courseFields.title.required() }) }),
  manage,
  asyncHandler(async (req, res) => res.status(201).json({ course: await service.createCourse(wsId(req), req.body, req) }))
);
staff.get('/:courseId', validate({ params: one }), view, asyncHandler(async (req, res) => res.json({ course: await service.getCourse(wsId(req), req.params.courseId) })));
staff.patch(
  '/:courseId',
  validate({ params: one, body: Joi.object(courseFields).min(1) }),
  manage,
  asyncHandler(async (req, res) => res.json({ course: await service.updateCourse(wsId(req), req.params.courseId, req.body, req) }))
);
staff.delete(
  '/:courseId',
  validate({ params: one }),
  manage,
  asyncHandler(async (req, res) => {
    await service.deleteCourse(wsId(req), req.params.courseId, req);
    res.status(204).end();
  })
);
staff.put(
  '/:courseId/outline',
  validate({ params: one, body: Joi.object({ modules: outline }) }),
  manage,
  asyncHandler(async (req, res) => res.json({ course: await service.saveOutline(wsId(req), req.params.courseId, req.body.modules, req) }))
);
staff.get(
  '/:courseId/students',
  validate({ params: one }),
  requirePermission(P.CUSTOMERS_VIEW),
  asyncHandler(async (req, res) => res.json(await service.listStudents(wsId(req), req.params.courseId)))
);
staff.post(
  '/:courseId/students',
  validate({ params: one, body: Joi.object({ phone: Joi.string().max(32).required(), fullName: Joi.string().max(200).allow('', null) }) }),
  requirePermission(P.CUSTOMERS_MANAGE),
  asyncHandler(async (req, res) => res.status(201).json(await service.enrollManually(wsId(req), req.params.courseId, req.body, req)))
);
staff.post(
  '/enrollments/:enrollmentId',
  validate({ params: Joi.object({ ...ws, enrollmentId: uuid.required() }), body: Joi.object({ revoked: Joi.boolean().required() }) }),
  requirePermission(P.CUSTOMERS_MANAGE),
  asyncHandler(async (req, res) => res.json(await service.setEnrollmentRevoked(wsId(req), req.params.enrollmentId, req.body.revoked, req)))
);

// The student's side — public; phone + code, then the X-Student-Token header.
// Mounted at /api/v1/store/:workspaceId/learn
const portal = Router({ mergeParams: true });
portal.use(createIpMinuteLimiter('student-portal', 60, { skip: () => env.isTest }), resolvePublicWorkspace);
// Header only: a token in a link would end up in browser history and logs.
const tokenOf = (req) => String(req.headers['x-student-token'] || '');
const noStore = (res) => res.set('Cache-Control', 'private, no-store');

portal.post(
  '/request-code',
  validate({ body: Joi.object({ phone: Joi.string().max(32).required() }) }),
  asyncHandler(async (req, res) => res.json(await service.portalRequestCode(wsId(req), req.body.phone)))
);
portal.post(
  '/verify',
  validate({ body: Joi.object({ phone: Joi.string().max(32).required(), code: Joi.string().trim().min(4).max(10).required() }) }),
  asyncHandler(async (req, res) => res.json(await service.portalVerify(wsId(req), req.body.phone, req.body.code)))
);
portal.get('/courses', asyncHandler(async (req, res) => noStore(res).json(await service.portalCourses(wsId(req), tokenOf(req)))));
portal.get('/courses/:slug', asyncHandler(async (req, res) => noStore(res).json(await service.portalCourse(wsId(req), req.params.slug, tokenOf(req)))));
portal.get(
  '/courses/:slug/lessons/:lessonId',
  asyncHandler(async (req, res) => noStore(res).json(await service.portalLesson(wsId(req), req.params.slug, req.params.lessonId, tokenOf(req))))
);
portal.get(
  '/courses/:slug/lessons/:lessonId/file',
  asyncHandler(async (req, res) => {
    const file = await service.portalLessonFile(wsId(req), req.params.slug, req.params.lessonId, tokenOf(req));
    noStore(res);
    res.set('Content-Type', file.mimeType || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.send(file.buffer);
  })
);
portal.post(
  '/courses/:slug/lessons/:lessonId/progress',
  validate({ body: Joi.object({ completed: Joi.boolean().required() }) }),
  asyncHandler(async (req, res) => res.json(await service.portalComplete(wsId(req), req.params.slug, req.params.lessonId, tokenOf(req), req.body.completed)))
);

module.exports = { staff, portal };
