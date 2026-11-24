/**
 * Employee directory and account administration.
 */
'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const {
  requireFields,
  sanitizeText,
  isValidEmail,
  isValidPhone,
  passwordIssues,
  assertPassword,
  assertEnum,
  validate,
  z,
} = require('../middleware/validate');
const { ValidationError, ConflictError, NotFoundError } = require('../middleware/errors');
const { audit } = require('../lib/audit-notify');
const { ROLES, DEPARTMENTS } = require('../db/schema');

const createEmployeeSchema = z.object({
  name: z.string().trim().min(2, 'Enter the employee name.').max(120),
  email: z.string().trim().email('Enter a valid email address.'),
  role: z.enum(ROLES),
  department: z.enum(DEPARTMENTS).optional().nullable(),
  password: z.string().superRefine((val, ctx) => {
    const issues = passwordIssues(val);
    if (issues.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The password must contain ${issues.join(', ')}.`,
      });
    }
  }),
  phone: z.string().trim().optional().nullable(),
  manager_id: z.string().trim().optional().nullable(),
}).strict();

const updateEmployeeSchema = z.object({
  name: z.string().trim().min(2).max(120).optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  role: z.enum(ROLES).optional().nullable(),
  department: z.enum(DEPARTMENTS).optional().nullable(),
  manager_id: z.string().trim().optional().nullable(),
  active: z.union([z.boolean(), z.number()]).optional().nullable(),
  password: z.string().superRefine((val, ctx) => {
    const issues = passwordIssues(val);
    if (issues.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The new password must contain ${issues.join(', ')}.`,
      });
    }
  }).optional().nullable(),
}).strict();

const ROLE_PREFIX = {
  SUPER_ADMIN: 'SA',
  ADMIN_DESK: 'AD',
  SALES_MANAGER: 'SM',
  SENIOR_BDM: 'SBDM',
  BDM: 'BDM',
  BDE: 'BDE',
  TELECALLER: 'TC',
  SITE_ENGINEER: 'SE',
  ARCHITECT: 'AR',
  DIGITAL_MARKETING: 'DM',
  PROJECT_MANAGER: 'PM',
  PURCHASE: 'PUR',
  ACCOUNTS: 'AC',
};

const ROLE_DEPARTMENT = {
  SUPER_ADMIN: 'Management',
  ADMIN_DESK: 'Administration',
  SALES_MANAGER: 'Sales',
  SENIOR_BDM: 'Sales',
  BDM: 'Sales',
  BDE: 'Sales',
  TELECALLER: 'Marketing',
  SITE_ENGINEER: 'Technical',
  ARCHITECT: 'Design',
  DIGITAL_MARKETING: 'Marketing',
  PROJECT_MANAGER: 'Projects',
  PURCHASE: 'Purchase',
  ACCOUNTS: 'Accounts',
};

function nextEmployeeId(db, role) {
  const prefix = ROLE_PREFIX[role] || 'EMP';
  const pattern = `KRY-${prefix}-%`;
  const row = db
    .prepare('SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS max_seq FROM employees WHERE id LIKE ?')
    .get(pattern.length, pattern);
  const next = (Number(row && row.max_seq) || 0) + 1;
  return `KRY-${prefix}-${String(next).padStart(3, '0')}`;
}

function activeCentralCount(db, excludeId = null) {
  const row = db
    .prepare(
      `SELECT count(*) AS c FROM employees
       WHERE active = 1 AND role IN ('SUPER_ADMIN','ADMIN_DESK') AND id IS NOT ?`,
    )
    .get(excludeId);
  return row.c;
}

function validateManager(db, managerId, selfId) {
  if (!managerId) return null;
  if (managerId === selfId) throw new ValidationError('An employee cannot report to themselves.');
  const manager = db
    .prepare('SELECT id, active FROM employees WHERE id = ?')
    .get(managerId);
  if (!manager) throw new ValidationError('The selected manager does not exist.');
  if (!manager.active) throw new ValidationError('The selected manager is inactive.');
  return manager.id;
}

