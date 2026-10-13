import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canPerformOrganizationOperations, canReadOrganizationMembership, type OrganizationStatus, type PartnerRole } from './authz';

type AuthenticatedRequest = Request & { userId?: string };
type ApiErrorConstructor = new (status: number, message: string, code?: string) => Error;

type Options = {
  pool: Pool;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  ApiError: ApiErrorConstructor;
};

const applicationSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(180),
  city: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email().max(254).optional(),
  contactPhone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).optional(),
  website: z.string().trim().url().max(2048).refine((value) => value.startsWith('https://'), 'Website must use HTTPS').optional(),
  serviceModes: z.array(z.enum(['taxi','transfer','bus','carsharing','scooter','bicycle','public_transit']))
    .min(1).max(7).refine((values) => new Set(values).size === values.length, 'Service modes must be unique'),
  dispatchMode: z.enum(['INTEGRATION_ONLY','NATIVE_DISPATCH']),
}).strict();

const reviewSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
const pageSchema = z.coerce.number().int().min(1).max(100_000).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(25);
const idSchema = z.string().uuid();

function asyncRoute(handler: (req: AuthenticatedRequest, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { void handler(req as AuthenticatedRequest, res).catch(next); };
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, ApiError: ApiErrorConstructor): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'Request validation failed', 'invalid_request');
  return result.data;
}

function requiredUserId(req: AuthenticatedRequest, ApiError: ApiErrorConstructor) {
  if (!req.userId) throw new ApiError(401, 'Authentication required', 'unauthorized');
  return req.userId;
}

