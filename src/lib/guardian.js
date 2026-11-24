'use strict';

function contactAllowed(task, userId, channel = null) {
  let channels = [];
  try { channels = JSON.parse(task?.contact_channels || '[]'); } catch { channels = []; }
  const legacyTelecallerCall = channel === 'Call' && !channels.length && task?.task_type === 'TELECALLER_ENQUIRY';
  return Boolean(task && task.assigned_to === userId && task.contact_authorized_to === userId &&
    task.requires_contact && ['Assigned', 'In Progress'].includes(task.status) &&
    Date.parse(task.contact_expires_at) > Date.now() && (!channel || channels.includes(channel) || legacyTelecallerCall));
}

// Apply the same contact visibility rule to nested JSON returned by every API.
function protectContactResponses(db) {
  return (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (payload) => {
      if (!req.user || ['SUPER_ADMIN', 'ADMIN_DESK'].includes(req.user.role)) return json(payload);
      const permissionRows = db.prepare(`SELECT lead_id, task_type, contact_channels FROM tasks
        WHERE assigned_to = ? AND contact_authorized_to = ? AND requires_contact = 1
        AND status IN ('Assigned','In Progress') AND julianday(contact_expires_at) > julianday('now')`)
        .all(req.user.id, req.user.id);
      const permitted = new Map();
      for (const row of permissionRows) {
        let channels = [];
        try { channels = JSON.parse(row.contact_channels || '[]'); } catch { channels = []; }
        if (!channels.length && row.task_type === 'TELECALLER_ENQUIRY') channels = ['Call'];
        const current = permitted.get(row.lead_id) || new Set();
        channels.forEach((channel) => current.add(channel));
        permitted.set(row.lead_id, current);
      }
      function redact(value, parentLead) {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(item => redact(item, parentLead));
        const leadId = value.lead_id || (value.customer_name && value.id) || parentLead;
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
          const phoneField = ['phone', 'phone_normalized', 'customer_phone'].includes(key);
          const emailField = ['customer_email', 'email'].includes(key);
          const channels = permitted.get(leadId);
          const allowed = (phoneField && (channels?.has('Call') || channels?.has('WhatsApp')))
            || (emailField && channels?.has('Email'));
          result[key] = leadId && (phoneField || emailField) && !allowed ? null : redact(entry, leadId);
        }
        if (value.assigned_to && value.task_type) result.customer_contact_allowed = contactAllowed(value, req.user.id);
        return result;
      }
      return json(redact(payload));
    };
    next();
  };
}

module.exports = { contactAllowed, protectContactResponses };