module.exports = function registerEmployeeRoutes(app, db) {
  app.get('/api/employees', auth, (req, res) => {
    if (isCentral(req.user)) {
      const rows = db
        .prepare(
          `SELECT e.id, e.name, e.email, e.phone, e.role, e.department, e.manager_id,
                  e.active, e.joined_at, e.last_login_at, m.name AS manager_name
           FROM employees e
           LEFT JOIN employees m ON m.id = e.manager_id
           ORDER BY e.department, e.role, e.name`,
        )
        .all();
      return res.json(rows);
    }

    const rows = db
      .prepare(
        `SELECT e.id, e.name, e.role, e.department, e.manager_id, e.active,
                m.name AS manager_name
         FROM employees e
         LEFT JOIN employees m ON m.id = e.manager_id
         WHERE e.department = ? OR e.manager_id = ? OR e.id = ?
         ORDER BY e.name`,
      )
      .all(req.user.department, req.user.id, req.user.id);
    return res.json(rows);
  });

  app.get('/api/employees/:id', auth, requireCentral(), (req, res, next) => {
    try {
      const row = db
        .prepare(
          `SELECT e.id, e.name, e.email, e.phone, e.role, e.department, e.manager_id,
                  e.active, e.joined_at, e.last_login_at, m.name AS manager_name
           FROM employees e
           LEFT JOIN employees m ON m.id = e.manager_id
           WHERE e.id = ?`,
        )
        .get(req.params.id);
      if (!row) throw new NotFoundError('Employee not found.');
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/employees',
    auth,
    requireCentral(),
    validate({ body: createEmployeeSchema }),
    (req, res, next) => {
      try {
        const name = sanitizeText(req.body.name, 120);
        const email = String(req.body.email || '').trim().toLowerCase();
        const role = assertEnum(String(req.body.role || ''), ROLES, 'role');
        const department = assertEnum(
          String(req.body.department || ROLE_DEPARTMENT[role] || ''),
          DEPARTMENTS,
          'department',
        );
        const phone = req.body.phone ? String(req.body.phone).trim() : null;
        const managerId = req.body.manager_id ? String(req.body.manager_id) : null;

        if (!name || name.length < 2) throw new ValidationError('Enter the employee name.');
        if (!isValidEmail(email)) throw new ValidationError('Enter a valid email address.');
        if (phone && !isValidPhone(phone)) throw new ValidationError('Enter a valid phone number.');
        assertPassword(req.body.password);

        if (db.prepare('SELECT 1 FROM employees WHERE email = ?').get(email)) {
          throw new ConflictError('An employee with this email address already exists.');
        }
        validateManager(db, managerId, null);

        const id = nextEmployeeId(db, role);
        const hash = bcrypt.hashSync(String(req.body.password), config.bcryptRounds);

        db.prepare(
          `INSERT INTO employees
            (id, name, email, phone, password_hash, role, department, manager_id, active, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        ).run(id, name, email, phone, hash, role, department, managerId);

        audit(
          db,
          req.user.id,
          'CREATE',
          'employee',
          id,
          `Created ${name} (${role}, ${department})`,
          null,
          { id, name, email, role, department },
          req.ip,
        );

        res.status(201).json({ id, name, email, role, department, manager_id: managerId });
      } catch (err) {
        next(err);
      }
    },
  );

  app.patch(
    '/api/employees/:id',
    auth,
    requireCentral(),
    validate({ body: updateEmployeeSchema }),
    (req, res, next) => {
    try {
      const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
      if (!employee) throw new NotFoundError('Employee not found.');

      const updates = {};
      if (req.body.name !== undefined) {
        const name = sanitizeText(req.body.name, 120);
        if (!name || name.length < 2) throw new ValidationError('Enter a valid employee name.');
        updates.name = name;
      }
      if (req.body.phone !== undefined) {
        const phone = req.body.phone ? String(req.body.phone).trim() : null;
        if (phone && !isValidPhone(phone)) throw new ValidationError('Enter a valid phone number.');
        updates.phone = phone;
      }
      if (req.body.role !== undefined) {
        updates.role = assertEnum(String(req.body.role), ROLES, 'role');
      }
      if (req.body.department !== undefined) {
        updates.department = assertEnum(String(req.body.department), DEPARTMENTS, 'department');
      }
      if (req.body.manager_id !== undefined) {
        const managerId = req.body.manager_id ? String(req.body.manager_id) : null;
        updates.manager_id = validateManager(db, managerId, employee.id);
      }
      if (req.body.active !== undefined) {
        const active = req.body.active === true || req.body.active === 1 || req.body.active === '1' ? 1 : 0;
        if (employee.id === req.user.id && active === 0) {
          throw new ValidationError('You cannot deactivate your own account.');
        }
        updates.active = active;
      }
      if (req.body.password) {
        assertPassword(req.body.password, 'new password');
        updates.password_hash = bcrypt.hashSync(String(req.body.password), config.bcryptRounds);
        updates.token_version = Number(employee.token_version || 0) + 1;
      }

      if (!Object.keys(updates).length) {
        throw new ValidationError('No supported fields were supplied.');
      }

      const nextRole = updates.role || employee.role;
      const nextActive = updates.active !== undefined ? updates.active : employee.active;
      const wasCentral = ['SUPER_ADMIN', 'ADMIN_DESK'].includes(employee.role);
      const willBeCentral = ['SUPER_ADMIN', 'ADMIN_DESK'].includes(nextRole);
      if (wasCentral && (!willBeCentral || !nextActive) && activeCentralCount(db, employee.id) === 0) {
        throw new ValidationError('At least one active central administrator must remain.');
      }

      const columns = Object.keys(updates);
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      db.prepare(`UPDATE employees SET ${assignments} WHERE id = ?`).run(
        ...columns.map((column) => updates[column]),
        employee.id,
      );

      const after = db
        .prepare(
          `SELECT id, name, email, phone, role, department, manager_id, active
           FROM employees WHERE id = ?`,
        )
        .get(employee.id);
      const before = {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        phone: employee.phone,
        role: employee.role,
        department: employee.department,
        manager_id: employee.manager_id,
        active: employee.active,
      };
      audit(db, req.user.id, 'UPDATE', 'employee', employee.id, `Updated ${employee.name}`, before, after, req.ip);

      res.json({ ok: true, employee: after });
    } catch (err) {
      next(err);
    }
  });
};
