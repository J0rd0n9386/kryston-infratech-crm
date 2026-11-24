/**
 * Queue endpoints: Calling Queue, My Work tabs, and summary badges.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { getSummary, getCallingQueue, getMyWork } = require('../lib/services/queue-service');
const { isCentral } = require('../middleware/rbac');
const { ForbiddenError } = require('../middleware/errors');
const { formatIST } = require('../lib/clock');

module.exports = function registerQueueRoutes(app, db) {
  // GET /api/queues/summary - sidebar badge counts
  app.get('/api/queues/summary', auth, (req, res, next) => {
    try {
      const summary = getSummary(db, req.user);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/queues/calling - list tasks needing contact
  app.get('/api/queues/calling', auth, (req, res, next) => {
    try {
      const empQuery = req.query.employee_id;
      if (empQuery && empQuery !== req.user.id && !isCentral(req.user)) {
        throw new ForbiddenError('You can only view your own calling queue.');
      }
      const scheduled = req.query.scheduled === '1' || req.query.scheduled === 'true';
      const tasks = getCallingQueue(db, req.user, { employee_id: empQuery, scheduled });
      res.json(tasks);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/queues/calling/history - list logged call outcomes and activity
  app.get('/api/queues/calling/history', auth, (req, res, next) => {
    try {
      const empQuery = req.query.employee_id;
      if (empQuery && empQuery !== req.user.id && !isCentral(req.user)) {
        throw new ForbiddenError('You can only view your own call history.');
      }
      const targetEmp = empQuery || req.user.id;
      const rows = db
        .prepare(
          `SELECT act.*,
                  l.customer_name, l.phone, l.location, l.requirement, l.stage AS lead_stage,
                  l.priority AS lead_priority, l.source AS lead_source,
                  t.task_type, t.status AS task_status, t.brief AS task_brief
           FROM task_activity act
           LEFT JOIN leads l ON l.id = act.lead_id
           LEFT JOIN tasks t ON t.id = act.task_id
           WHERE act.employee_id = ? AND act.kind = 'CALL'
           ORDER BY act.created_at DESC, act.id DESC
           LIMIT 200`,
        )
        .all(targetEmp);

      const stats = db
        .prepare(
          `SELECT
             COUNT(*) AS total_calls,
             SUM(CASE WHEN outcome = 'CONNECTED' THEN 1 ELSE 0 END) AS connected_calls,
             SUM(CASE WHEN outcome = 'CALLBACK_REQUESTED' THEN 1 ELSE 0 END) AS callbacks,
             SUM(CASE WHEN outcome IN ('NO_ANSWER', 'BUSY', 'SWITCHED_OFF') THEN 1 ELSE 0 END) AS missed_calls
           FROM task_activity
           WHERE employee_id = ? AND kind = 'CALL'`,
        )
        .get(targetEmp);

      res.json({
        history: rows.map((r) => ({
          ...r,
          created_at_ist: formatIST(r.created_at),
        })),
        stats: {
          total_calls: stats?.total_calls || 0,
          connected_calls: stats?.connected_calls || 0,
          callbacks: stats?.callbacks || 0,
          missed_calls: stats?.missed_calls || 0,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/queues/my-work?tab=active|waiting|sent|done
  app.get('/api/queues/my-work', auth, (req, res, next) => {
    try {
      const tab = req.query.tab || 'active';
      const showAll = (req.query.all === '1' || req.query.all === 'true') && isCentral(req.user);
      const allTime = req.query.all_time === '1' || req.query.all_time === 'true' || req.query.filter === 'all';
      const tasks = getMyWork(db, req.user, { tab, all: showAll, all_time: allTime, filter: req.query.filter });
      const summary = getSummary(db, req.user);
      res.json({
        tasks,
        counts: {
          active: summary.myWork.active,
          waiting: summary.myWork.waiting,
          review: summary.myWork.sent,
          sent: summary.myWork.sent,
          done: summary.myWork.done,
        },
      });
    } catch (err) {
      next(err);
    }
  });
};