async function writeAudit(client: Pick<PoolClient, 'query'>, actorId: string, action: string, organizationId: string, details: Record<string, unknown>) {
  await client.query(
    'INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5)',
    [actorId, action, 'organization', organizationId, JSON.stringify(details)],
  );
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createPartnerPlatformRouter(options: Options) {
  const router = Router();
  const { pool, ApiError } = options;

  router.get('/partner/me', options.requireAuth, asyncRoute(async (req, res) => {
    const userId = requiredUserId(req, ApiError);
    const { rows } = await pool.query(
      `SELECT o.id,o.display_name,o.legal_name,o.status AS organization_status,o.dispatch_mode,
              m.role,m.status AS membership_status,
              COALESCE(array_agg(DISTINCT sm.service_mode) FILTER (WHERE sm.service_mode IS NOT NULL), '{}') AS service_modes
         FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id
         LEFT JOIN organization_service_modules sm ON sm.organization_id=o.id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND o.status<>'REJECTED'
        GROUP BY o.id,m.role,m.status
        ORDER BY o.created_at DESC`, [userId],
    );
    res.json({ data: { userId, organizations: rows } });
  }));

  router.post('/partner/applications', options.requireAuth, asyncRoute(async (req, res) => {
    const userId = requiredUserId(req, ApiError);
    const input = parseOrThrow(applicationSchema, req.body, ApiError);
    const result = await withTransaction(pool, async (client) => {
      const { rows: [organization] } = await client.query(
        `INSERT INTO organizations(display_name,legal_name,dispatch_mode,created_by)
         VALUES ($1,$2,$3,$4)
         RETURNING id,display_name,legal_name,status,dispatch_mode,created_at`,
        [input.displayName, input.legalName, input.dispatchMode, userId],
      );
      const { rows: [application] } = await client.query(
        `INSERT INTO partner_applications(organization_id,applicant_user_id,contact_email,contact_phone,city,website)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id,status,city,created_at`,
        [organization.id, userId, input.contactEmail ?? null, input.contactPhone ?? null, input.city, input.website ?? null],
      );
      await client.query(
        `INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ($1,$2,'organization_owner')`,
        [organization.id, userId],
      );
      for (const serviceMode of input.serviceModes) {
        await client.query('INSERT INTO organization_service_modules(organization_id,service_mode) VALUES ($1,$2)', [organization.id, serviceMode]);
      }
      await writeAudit(client, userId, 'partner.application.submitted', organization.id, { applicationId: application.id, requestedServiceModes: input.serviceModes });
      return { organization, application, serviceModes: input.serviceModes };
    });
    res.status(201).json({ data: result });
  }));

  router.get('/partner/organizations', options.requireAuth, asyncRoute(async (req, res) => {
    const userId = requiredUserId(req, ApiError);
    const { rows } = await pool.query(
      `SELECT o.id,o.display_name,o.legal_name,o.status AS organization_status,o.dispatch_mode,
              m.role,m.status AS membership_status,
              a.id AS application_id,a.status AS application_status,a.city,a.created_at AS application_created_at,
              COALESCE(array_agg(DISTINCT sm.service_mode) FILTER (WHERE sm.service_mode IS NOT NULL), '{}') AS service_modes
         FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id
         LEFT JOIN LATERAL (
           SELECT id,status,city,created_at FROM partner_applications
            WHERE organization_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1
         ) a ON true
         LEFT JOIN organization_service_modules sm ON sm.organization_id=o.id
        WHERE m.user_id=$1 AND m.status='ACTIVE' AND o.status<>'REJECTED'
        GROUP BY o.id,m.role,m.status,a.id,a.status,a.city,a.created_at
        ORDER BY o.created_at DESC`, [userId],
    );
    res.json({ data: rows });
  }));

  router.get('/partner/organizations/:id', options.requireAuth, asyncRoute(async (req, res) => {
    const userId = requiredUserId(req, ApiError);
    const organizationId = parseOrThrow(idSchema, req.params.id, ApiError);
    const { rows } = await pool.query(
      `SELECT o.id,o.display_name,o.legal_name,o.status AS organization_status,o.dispatch_mode,
              m.role,m.status AS membership_status,a.id AS application_id,a.status AS application_status,
              a.contact_email,a.contact_phone,a.city,a.website,a.created_at AS application_created_at,
              COALESCE(array_agg(DISTINCT sm.service_mode) FILTER (WHERE sm.service_mode IS NOT NULL), '{}') AS service_modes
         FROM organization_memberships m
         JOIN organizations o ON o.id=m.organization_id
         LEFT JOIN LATERAL (
           SELECT id,status,contact_email,contact_phone,city,website,created_at
             FROM partner_applications WHERE organization_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1
         ) a ON true
         LEFT JOIN organization_service_modules sm ON sm.organization_id=o.id
        WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='ACTIVE' AND o.status<>'REJECTED'
        GROUP BY o.id,m.role,m.status,a.id,a.status,a.contact_email,a.contact_phone,a.city,a.website,a.created_at`,
      [userId, organizationId],
    );
    const org = rows[0];
    if (!org || !canReadOrganizationMembership({ membershipStatus: org.membership_status, organizationStatus: org.organization_status as OrganizationStatus })) {
      throw new ApiError(404, 'Organization not found', 'organization_not_found');
    }
    res.json({ data: org });
  }));

  router.get('/partner/organizations/:id/permissions', options.requireAuth, asyncRoute(async (req, res) => {
    const userId = requiredUserId(req, ApiError);
    const organizationId = parseOrThrow(idSchema, req.params.id, ApiError);
    const { rows } = await pool.query(
      `SELECT o.status AS organization_status,m.role,m.status AS membership_status
         FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND m.organization_id=$2`, [userId, organizationId],
    );
    const membership = rows[0];
    if (!membership || membership.membership_status !== 'ACTIVE' || membership.organization_status === 'REJECTED') {
      throw new ApiError(404, 'Organization not found', 'organization_not_found');
    }
    const role = membership.role as PartnerRole;
    res.json({ data: {
      organizationId,
      role,
      organizationStatus: membership.organization_status,
      canManageOrganization: canPerformOrganizationOperations({ ...membership, role, requiredRoles: ['organization_owner','organization_admin'] }),
      canManageOrders: canPerformOrganizationOperations({ ...membership, role, requiredRoles: ['organization_owner','organization_admin','dispatcher'] }),
      canManageFleet: canPerformOrganizationOperations({ ...membership, role, requiredRoles: ['organization_owner','organization_admin','fleet_manager'] }),
      canManageIntegrations: canPerformOrganizationOperations({ ...membership, role, requiredRoles: ['organization_owner','organization_admin','technical_manager'] }),
      canViewFinance: canPerformOrganizationOperations({ ...membership, role, requiredRoles: ['organization_owner','organization_admin','finance_manager'] }),
    } });
  }));

  router.get('/admin/dashboard', options.requireAuth, options.requireAdmin, asyncRoute(async (_req, res) => {
    const { rows: [summary] } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM organizations WHERE status='ACTIVE') AS active_partners,
         (SELECT count(*)::int FROM organizations WHERE status='PENDING_REVIEW') AS pending_applications,
         (SELECT count(*)::int FROM mobility_operators WHERE enabled=true) AS enabled_provider_operators,
         (SELECT count(*)::int FROM mobility_providers WHERE status='enabled' AND health IN ('healthy','degraded')) AS healthy_provider_connections,
         (SELECT count(*)::int FROM mobility_providers WHERE status='enabled' AND health IN ('unhealthy','unknown')) AS provider_connections_needing_attention,
         now() AS generated_at`,
    );
    res.json({ data: summary });
  }));

  router.get('/admin/partners', options.requireAuth, options.requireAdmin, asyncRoute(async (req, res) => {
    const page = parseOrThrow(pageSchema, req.query.page ?? 1, ApiError);
    const pageSize = parseOrThrow(pageSizeSchema, req.query.pageSize ?? 25, ApiError);
    const status = req.query.status;
    const allowedStatuses = ['PENDING_REVIEW','ACTIVE','SUSPENDED','REJECTED'] as const;
    if (status !== undefined && (typeof status !== 'string' || !allowedStatuses.includes(status as typeof allowedStatuses[number]))) {
      throw new ApiError(400, 'Invalid organization status filter', 'invalid_status');
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
    const offset = (page - 1) * pageSize;
    const { rows } = await pool.query(
      `SELECT o.id,o.display_name,o.legal_name,o.status AS organization_status,o.dispatch_mode,
              o.created_at,o.updated_at,o.created_by,
              a.id AS application_id,a.status AS application_status,a.city,a.contact_email,a.contact_phone,
              COALESCE(array_agg(DISTINCT sm.service_mode) FILTER (WHERE sm.service_mode IS NOT NULL), '{}') AS service_modes,
              count(*) OVER()::int AS total_count
         FROM organizations o
         LEFT JOIN LATERAL (
           SELECT id,status,city,contact_email,contact_phone,created_at
             FROM partner_applications WHERE organization_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1
         ) a ON true
         LEFT JOIN organization_service_modules sm ON sm.organization_id=o.id
        WHERE ($1::text IS NULL OR o.status=$1)
          AND ($2='' OR o.display_name ILIKE '%' || $2 || '%' OR o.legal_name ILIKE '%' || $2 || '%' OR a.city ILIKE '%' || $2 || '%')
        GROUP BY o.id,a.id,a.status,a.city,a.contact_email,a.contact_phone
        ORDER BY CASE WHEN o.status='PENDING_REVIEW' THEN 0 ELSE 1 END,o.created_at DESC,o.id
        LIMIT $3 OFFSET $4`, [status ?? null, search, pageSize, offset],
    );
    res.json({ data: { items: rows.map(({ total_count: _totalCount, ...row }) => row), page, pageSize, total: Number(rows[0]?.total_count ?? 0) } });
  }));

  async function reviewApplication(req: AuthenticatedRequest, res: Response, action: 'approve' | 'reject' | 'suspend') {
    const actorId = requiredUserId(req, ApiError);
    const organizationId = parseOrThrow(idSchema, req.params.id, ApiError);
    const { note } = parseOrThrow(reviewSchema, req.body ?? {}, ApiError);
    if (action !== 'approve' && !note) {
      throw new ApiError(400, 'A review reason is required', 'review_reason_required');
    }
    const result = await withTransaction(pool, async (client) => {
      const { rows: [organization] } = await client.query(
        'SELECT id,status FROM organizations WHERE id=$1 FOR UPDATE', [organizationId],
      );
      if (!organization) throw new ApiError(404, 'Organization not found', 'organization_not_found');
      if (action === 'approve' || action === 'reject') {
        if (organization.status !== 'PENDING_REVIEW') throw new ApiError(409, 'Only a pending application can be reviewed', 'invalid_organization_transition');
        const application = await client.query(
          `SELECT id FROM partner_applications WHERE organization_id=$1 AND status IN ('SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION')
           ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [organizationId],
        );
        if (!application.rows[0]) throw new ApiError(409, 'No reviewable partner application exists', 'application_not_reviewable');
        const accepted = action === 'approve';
        const nextOrganizationStatus = accepted ? 'ACTIVE' : 'REJECTED';
        const nextApplicationStatus = accepted ? 'APPROVED' : 'REJECTED';
        await client.query(
          `UPDATE organizations SET status=$2,reviewed_by=$3,reviewed_at=now(),status_reason=$4,updated_at=now() WHERE id=$1`,
          [organizationId, nextOrganizationStatus, actorId, note ?? null],
        );
        await client.query(
          `UPDATE partner_applications SET status=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4,updated_at=now() WHERE id=$1`,
          [application.rows[0].id, nextApplicationStatus, actorId, note ?? null],
        );
        await writeAudit(client, actorId, accepted ? 'partner.application.approved' : 'partner.application.rejected', organizationId, { applicationId: application.rows[0].id, note: note ?? null });
        return { id: organizationId, status: nextOrganizationStatus, applicationStatus: nextApplicationStatus };
      }
      if (organization.status !== 'ACTIVE') throw new ApiError(409, 'Only an active organization can be suspended', 'invalid_organization_transition');
      await client.query('UPDATE organizations SET status=\'SUSPENDED\',status_reason=$2,updated_at=now() WHERE id=$1', [organizationId, note ?? null]);
      await writeAudit(client, actorId, 'partner.organization.suspended', organizationId, { note: note ?? null });
      return { id: organizationId, status: 'SUSPENDED' };
    });
    res.json({ data: result });
  }

  router.post('/admin/partners/:id/approve', options.requireAuth, options.requireAdmin, asyncRoute(async (req, res) => reviewApplication(req, res, 'approve')));
  router.post('/admin/partners/:id/reject', options.requireAuth, options.requireAdmin, asyncRoute(async (req, res) => reviewApplication(req, res, 'reject')));
  router.post('/admin/partners/:id/suspend', options.requireAuth, options.requireAdmin, asyncRoute(async (req, res) => reviewApplication(req, res, 'suspend')));

  return router;
}
