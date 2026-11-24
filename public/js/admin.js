/**
 * Central administration: employee directory and the audit trail.
 */
"use strict";

(function () {
  const KRY = window.KRY;
  const {
    el,
    icon,
    api,
    pageHead,
    card,
    statCard,
    clear,
    emptyState,
    kv,
    dataTable,
    badge,
    fmtDate,
    fmtDateTime,
    timeAgo,
    toast,
    openFormModal,
    isCentral,
    registerPage,
    getEmployees,
    optionsFor,
    roleBadge,
    statusBadge,
  } = KRY;

  const ROLES = [
    "SUPER_ADMIN",
    "ADMIN_DESK",
    "SALES_MANAGER",
    "SENIOR_BDM",
    "BDM",
    "BDE",
    "TELECALLER",
    "SITE_ENGINEER",
    "ARCHITECT",
    "DIGITAL_MARKETING",
    "PROJECT_MANAGER",
    "PURCHASE",
    "ACCOUNTS",
  ];

  const DEPARTMENTS = [
    "Management",
    "Administration",
    "Sales",
    "Marketing",
    "Technical",
    "Design",
    "Projects",
    "Purchase",
    "Accounts",
  ];

  const ROLE_DEPARTMENT = {
    SUPER_ADMIN: "Management",
    ADMIN_DESK: "Administration",
    SALES_MANAGER: "Sales",
    SENIOR_BDM: "Sales",
    BDM: "Sales",
    BDE: "Sales",
    TELECALLER: "Marketing",
    SITE_ENGINEER: "Technical",
    ARCHITECT: "Design",
    DIGITAL_MARKETING: "Marketing",
    PROJECT_MANAGER: "Projects",
    PURCHASE: "Purchase",
    ACCOUNTS: "Accounts",
  };

  function roleOptions() {
    return ROLES.map((role) => ({
      value: role,
      label: KRY.ROLE_LABELS[role] || role,
    }));
  }

  function departmentOptions() {
    return DEPARTMENTS.map((department) => ({
      value: department,
      label: department,
    }));
  }

  function managerOptions(employees, excludeId) {
    return [
      { value: "", label: "No manager" },
      ...employees
        .filter(
          (employee) => employee.id !== excludeId && employee.active !== 0,
        )
        .map((employee) => ({
          value: employee.id,
          label: `${employee.name} · ${KRY.ROLE_LABELS[employee.role] || employee.role}`,
        })),
    ];
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  /* ------------------------------------------------------------ Employees */

  registerPage("employees", async () => {
    const employees = await getEmployees(true);
    const wrap = el("div", { class: "stack" });

    const active = employees.filter((employee) => employee.active !== 0).length;
    const centralCount = employees.filter((employee) =>
      ["SUPER_ADMIN", "ADMIN_DESK"].includes(employee.role),
    ).length;
    const departments = new Set(
      employees.map((employee) => employee.department),
    ).size;

    wrap.appendChild(
      pageHead(
        "Employee Directory",
        "Create accounts, set reporting lines and deactivate leavers. Passwords must be at least 12 characters with a letter and a number.",
        [
          el(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onClick: () => openEmployeeCreate(employees),
            },
            icon("plus"),
            "New employee",
          ),
        ],
      ),
    );

    wrap.appendChild(
      el(
        "div",
        { class: "grid grid-3" },
        statCard("Team members", String(employees.length), `${active} active`),
        statCard(
          "Central authority",
          String(centralCount),
          "Super Admin + Admin Desk",
          "accent",
        ),
        statCard(
          "Departments",
          String(departments),
          "Represented in the directory",
        ),
      ),
    );

    wrap.appendChild(
      card(
        "Directory",
        "Role determines the RBAC matrix; department determines the queue",
        dataTable(
          [
            "Employee",
            "Contact",
            "Role",
            "Department",
            "Manager",
            "Status",
            "Last login",
            "",
          ],
          employees.map((employee) => ({
            cells: [
              el(
                "div",
                {},
                el("div", { class: "cell-title", text: employee.name }),
                el("div", { class: "cell-sub mono", text: employee.id }),
              ),
              el(
                "div",
                {},
                el("div", { text: employee.email }),
                el("div", { class: "cell-sub", text: employee.phone || "—" }),
              ),
              roleBadge(employee.role),
              employee.department,
              employee.manager_name || "—",
              badge(
                employee.active ? "Active" : "Inactive",
                employee.active ? "good" : "danger",
              ),
              employee.last_login_at
                ? timeAgo(employee.last_login_at)
                : "Never",
              el("button", {
                class: "btn btn-sm",
                type: "button",
                text: "Edit",
                onClick: () => openEmployeeEdit(employee, employees),
              }),
            ],
          })),
          {
            emptyTitle: "No employees",
            emptyMessage: "Create the first employee account.",
          },
        ),
        { tight: true },
      ),
    );

    return wrap;
  });

  function openEmployeeCreate(employees) {
    openFormModal({
      title: "Create employee account",
      subtitle: "A role and department determine every permission and queue",
      submitLabel: "Create account",
      fields: [
        { name: "name", label: "Full name", required: true },
        { name: "email", label: "Email", type: "email", required: true },
        { name: "phone", label: "Phone", placeholder: "10 to 15 digits" },
        {
          name: "role",
          label: "Role",
          type: "select",
          required: true,
          value: "BDE",
          options: roleOptions(),
        },
        {
          name: "department",
          label: "Department",
          type: "select",
          required: true,
          value: "Sales",
          options: departmentOptions(),
        },
        {
          name: "manager_id",
          label: "Reports to",
          type: "select",
          options: managerOptions(employees),
        },
        {
          name: "password",
          label: "Temporary password",
          type: "password",
          required: true,
          autocomplete: "new-password",
          hint: "Minimum 12 characters, including a letter and a number.",
        },
      ],
      onSubmit: async (values) => {
        if (!values.name.trim()) throw new Error("Enter the employee name.");
        if (!values.email.trim()) throw new Error("Enter the email address.");
        if (!values.password) throw new Error("Enter a temporary password.");
        const created = await api("/employees", {
          method: "POST",
          body: values,
        });
        toast(`Employee ${created.id} created.`, "success");
      },
      onSuccess: () => {
        KRY.state.employees = null;
        KRY.state.employeesAt = 0;
        KRY.renderRoute();
      },
    });
  }

  function openEmployeeEdit(employee, employees) {
    openFormModal({
      title: `Edit ${employee.name}`,
      subtitle: `${employee.id} · ${employee.email}`,
      submitLabel: "Save changes",
      fields: [
        {
          name: "name",
          label: "Full name",
          required: true,
          value: employee.name,
        },
        { name: "phone", label: "Phone", value: employee.phone || "" },
        {
          name: "role",
          label: "Role",
          type: "select",
          value: employee.role,
          options: roleOptions(),
        },
        {
          name: "department",
          label: "Department",
          type: "select",
          value: employee.department,
          options: departmentOptions(),
        },
        {
          name: "manager_id",
          label: "Reports to",
          type: "select",
          value: employee.manager_id || "",
          options: managerOptions(employees, employee.id),
        },
        {
          name: "active",
          label: "Account is active",
          type: "checkbox",
          value: employee.active !== 0,
        },
        {
          name: "password",
          label: "Reset password (optional)",
          type: "password",
          autocomplete: "new-password",
          hint: "Leave blank to keep the current password. Resetting revokes active sessions.",
        },
      ],
      onSubmit: async (values) => {
        const body = {
          name: values.name,
          phone: values.phone,
          role: values.role,
          department: values.department,
          manager_id: values.manager_id || null,
          active: Boolean(values.active),
        };
        if (values.password) body.password = values.password;
        await api(`/employees/${employee.id}`, { method: "PATCH", body });
        toast("Employee updated.", "success");
      },
      onSuccess: () => {
        KRY.state.employees = null;
        KRY.state.employeesAt = 0;
        KRY.renderRoute();
      },
    });
  }

  /* ---------------------------------------------------------------- Audit */

  registerPage("audit", async () => {
    const [audit, health] = await Promise.all([
      api("/audit?limit=300"),
      api("/audit/system-health"),
    ]);
    const wrap = el("div", { class: "stack" });

    wrap.appendChild(
      pageHead(
        "Audit Log",
        "Append-only record of privileged actions. Rows cannot be updated or deleted by any role.",
        [
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onClick: () =>
                KRY.download("/export/timeline.xls", "timeline.xls"),
            },
            icon("doc"),
            "Export timeline",
          ),
        ],
      ),
    );

    const rowCounts = health.stats.rowCounts || {};
    wrap.appendChild(
      el(
        "div",
        { class: "grid grid-4" },
        statCard(
          "Audit events",
          String(rowCounts.audit_log ?? audit.total ?? 0),
          "Immutable records",
        ),
        statCard(
          "Lead timeline rows",
          String(rowCounts.lead_actions ?? 0),
          "Immutable actions",
        ),
        statCard(
          "Database size",
          formatBytes(health.stats.totalSizeBytes),
          `${health.stats.tablesCount} tables · ${health.stats.journalMode}`,
        ),
        statCard(
          "Integrity",
          health.integrity.valid ? "Healthy" : "Check failed",
          health.integrity.valid
            ? "SQLite integrity + foreign keys"
            : "Inspect server logs",
          health.integrity.valid ? "good" : "danger",
        ),
      ),
    );

    wrap.appendChild(
      card(
        "System health",
        `Schema ${health.schema.version} · ${health.schema.schemaId}`,
        el(
          "div",
          { class: "grid grid-2" },
          kv([
            [
              "Integrity check",
              health.integrity.valid
                ? "ok"
                : health.integrity.integrityErrors.join("; "),
            ],
            [
              "Foreign key check",
              health.integrity.fkErrors.length ? "violations found" : "ok",
            ],
            ["Journal mode", health.stats.journalMode],
            ["Tables", String(health.stats.tablesCount)],
          ]),
          kv([
            ["Leads", String(rowCounts.leads ?? 0)],
            ["Tasks", String(rowCounts.tasks ?? 0)],
            ["Quotations", String(rowCounts.quotations ?? 0)],
            ["Work orders", String(rowCounts.work_orders ?? 0)],
            ["Projects", String(rowCounts.projects ?? 0)],
          ]),
        ),
      ),
    );

    wrap.appendChild(
      card(
        "Recent audit events",
        `${audit.total} event(s) on record · showing ${audit.rows.length}`,
        dataTable(
          ["Time", "Actor", "Action", "Entity", "Details", "IP"],
          audit.rows.map((entry) => ({
            cells: [
              el("span", {
                title: fmtDateTime(entry.created_at),
                text: timeAgo(entry.created_at),
              }),
              el(
                "div",
                {},
                el("div", {
                  class: "cell-title",
                  text: entry.actor_name || "System",
                }),
                el("div", { class: "cell-sub", text: entry.actor_role || "" }),
              ),
              el("span", { class: "mono", text: entry.action }),
              el(
                "div",
                {},
                el("div", { text: entry.entity_type }),
                el("div", {
                  class: "cell-sub mono",
                  text: entry.entity_id || "",
                }),
              ),
              el("span", {
                class: "small",
                text: String(entry.details || "—").slice(0, 180),
              }),
              entry.ip_address || "—",
            ],
          })),
          {
            emptyTitle: "No audit events",
            emptyMessage: "Privileged actions will be recorded here.",
          },
        ),
        { tight: true },
      ),
    );

    return wrap;
  });
})();
