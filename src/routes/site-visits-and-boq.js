/**
 * Site Visit Scheduling and BOQ (Bill of Quantities) Routes.
 *
 * Implements structured site visit coordination and itemized BOQ generation
 * with integer paise financial precision.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const { z, validate } = require('../middleware/validate');
const { ValidationError, NotFoundError, ForbiddenError } = require('../middleware/errors');
const { audit, notify, logAction } = require('../lib/audit-notify');
const {
  getBoqForLead,
  addBoqItem,
  deleteBoqItem,
} = require('../lib/services/boq-service');

const scheduleVisitSchema = z.object({
  lead_id: z.string().trim().min(1),
  assigned_engineer: z.string().trim().min(1),
  scheduled_at: z.string().trim().min(1),
  site_address: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
}).strict();

const updateVisitSchema = z.object({
  status: z.enum(['Scheduled', 'Completed', 'Cancelled', 'Rescheduled']),
  notes: z.string().trim().max(2000).optional().nullable(),
  rescheduled_at: z.string().trim().optional().nullable(),
}).strict();

const createBoqItemSchema = z.object({
  quotation_id: z.string().trim().optional().nullable(),
  category: z.string().trim().min(1).max(80),
  item_name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  quantity: z.coerce.number().positive(),
  unit: z.string().trim().max(40).optional().default('nos'),
  rate_paise: z.coerce.number().int().min(0),
  gst_rate: z.coerce.number().min(0).max(100).optional().default(18.0),
}).strict();

const batchBoqSchema = z.object({
  quotation_id: z.string().trim().optional().nullable(),
  items: z.array(
    z.object({
      category: z.string().trim().min(1).max(80),
      item_name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).optional().nullable(),
      quantity: z.coerce.number().positive(),
      unit: z.string().trim().max(40).optional().default('nos'),
      rate_paise: z.coerce.number().int().min(0),
      gst_rate: z.coerce.number().min(0).max(100).optional().default(18.0),
    }),
  ).min(1, 'At least one BOQ item is required.'),
}).strict();

module.exports = function registerSiteVisitAndBoqRoutes(app, db) {
  /* ------------------------------------------------------------- Site Visits */

  app.get('/api/site-visits', auth, (req, res, next) => {
    try {
      let sql = `
        SELECT sv.*, l.customer_name, l.phone, l.location, eng.name AS engineer_name
        FROM site_visits_schedule sv
        JOIN leads l ON l.id = sv.lead_id
        JOIN employees eng ON eng.id = sv.assigned_engineer
        WHERE 1=1
      `;
      const params = [];

      if (req.query.lead_id) {
        sql += ' AND sv.lead_id = ?';
        params.push(req.query.lead_id);
      }
      if (req.query.engineer_id) {
        sql += ' AND sv.assigned_engineer = ?';
        params.push(req.query.engineer_id);
      } else if (!isCentral(req.user) && req.user.role === 'SITE_ENGINEER') {
        sql += ' AND sv.assigned_engineer = ?';
        params.push(req.user.id);
      }
      if (req.query.status) {
        sql += ' AND sv.status = ?';
        params.push(req.query.status);
      }

      sql += ' ORDER BY sv.scheduled_at ASC';
      const rows = db.prepare(sql).all(...params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/site-visits/schedule',
    auth,
    requireCentral(),
    validate({ body: scheduleVisitSchema }),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT id, customer_name, stage FROM leads WHERE id = ?').get(req.body.lead_id);
        if (!lead) throw new NotFoundError('Lead not found.');

        const engineer = db.prepare('SELECT id, name, role, active FROM employees WHERE id = ?').get(req.body.assigned_engineer);
        if (!engineer || !engineer.active) throw new ValidationError('Assigned engineer must be an active employee.');

        const visitId = `VISIT-${Date.now().toString(36).toUpperCase()}`;

        db.transaction(() => {
          db.prepare(`
            INSERT INTO site_visits_schedule (id, lead_id, assigned_engineer, scheduled_at, status, site_address, notes, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'Scheduled', ?, ?, ?, datetime('now'), datetime('now'))
          `).run(
            visitId,
            lead.id,
            engineer.id,
            req.body.scheduled_at,
            req.body.site_address || null,
            req.body.notes || null,
            req.user.id,
          );

          // Update lead stage to Site Visit Scheduled
          db.prepare(`
            UPDATE leads
            SET stage = 'Site Visit Scheduled', assigned_engineer = ?, current_owner = ?, updated_at = datetime('now'), version = version + 1
            WHERE id = ?
          `).run(engineer.id, engineer.id, lead.id);

          logAction(
            db,
            lead.id,
            'SITE_VISIT_SCHEDULED',
            req.user.id,
            engineer.id,
            'Technical',
            `Site visit scheduled for ${req.body.scheduled_at} with engineer ${engineer.name}`,
            lead.stage,
            'Site Visit Scheduled',
          );

          notify(
            db,
            engineer.id,
            'SITE_VISIT_SCHEDULED',
            `Site visit scheduled for ${lead.customer_name} on ${req.body.scheduled_at}`,
            '#sitevisits',
            'lead',
            lead.id,
          );

          audit(
            db,
            req.user.id,
            'SCHEDULE_SITE_VISIT',
            'site_visit',
            visitId,
            `Scheduled visit for lead ${lead.id} on ${req.body.scheduled_at}`,
            null,
            { visitId, lead_id: lead.id, engineer: engineer.id, scheduled_at: req.body.scheduled_at },
            req.ip,
          );
        })();

        const created = db.prepare('SELECT * FROM site_visits_schedule WHERE id = ?').get(visitId);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  app.patch(
    '/api/site-visits/:id',
    auth,
    validate({ body: updateVisitSchema }),
    (req, res, next) => {
      try {
        const visit = db.prepare('SELECT * FROM site_visits_schedule WHERE id = ?').get(req.params.id);
        if (!visit) throw new NotFoundError('Site visit not found.');

        if (!isCentral(req.user) && visit.assigned_engineer !== req.user.id) {
          throw new ForbiddenError('Only the assigned engineer or Admin Desk can update this site visit.');
        }

        const status = req.body.status;
        const notes = req.body.notes ? String(req.body.notes).trim() : visit.notes;
        const scheduledAt = (status === 'Rescheduled' && req.body.rescheduled_at) ? req.body.rescheduled_at : visit.scheduled_at;

        db.transaction(() => {
          db.prepare(`
            UPDATE site_visits_schedule
            SET status = ?, notes = ?, scheduled_at = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(status, notes, scheduledAt, visit.id);

          if (status === 'Completed') {
            logAction(
              db,
              visit.lead_id,
              'SITE_VISIT_COMPLETED',
              req.user.id,
              null,
              'Technical',
              `Site visit completed by engineer.${notes ? ` Notes: ${notes}` : ''}`,
              'Site Visit Scheduled',
              'Update Received',
            );
          }

          audit(
            db,
            req.user.id,
            'UPDATE_SITE_VISIT',
            'site_visit',
            visit.id,
            `Visit status ${visit.status} -> ${status}`,
            visit,
            { status, notes, scheduled_at: scheduledAt },
            req.ip,
          );
        })();

        const updated = db.prepare('SELECT * FROM site_visits_schedule WHERE id = ?').get(visit.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  /* --------------------------------------------------------------------- BOQ */

  app.get('/api/leads/:id/boq', auth, (req, res, next) => {
    try {
      const quotationId = req.query.quotation_id || null;
      const data = getBoqForLead(db, req.params.id, quotationId);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/leads/:id/boq',
    auth,
    validate({ body: createBoqItemSchema }),
    (req, res, next) => {
      try {
        const item = addBoqItem(db, req.user, {
          lead_id: req.params.id,
          quotation_id: req.body.quotation_id,
          category: req.body.category,
          item_name: req.body.item_name,
          description: req.body.description,
          quantity: req.body.quantity,
          unit: req.body.unit,
          rate_paise: req.body.rate_paise,
          gst_rate: req.body.gst_rate,
        });

        res.status(201).json(item);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/leads/:id/boq/batch',
    auth,
    validate({ body: batchBoqSchema }),
    (req, res, next) => {
      try {
        const savedItems = [];
        db.transaction(() => {
          for (const itemData of req.body.items) {
            const item = addBoqItem(db, req.user, {
              lead_id: req.params.id,
              quotation_id: req.body.quotation_id,
              category: itemData.category,
              item_name: itemData.item_name,
              description: itemData.description,
              quantity: itemData.quantity,
              unit: itemData.unit,
              rate_paise: itemData.rate_paise,
              gst_rate: itemData.gst_rate,
            });
            savedItems.push(item);
          }
        })();

        res.status(201).json({ count: savedItems.length, items: savedItems });
      } catch (err) {
        next(err);
      }
    },
  );

  app.delete('/api/boq/:id', auth, (req, res, next) => {
    try {
      const result = deleteBoqItem(db, req.user, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });
};
