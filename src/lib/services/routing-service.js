/**
 * Auto-Routing Service: Rule-driven lead assignment engine.
 *
 * Evaluates routing_rules table on lead ingestion and assigns qualifying leads
 * (e.g. Meta Ads, Google) to telecallers via round-robin workload balancing.
 * Admin Desk always maintains full override authority.
 */
'use strict';

function resolveAutoRouting(db, { source, channel }) {
  if (!source) return null;

  try {
    const rule = db
      .prepare(`
        SELECT * FROM routing_rules
        WHERE active = 1 AND source = ?
        ORDER BY id ASC LIMIT 1
      `)
      .get(source);

    if (!rule) return null;

    if (rule.strategy === 'ROUND_ROBIN') {
      // Find active eligible employees for target role
      const eligible = db
        .prepare(`
          SELECT e.id, e.name, e.role,
                 (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = e.id AND t.status IN ('Assigned', 'In Progress')) AS active_tasks
          FROM employees e
          WHERE e.active = 1 AND e.role = ?
          ORDER BY active_tasks ASC, e.id ASC
        `)
        .all(rule.target_role);

      if (!eligible.length) return null;

      // Select employee with the lowest current active task load
      const selected = eligible[0];

      return {
        rule_id: rule.id,
        department: rule.target_dept,
        role: rule.target_role,
        assigned_to: selected.id,
        employee_name: selected.name,
      };
    }
  } catch {
    return null;
  }

  return null;
}

module.exports = {
  resolveAutoRouting,
};
