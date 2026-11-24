/**
 * Notification Preferences Routes.
 * Allows employees to view and update their per-event notification channel preferences.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { audit } = require('../lib/audit-notify');
const {
  SUPPORTED_EVENTS,
  getEmployeePreferences,
  setEmployeePreference,
} = require('../lib/notifications/preferences');

const updatePreferenceSchema = z
  .object({
    event_type: z.enum([
      'TASK_ASSIGNED',
      'UPDATE_SUBMITTED',
      'SLA_BREACH',
      'WO_APPROVED',
      'REWORK_REQUESTED',
      'DAILY_DIGEST',
    ]),
    channel_in_app: z.boolean().optional(),
    channel_email: z.boolean().optional(),
    channel_whatsapp: z.boolean().optional(),
  })
  .strict();

module.exports = function registerNotificationPreferencesRoutes(app, db) {
  // Get current user's notification preferences
  function getPreferencesHandler(req, res, next) {
    try {
      const preferences = getEmployeePreferences(db, req.user.id);
      res.json({
        employee_id: req.user.id,
        preferences,
      });
    } catch (err) {
      next(err);
    }
  }

  app.get('/api/notification-preferences', auth, getPreferencesHandler);
  app.get('/api/notifications/preferences', auth, getPreferencesHandler);

  // Update current user's notification preferences
  function updatePreferencesHandler(req, res, next) {
    try {
      const { event_type, channel_in_app, channel_email, channel_whatsapp } = req.body;
      const beforeState = getEmployeePreferences(db, req.user.id)[event_type];

      const updated = setEmployeePreference(db, req.user.id, event_type, {
        channel_in_app,
        channel_email,
        channel_whatsapp,
      });

      audit(
        db,
        req.user.id,
        'NOTIFICATION_PREFERENCES_UPDATED',
        'employee',
        req.user.id,
        `Updated notification preferences for event ${event_type}`,
        beforeState,
        updated,
        req.ip,
      );

      res.json({
        success: true,
        preference: updated,
      });
    } catch (err) {
      next(err);
    }
  }

  app.put(
    '/api/notification-preferences',
    auth,
    validate({ body: updatePreferenceSchema }),
    updatePreferencesHandler,
  );
  app.put(
    '/api/notifications/preferences',
    auth,
    validate({ body: updatePreferenceSchema }),
    updatePreferencesHandler,
  );
};
