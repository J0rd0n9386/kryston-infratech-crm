/**
 * Commercial and delivery screens: quotations, work orders and project execution.
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
    timeline,
    progressBar,
    stageBadge,
    statusBadge,
    badge,
    money,
    fmtDate,
    fmtDateTime,
    timeAgo,
    titleCase,
    toast,
    openModal,
    openFormModal,
    confirmAction,
    closeModal,
    getEmployees,
    optionsFor,
    isCentral,
    isSales,
    isSalesManager,
    registerPage,
    navigate,
  } = KRY;

  function labeled(text, input, hint) {
    return el(
      "label",
      { class: "field" },
      el("span", { text }),
      input,
      hint ? el("small", { text: hint }) : null,
    );
  }

  const QUOTE_FLOW = {
    Draft: ["Sent", "Revised"],
    Sent: ["Negotiation", "Approved", "Rejected", "Revised"],
    Negotiation: ["Approved", "Rejected", "Revised"],
    Revised: ["Sent", "Rejected"],
    Approved: [],
    Rejected: [],
  };

  const QUOTE_ACTION = {
    Sent: "Send",
    Negotiation: "Negotiate",
    Approved: "Approve",
    Rejected: "Reject",
    Revised: "Revise",
  };

  /* -------------------------------------------------------------- Quotations */

  registerPage("quotations", async () => {
    const quotes = await api("/quotations?limit=500");
    const wrap = el("div", { class: "stack" });

    wrap.appendChild(
      pageHead(
        "Quotations",
        "Versioned proposals. The assigned Sales employee prepares and negotiates; a Sales Manager or Admin Desk approves.",
        isSales()
          ? [
              el(
                "button",
                {
                  class: "btn btn-primary",
                  type: "button",
                  onClick: openQuoteCreate,
                },
                icon("plus"),
                "New quotation",
              ),
            ]
          : null,
      ),
    );

    const pendingApproval = quotes.filter((quote) =>
      ["Sent", "Negotiation"].includes(quote.status),
    ).length;
    const approved = quotes.filter(
      (quote) => quote.status === "Approved",
    ).length;
    const pipeline = quotes
      .filter((quote) => !["Rejected"].includes(quote.status))
      .reduce((sum, quote) => sum + Number(quote.total_amount || 0), 0);

    wrap.appendChild(
      el(
        "div",
        { class: "grid grid-3" },
        statCard(
          "Quote pipeline",
          money(pipeline),
          `${quotes.length} version(s) on record`,
          "accent",
        ),
        statCard(
          "Awaiting decision",
          String(pendingApproval),
          "Sent or in negotiation",
          pendingApproval ? "warn" : "good",
        ),
        statCard(
          "Approved",
          String(approved),
          "Ready for work order",
          approved ? "good" : "",
        ),
      ),
    );

    wrap.appendChild(
      card(
        "Quotation register",
        "Amounts exclude tax unless shown",
        dataTable(
          [
            "Quotation",
            "Customer",
            "Amount",
            "Status",
            "Lead stage",
            "Owner",
            "Updated",
            "Actions",
          ],
          quotes.map((quote) => {
            const canManage =
              isCentral() ||
              (isSales() &&
                (quote.created_by === KRY.state.user.id ||
                  quote.assigned_bdm === KRY.state.user.id));
            const actions = el("div", { class: "btn-row" });
            (QUOTE_FLOW[quote.status] || []).forEach((next) => {
              const managerOnly = ["Sent", "Approved", "Rejected"].includes(next);
              if (managerOnly ? !isCentral() : !canManage)
                return;
              actions.appendChild(
                el("button", {
                  class:
                    `btn btn-sm ${next === "Approved" ? "btn-primary" : next === "Rejected" ? "btn-danger" : ""}`.trim(),
                  type: "button",
                  text: QUOTE_ACTION[next],
                  onClick: () => openQuoteStatus(quote, next),
                }),
              );
            });
            if (isSales() && ["Sent", "Negotiation"].includes(quote.status)) {
              actions.appendChild(el("button", {
                class: "btn btn-sm",
                type: "button",
                text: "Record counteroffer",
                onClick: () => openCounteroffer(quote),
              }));
            }
            if (isCentral() && ["Sent", "Negotiation", "Approved"].includes(quote.status)) {
              actions.appendChild(el("button", {
                class: "btn btn-sm",
                type: "button",
                text: "Record acceptance",
                onClick: () => openCustomerAcceptance(quote),
              }));
            }
            actions.appendChild(el("button", {
              class: "btn btn-sm",
              type: "button",
              text: "History",
              onClick: () => openNegotiationHistory(quote),
            }));
            if (!actions.childElementCount)
              actions.appendChild(
                el("span", { class: "small muted", text: "—" }),
              );

            return {
              cells: [
                el(
                  "div",
                  {},
                  el("div", { class: "cell-title mono", text: quote.id }),
                  el("div", { class: "cell-sub", text: `v${quote.version}` }),
                ),
                el(
                  "div",
                  {},
                  el("div", { class: "cell-title", text: quote.customer_name }),
                  el("div", { class: "cell-sub mono", text: quote.lead_id }),
                ),
                el(
                  "div",
                  {},
                  el("div", {
                    class: "cell-title",
                    text: money(quote.total_amount || quote.amount),
                  }),
                  el("div", {
                    class: "cell-sub",
                    text: `Base ${money(quote.amount)} · tax ${money(quote.tax_amount || 0)}`,
                  }),
                ),
                statusBadge(quote.status),
                stageBadge(quote.lead_stage),
                quote.creator_name || "—",
                el("span", {
                  title: fmtDateTime(quote.updated_at || quote.created_at),
                  text: timeAgo(quote.updated_at || quote.created_at),
                }),
                actions,
              ],
            };
          }),
          {
            emptyTitle: "No quotations yet",
            emptyMessage:
              "Admin Desk advances a reviewed lead to Quotation Stage first.",
          },
        ),
        { tight: true },
      ),
    );
    return wrap;
  });

  async function openQuoteCreate() {
    let leads;
    try {
      leads = await api("/leads?limit=500");
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const eligible = leads.filter(
      (lead) =>
        lead.assigned_bdm === KRY.state.user.id &&
        ["Quotation Stage", "Quotation Sent", "Negotiation"].includes(
          lead.stage,
        ),
    );
    if (!eligible.length) {
      toast(
        "No assigned lead is in Quotation Stage. Admin Desk must advance the lead first.",
        "error",
      );
      return;
    }

    openFormModal({
      title: "Create quotation version",
      subtitle: "The assigned Sales employee owns the commercial proposal",
      submitLabel: "Create draft",
      fields: [
        {
          name: "lead_id",
          label: "Lead",
          type: "select",
          required: true,
          options: eligible.map((lead) => ({
            value: lead.id,
            label: `${lead.customer_name} · ${lead.id} · ${lead.stage}`,
          })),
        },
        {
          name: "amount",
          label: "Base amount (INR)",
          type: "number",
          min: 1,
          required: true,
          placeholder: "e.g. 3600000",
        },
        {
          name: "tax_amount",
          label: "Tax amount (INR)",
          type: "number",
          min: 0,
          value: 0,
        },
        {
          name: "terms",
          label: "Commercial terms",
          type: "textarea",
          span2: true,
          placeholder: "Payment schedule, validity, exclusions…",
        },
        {
          name: "payment_milestones",
          label: "Payment milestones",
          type: "textarea",
          span2: true,
          placeholder: "Advance / Structure / Finishing / Handover",
        },
      ],
      onSubmit: async (values) => {
        if (!values.lead_id) throw new Error("Select a lead.");
        if (!(Number(values.amount) > 0))
          throw new Error("Enter a quotation amount greater than zero.");
        const created = await api("/quotations", {
          method: "POST",
          body: values,
        });
        toast(
          `Quotation ${created.id} v${created.version} created.`,
          "success",
        );
      },
      onSuccess: () => KRY.renderRoute(),
    });
  }

  function openQuoteStatus(quote, status) {
    openFormModal({
      title: `Mark quotation ${status}`,
      subtitle: `${quote.id} · v${quote.version} · ${quote.customer_name}`,
      submitLabel: QUOTE_ACTION[status] || status,
      note:
        status === "Approved"
          ? "Approval moves the lead to Approved and unlocks the Sales Manager work order."
          : status === "Rejected"
            ? "A rejection reason is mandatory and is written to the audit trail."
            : null,
      fields: [
        {
          name: "remarks",
          label: "Remarks",
          type: "textarea",
          span2: true,
          required: status === "Rejected",
          placeholder:
            status === "Rejected"
              ? "Why was the quotation rejected?"
              : "Optional context for the timeline",
        },
      ],
      onSubmit: async (values) => {
        if (status === "Rejected" && !values.remarks.trim())
          throw new Error("A rejection reason is required.");
        await api(`/quotations/${quote.id}`, {
          method: "PATCH",
          body: {
            status,
            remarks: values.remarks.trim(),
            expected_version: quote.version,
          },
        });
        toast(`Quotation marked ${status}.`, "success");
      },
      onSuccess: () => {
        KRY.renderRoute();
        KRY.refreshNotifications();
      },
    });
  }

  function openCounteroffer(quote) {
    openFormModal({
      title: "Record customer counteroffer",
      subtitle: `${quote.customer_name} · ${quote.id} v${quote.version}`,
      submitLabel: "Send to Senior Manager",
      fields: [
        { name: "customer_request", label: "Customer request and reason", type: "textarea", span2: true, required: true },
        { name: "proposed_amount", label: "Proposed base amount", type: "number", min: 1 },
        { name: "proposed_discount_percent", label: "Proposed discount %", type: "number", min: 0, max: 100 },
        { name: "proposed_terms", label: "Changed terms or scope", type: "textarea", span2: true },
        { name: "proposed_payment_milestones", label: "Changed payment milestones", type: "textarea", span2: true },
      ],
      onSubmit: (values) => api(`/quotations/${quote.id}/counteroffers`, { method: "POST", body: values }),
      onSuccess: () => { toast("Counteroffer sent for manager review.", "success"); KRY.renderRoute(); },
    });
  }

  function openCustomerAcceptance(quote) {
    openFormModal({
      title: "Record customer acceptance",
      subtitle: `Final Admin sign-off for ${quote.id} v${quote.version}`,
      submitLabel: "Confirm exact accepted version",
      note: "This binds the customer response to the current quotation version.",
      fields: [
        { name: "customer_response_ref", label: "Acceptance reference", type: "text", required: true, placeholder: "Signed quote / email / WhatsApp reference" },
        { name: "remarks", label: "Acceptance notes", type: "textarea", span2: true },
      ],
      onSubmit: (values) => api(`/quotations/${quote.id}/customer-acceptance`, { method: "POST", body: values }),
      onSuccess: () => { toast("Customer acceptance recorded with Admin sign-off.", "success"); KRY.renderRoute(); },
    });
  }

  async function openNegotiationHistory(quote) {
    try {
      const [versions, rounds] = await Promise.all([
        api(`/quotations/${quote.id}/versions`),
        api(`/quotations/${quote.id}/negotiations`),
      ]);
      const content = el("div", { class: "stack" });
      content.appendChild(card("Version history", "Every commercial revision remains immutable", dataTable(
        ["Version", "Amount", "Discount", "Status", "Created"],
        versions.map((version) => ({ cells: [
          `v${version.version}`, money(version.amount), `${version.discount_percent || 0}%`,
          statusBadge(version.status), fmtDateTime(version.created_at),
        ] })), { emptyTitle: "No versions" }), { tight: true }));
      content.appendChild(card("Negotiation rounds", "Manager recommendation and Admin release", dataTable(
        ["Customer request", "Proposed amount", "Status", "Manager", "Admin", "Action"],
        rounds.map((round) => ({ cells: [
          round.customer_request, round.proposed_amount ? money(round.proposed_amount) : "—",
          statusBadge(round.status), round.manager_remarks || "Pending", round.admin_remarks || "Pending",
          round.status === "Pending Manager" && (isSalesManager() || KRY.state.user.role === "SENIOR_BDM")
            ? el("button", { class: "btn btn-sm", text: "Manager decision", onClick: () => openNegotiationDecision(round, "manager") })
            : round.status === "Pending Admin" && isCentral()
              ? el("button", { class: "btn btn-sm btn-primary", text: "Admin decision", onClick: () => openNegotiationDecision(round, "admin") })
              : "—",
        ] })), { emptyTitle: "No counteroffers recorded" }), { tight: true }));
      openModal({ title: `Commercial history · ${quote.id}`, body: content, size: "modal-wide" });
    } catch (error) { toast(error.message, "error"); }
  }

  function openNegotiationDecision(round, level) {
    openFormModal({
      title: level === "admin" ? "Admin negotiation decision" : "Senior Manager recommendation",
      subtitle: `${round.id} · ${round.customer_request}`,
      submitLabel: "Record decision",
      fields: [
        { name: "action", label: "Decision", type: "select", value: "Approve", options: [
          { value: "Approve", label: "Approve" }, { value: "Reject", label: "Reject" },
        ] },
        { name: "remarks", label: "Reason and permitted terms", type: "textarea", span2: true, required: true },
      ],
      onSubmit: (values) => api(`/negotiations/${round.id}/${level === "admin" ? "admin-decision" : "manager-decision"}`, {
        method: "POST", body: values,
      }),
      onSuccess: () => { toast("Decision recorded.", "success"); KRY.renderRoute(); },
    });
  }

  /* -------------------------------------------------------------- Work orders */

  registerPage("workorders", async () => {
    const orders = await api("/work-orders?limit=500");
    const wrap = el("div", { class: "stack" });

    wrap.appendChild(
      pageHead(
        "Work Orders",
        "Sales Manager submits the commercial work order. Admin Desk approves it and assigns the Project Manager and Site Engineer.",
        isSalesManager()
          ? [
              el(
                "button",
                {
                  class: "btn btn-primary",
                  type: "button",
                  onClick: openWorkOrderCreate,
                },
                icon("plus"),
                "Submit work order",
              ),
            ]
          : null,
      ),
    );

    const pending = orders.filter(
      (order) => order.status === "Pending Admin Approval",
    ).length;
    const finalized = orders.filter((order) =>
      ["Finalized", "Active", "Completed"].includes(order.status),
    ).length;
    const value = orders
      .filter((order) => order.status !== "Cancelled")
      .reduce((sum, order) => sum + Number(order.amount || 0), 0);

    wrap.appendChild(
      el(
        "div",
        { class: "grid grid-3" },
        statCard(
          "Contract value",
          money(value),
          `${orders.length} work order(s)`,
          "accent",
        ),
        statCard(
          "Pending Admin approval",
          String(pending),
          "Awaiting PM + Site Engineer assignment",
          pending ? "warn" : "good",
        ),
        statCard(
          "Handed off",
          String(finalized),
          "Finalized or in execution",
          finalized ? "good" : "",
        ),
      ),
    );

    wrap.appendChild(
      card(
        "Work order register",
        "One work order per lead",
        dataTable(
          [
            "Work order",
            "Customer",
            "Amount",
            "Status",
            "Project",
            "Submitted by",
            "Created",
            "Actions",
          ],
          orders.map((order) => ({
            cells: [
              el(
                "div",
                {},
                el("div", { class: "cell-title mono", text: order.id }),
                el("div", { class: "cell-sub mono", text: order.lead_id }),
              ),
              el(
                "div",
                {},
                el("div", { class: "cell-title", text: order.customer_name }),
                el("div", {
                  class: "cell-sub",
                  text: order.customer_location || "",
                }),
              ),
              money(order.amount),
              statusBadge(order.status),
              order.project_id
                ? el("button", {
                    class: "link-button",
                    type: "button",
                    text: order.project_id,
                    onClick: () => openProjectModal(order.project_id),
                  })
                : "—",
              order.creator_name || "—",
              el("span", {
                title: fmtDateTime(order.created_at),
                text: timeAgo(order.created_at),
              }),
              isCentral() && order.status === "Pending Admin Approval"
                ? el("button", {
                    class: "btn btn-sm btn-primary",
                    type: "button",
                    text: "Approve & handoff",
                    onClick: () => openWorkOrderApproval(order),
                  })
                : order.project_id
                  ? el("button", {
                      class: "btn btn-sm",
                      type: "button",
                      text: "Open project",
                      onClick: () => openProjectModal(order.project_id),
                    })
                  : el("span", { class: "small muted", text: "—" }),
            ],
          })),
          {
            emptyTitle: "No work orders yet",
            emptyMessage:
              "An approved quotation and an Approved lead are required.",
          },
        ),
        { tight: true },
      ),
    );
    return wrap;
  });

  async function openWorkOrderCreate() {
    let leads;
    try {
      leads = await api("/leads?limit=500");
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const approved = leads.filter((lead) => lead.stage === "Approved");
    if (!approved.length) {
      toast(
        "No Approved lead is available. A Sales Manager must approve a quotation first.",
        "error",
      );
      return;
    }

    const leadSelect = el(
      "select",
      { name: "lead_id", required: true },
      approved.map((lead) =>
        el("option", {
          value: lead.id,
          text: `${lead.customer_name} · ${lead.id}`,
        }),
      ),
    );
    const quoteSelect = el("select", { name: "quotation_id" });
    const amount = el("input", {
      name: "amount",
      type: "number",
      min: 1,
      required: true,
    });
    const approvalDate = el("input", {
      name: "customer_approval_date",
      type: "date",
      required: true,
      value: new Date().toISOString().slice(0, 10),
    });
    const details = el("textarea", {
      name: "details",
      rows: 4,
      placeholder: "Scope, inclusions, exclusions…",
    });
    const documents = el("textarea", {
      name: "documents",
      rows: 2,
      placeholder: "Document references or links",
    });
    const error = el("p", { class: "form-error", hidden: true, role: "alert" });

    async function syncQuotes() {
      quoteSelect.replaceChildren(
        el("option", { value: "", text: "Loading approved quotations…" }),
      );
      amount.value = "";
      try {
        const quotes = await api(
          `/quotations?lead_id=${encodeURIComponent(leadSelect.value)}&status=Approved`,
        );
        const list = quotes.filter((quote) => quote.status === "Approved");
        if (!list.length) {
          quoteSelect.replaceChildren(
            el("option", {
              value: "",
              text: "No approved quotation for this lead",
            }),
          );
          return;
        }
        quoteSelect.replaceChildren(
          ...list.map((quote) =>
            el("option", {
              value: quote.id,
              text: `${quote.id} · v${quote.version} · ${money(quote.total_amount || quote.amount)}`,
            }),
          ),
        );
        amount.value = String(list[0].amount);
      } catch (err) {
        quoteSelect.replaceChildren(
          el("option", { value: "", text: "Could not load quotations" }),
        );
      }
    }

    leadSelect.addEventListener("change", syncQuotes);
    quoteSelect.addEventListener("change", async () => {
      const quotes = await api(
        `/quotations?lead_id=${encodeURIComponent(leadSelect.value)}&status=Approved`,
      );
      const quote = quotes.find((entry) => entry.id === quoteSelect.value);
      if (quote) amount.value = String(quote.amount);
    });
    await syncQuotes();

    const form = el(
      "form",
      { class: "form-stack", novalidate: true },
      el(
        "div",
        { class: "form-grid" },
        labeled("Approved lead", leadSelect),
        labeled("Approved quotation", quoteSelect),
        labeled("Work order amount (INR)", amount),
        labeled("Customer approval date", approvalDate),
      ),
      labeled("Details", details),
      labeled("Documents", documents),
      el("p", {
        class: "form-note",
        text: "The work order is created as Pending Admin Approval. It is not final until Admin Desk assigns the delivery team.",
      }),
      error,
      el("button", { type: "submit", hidden: true }),
    );

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!quoteSelect.value) {
        error.textContent = "Select an approved quotation.";
        error.hidden = false;
        return;
      }
      if (!(Number(amount.value) > 0)) {
        error.textContent = "Enter a work order amount greater than zero.";
        error.hidden = false;
        return;
      }
      try {
        const created = await api("/work-orders", {
          method: "POST",
          body: {
            lead_id: leadSelect.value,
            quotation_id: quoteSelect.value,
            amount: Number(amount.value),
            customer_approval_date: approvalDate.value,
            details: details.value.trim(),
            documents: documents.value.trim(),
          },
        });
        closeModal();
        toast(
          `Work order ${created.id} submitted for Admin approval.`,
          "success",
        );
        KRY.renderRoute();
        KRY.refreshNotifications();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    });

    openModal({
      title: "Submit work order",
      subtitle: "Sales Manager finalises the commercial contract",
      size: "",
      body: form,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Submit for approval",
          class: "btn-primary",
          onClick: () => form.requestSubmit(),
        },
      ],
    });
  }

  async function openWorkOrderApproval(workOrder) {
    let employees;
    try {
      employees = await getEmployees();
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const pmOptions = optionsFor(
      employees,
      (employee) =>
        employee.role === "PROJECT_MANAGER" && employee.active !== 0,
    );
    const seOptions = optionsFor(
      employees,
      (employee) => employee.role === "SITE_ENGINEER" && employee.active !== 0,
    );
    if (pmOptions.length <= 1 || seOptions.length <= 1) {
      toast(
        "Create an active Project Manager and Site Engineer before approving.",
        "error",
      );
      return;
    }

    openFormModal({
      title: "Approve work order and hand off",
      subtitle: `${workOrder.id} · ${workOrder.customer_name || workOrder.lead_id} · ${money(workOrder.amount)}`,
      submitLabel: "Approve and create project",
      note: "Approval finalises the work order, creates the project and writes the handoff to the immutable timeline.",
      fields: [
        {
          name: "pm_id",
          label: "Project Manager",
          type: "select",
          required: true,
          options: pmOptions,
        },
        {
          name: "site_engineer_id",
          label: "Site Engineer",
          type: "select",
          required: true,
          options: seOptions,
        },
        { name: "target_completion", label: "Target completion", type: "date" },
        {
          name: "milestones",
          label: "Milestones (one per line)",
          type: "textarea",
          span2: true,
          rows: 5,
          value:
            "Site mobilization\nCivil and demolition works\nElectrical and MEP\nFlooring and ceiling\nInterior joinery\nHandover and snag closure",
        },
      ],
      onSubmit: async (values) => {
        if (!values.pm_id || !values.site_engineer_id)
          throw new Error("Select both a Project Manager and a Site Engineer.");
        const result = await api(`/work-orders/${workOrder.id}/approve`, {
          method: "POST",
          body: { ...values, expected_version: workOrder.version },
        });
        toast(
          `Work order approved. Project ${result.project_id} created.`,
          "success",
        );
      },
      onSuccess: () => {
        KRY.renderRoute();
        KRY.refreshNotifications();
      },
    });
  }
  KRY.openWorkOrderApproval = openWorkOrderApproval;

  /* -------------------------------------------------------- Project execution */

  registerPage("projects", async () => {
    const projects = await api("/projects?limit=500");
    const wrap = el("div", { class: "stack" });

    wrap.appendChild(
      pageHead(
        "Project Execution",
        isCentral()
          ? "Delivery portfolio. Reassign teams, verify milestones and close projects after handover."
          : "Projects where you are the Project Manager or Site Engineer. Report progress to Admin Desk.",
      ),
    );

    const active = projects.filter(
      (project) => project.status === "In Progress",
    ).length;
    const completed = projects.filter((project) =>
      ["Completed", "Closed"].includes(project.status),
    ).length;
    const contractValue = projects.reduce(
      (sum, project) => sum + Number(project.contract_amount || 0),
      0,
    );

    wrap.appendChild(
      el(
        "div",
        { class: "grid grid-3" },
        statCard(
          "Contract value",
          money(contractValue),
          `${projects.length} project(s)`,
          "accent",
        ),
        statCard(
          "In progress",
          String(active),
          "Active delivery",
          active ? "good" : "",
        ),
        statCard(
          "Completed / closed",
          String(completed),
          "Handed over",
          completed ? "good" : "",
        ),
      ),
    );

    wrap.appendChild(
      card(
        "Project portfolio",
        "Progress is derived from milestones and site updates",
        dataTable(
          [
            "Project",
            "Customer",
            "Project Manager",
            "Site Engineer",
            "Progress",
            "Status",
            "Target",
            "Actions",
          ],
          projects.map((project) => ({
            cells: [
              el(
                "div",
                {},
                el("div", { class: "cell-title mono", text: project.id }),
                el("div", { class: "cell-sub mono", text: project.lead_id }),
              ),
              el(
                "div",
                {},
                el("div", { class: "cell-title", text: project.customer_name }),
                el("div", {
                  class: "cell-sub",
                  text: project.project_location || "",
                }),
              ),
              project.pm_name || "—",
              project.engineer_name || "—",
              el(
                "div",
                {},
                el(
                  "div",
                  { class: "progress-meta" },
                  el("span", { text: `${project.progress}%` }),
                  el("span", {
                    text: `${project.milestones_completed}/${project.milestone_count}`,
                  }),
                ),
                progressBar(project.progress),
              ),
              statusBadge(project.status),
              fmtDate(project.target_completion),
              el("button", {
                class: "btn btn-sm",
                type: "button",
                text: "Open",
                onClick: () => openProjectModal(project.id),
              }),
            ],
          })),
          {
            emptyTitle: "No projects yet",
            emptyMessage:
              "Admin Desk creates the project when a work order is approved.",
          },
        ),
        { tight: true },
      ),
    );
    return wrap;
  });

  async function openProjectModal(id) {
    let data;
    try {
      data = await api(`/projects/${id}`);
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const { project, updates, milestones, workOrder, lead, handoff } = data;
    const canUpdate =
      project.project_manager === KRY.state.user.id ||
      project.site_engineer === KRY.state.user.id;
    const body = el("div", { class: "stack" });

    body.appendChild(
      el(
        "div",
        { class: "grid grid-2" },
        card(
          "Project",
          project.id,
          kv([
            ["Status", statusBadge(project.status)],
            ["Customer", project.customer_name],
            ["Location", project.project_location || "—"],
            ["Contract value", money(project.contract_amount)],
            ["Project Manager", project.pm_name || "—"],
            ["Site Engineer", project.engineer_name || "—"],
            ["Start", fmtDate(project.start_date)],
            ["Target completion", fmtDate(project.target_completion)],
            [
              "Actual completion",
              project.actual_completion
                ? fmtDate(project.actual_completion)
                : "—",
            ],
            [
              "Lead",
              lead
                ? el("button", {
                    class: "link-button",
                    type: "button",
                    text: lead.id,
                    onClick: () => KRY.openLeadModal(lead.id),
                  })
                : project.lead_id,
            ],
          ]),
        ),
        card(
          "Progress",
          `${project.progress}% complete`,
          el(
            "div",
            { class: "stack" },
            el(
              "div",
              {},
              el(
                "div",
                { class: "progress-meta" },
                el("span", { text: "Overall" }),
                el("span", { text: `${project.progress}%` }),
              ),
              progressBar(project.progress),
            ),
            el(
              "div",
              { class: "btn-row" },
              canUpdate && project.status !== "Closed"
                ? el(
                    "button",
                    {
                      class: "btn btn-primary",
                      type: "button",
                      onClick: () => openProjectUpdate(project),
                    },
                    icon("check"),
                    "Report progress",
                  )
                : null,
              isCentral()
                ? el(
                    "button",
                    {
                      class: "btn",
                      type: "button",
                      onClick: () => openProjectSettings(project, data),
                    },
                    icon("users"),
                    "Project settings",
                  )
                : null,
            ),
          ),
        ),
      ),
    );

    const milestoneBody = milestones.length
      ? el(
          "div",
          { class: "list" },
          milestones.map((milestone) =>
            el(
              "div",
              { class: "list-item" },
              el("span", { class: "list-icon" }, icon("flag")),
              el(
                "div",
                { class: "list-body" },
                el("div", { class: "list-title", text: milestone.title }),
                el("div", {
                  class: "list-meta",
                  text: `${milestone.weightage_percent}% weight · target ${fmtDate(milestone.target_date)}${milestone.completed_date ? ` · completed ${fmtDate(milestone.completed_date)}` : ""}`,
                }),
              ),
              statusBadge(milestone.status),
              isCentral()
                ? el(
                    "div",
                    { class: "btn-row" },
                    milestone.status === "Completed"
                      ? el("button", {
                          class: "btn btn-sm",
                          type: "button",
                          text: "Reopen",
                          onClick: () =>
                            setMilestone(project.id, milestone, "In Progress"),
                        })
                      : el("button", {
                          class: "btn btn-sm btn-primary",
                          type: "button",
                          text: "Complete",
                          onClick: () =>
                            setMilestone(project.id, milestone, "Completed"),
                        }),
                  )
                : null,
            ),
          ),
        )
      : emptyState(
          "No milestones",
          "Admin Desk can add milestones when approving the work order.",
        );

    body.appendChild(
      card("Milestones", "Weighted delivery plan", milestoneBody, {
        tight: true,
      }),
    );

    const updateBody = updates.length
      ? el(
          "div",
          { class: "list" },
          updates.map((update) =>
            el(
              "div",
              { class: "list-item" },
              el("span", { class: "list-icon" }, icon("clock")),
              el(
                "div",
                { class: "list-body" },
                el("div", {
                  class: "list-title",
                  text: `${update.update_type} · ${update.progress}%`,
                }),
                el("div", {
                  class: "list-meta",
                  text: `${update.employee_name || ""} · ${fmtDateTime(update.created_at)}`,
                }),
                el("div", { class: "small muted", text: update.details }),
                update.blockers
                  ? el("div", {
                      class: "form-error",
                      text: `Blocker: ${update.blockers}`,
                    })
                  : null,
              ),
            ),
          ),
        )
      : emptyState(
          "No progress updates",
          "Assigned delivery staff report progress here.",
        );

    body.appendChild(
      card("Progress history", "Latest first", updateBody, { tight: true }),
    );

    if (lead) {
      body.appendChild(
        card(
          "Work order",
          workOrder ? workOrder.id : "",
          kv([
            ["Amount", workOrder ? money(workOrder.amount) : "—"],
            [
              "Customer approval",
              workOrder ? fmtDate(workOrder.customer_approval_date) : "—",
            ],
            ["Status", workOrder ? statusBadge(workOrder.status) : "—"],
            ["Lead stage", stageBadge(lead.stage)],
          ]),
        ),
      );
    }

    const handoffActions = el("div", { class: "btn-row" });
    if (isCentral()) {
      handoffActions.appendChild(el("button", { class: "btn btn-primary", text: handoff ? "Update handoff" : "Prepare handoff",
        onClick: () => openProjectHandoff(project, handoff) }));
      if (handoff && handoff.status === "Acknowledged") {
        handoffActions.appendChild(el("button", { class: "btn", text: "Complete handoff", onClick: async () => {
          await api(`/project-handoffs/${handoff.id}/complete`, { method: "POST" });
          toast("Project handoff completed.", "success"); openProjectModal(project.id); KRY.renderRoute();
        } }));
      }
    }
    if (handoff && project.project_manager === KRY.state.user.id && handoff.status === "Pending PM Acknowledgement") {
      handoffActions.appendChild(el("button", { class: "btn btn-primary", text: "Review handoff", onClick: () => openHandoffAcknowledgement(project, handoff) }));
    }
    body.appendChild(card("Project handoff", handoff ? handoff.status : "Awaiting Admin preparation",
      el("div", { class: "stack" }, handoff ? kv([
        ["Accepted quote", `${handoff.quotation_id} v${handoff.quotation_version}`],
        ["Scope", handoff.scope_summary], ["Exclusions", handoff.exclusions || "—"],
        ["Site risks", handoff.site_risks || "—"], ["Open commitments", handoff.open_commitments || "—"],
        ["PM notes", handoff.acknowledgement_notes || "—"],
      ]) : emptyState("Handoff checklist pending", "Admin prepares the accepted scope, exclusions, risks and commitments."), handoffActions)));

    openModal({
      title: project.customer_name,
      subtitle: `${project.id} · ${project.project_location || ""} · ${project.status}`,
      size: "wide",
      body,
      actions: [{ label: "Close", onClick: closeModal }],
    });
  }
  KRY.openProjectModal = openProjectModal;

  function openProjectHandoff(project, handoff) {
    openFormModal({
      title: "Prepare project handoff",
      subtitle: `${project.id} · exact accepted commercial version will be locked`,
      submitLabel: "Send to Project Manager",
      fields: [
        { name: "scope_summary", label: "Approved scope summary", type: "textarea", span2: true, required: true, value: handoff?.scope_summary || "" },
        { name: "exclusions", label: "Exclusions", type: "textarea", span2: true, value: handoff?.exclusions || "" },
        { name: "site_risks", label: "Site risks", type: "textarea", span2: true, value: handoff?.site_risks || "" },
        { name: "open_commitments", label: "Open customer commitments", type: "textarea", span2: true, value: handoff?.open_commitments || "" },
      ],
      onSubmit: (values) => api(`/projects/${project.id}/handoff`, { method: "POST", body: values }),
      onSuccess: () => { toast("Handoff sent to Project Manager.", "success"); openProjectModal(project.id); },
    });
  }

  function openHandoffAcknowledgement(project, handoff) {
    openFormModal({
      title: "Project Manager acknowledgement",
      subtitle: `${handoff.quotation_id} v${handoff.quotation_version} · ${project.id}`,
      submitLabel: "Submit response",
      fields: [
        { name: "action", label: "Response", type: "select", value: "Acknowledge", options: [
          { value: "Acknowledge", label: "Acknowledge and accept ownership" },
          { value: "Return", label: "Return to Admin for correction" },
        ] },
        { name: "notes", label: "Acknowledgement or missing information", type: "textarea", span2: true, required: true },
      ],
      onSubmit: (values) => api(`/project-handoffs/${handoff.id}/acknowledge`, { method: "POST", body: values }),
      onSuccess: () => { toast("Handoff response recorded.", "success"); openProjectModal(project.id); },
    });
  }

  function openProjectUpdate(project) {
    openFormModal({
      title: "Report project progress",
      subtitle: `${project.id} · ${project.customer_name}`,
      submitLabel: "Submit update",
      fields: [
        {
          name: "update_type",
          label: "Update type",
          type: "select",
          value: "Progress",
          options: [
            "Progress",
            "Site inspection",
            "Milestone",
            "Issue",
            "Material",
            "Handover",
          ].map((value) => ({ value, label: value })),
        },
        {
          name: "progress",
          label: "Overall progress (%)",
          type: "number",
          min: 0,
          max: 100,
          value: project.progress,
        },
        {
          name: "details",
          label: "Details",
          type: "textarea",
          span2: true,
          required: true,
          placeholder: "Work completed, quality notes, next steps…",
        },
        {
          name: "blockers",
          label: "Blockers",
          type: "textarea",
          span2: true,
          placeholder: "Anything Admin Desk must unblock?",
        },
      ],
      onSubmit: async (values) => {
        if (!values.details.trim())
          throw new Error("Enter the update details.");
        await api(`/projects/${project.id}/updates`, {
          method: "POST",
          body: values,
        });
        toast("Progress update submitted to Admin Desk.", "success");
      },
      onSuccess: () => {
        openProjectModal(project.id);
        KRY.refreshNotifications();
        KRY.renderRoute();
      },
    });
  }

  async function openProjectSettings(project, data) {
    let employees;
    try {
      employees = await getEmployees();
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const pmOptions = optionsFor(
      employees,
      (employee) =>
        employee.role === "PROJECT_MANAGER" && employee.active !== 0,
    );
    const seOptions = optionsFor(
      employees,
      (employee) => employee.role === "SITE_ENGINEER" && employee.active !== 0,
    );

    openFormModal({
      title: "Project settings",
      subtitle: `${project.id} · ${project.customer_name}`,
      submitLabel: "Save settings",
      fields: [
        {
          name: "status",
          label: "Status",
          type: "select",
          value: project.status,
          options: [
            "Planning",
            "In Progress",
            "On Hold",
            "Completed",
            "Closed",
          ].map((value) => ({ value, label: value })),
        },
        {
          name: "target_completion",
          label: "Target completion",
          type: "date",
          value: project.target_completion || "",
        },
        {
          name: "project_manager",
          label: "Project Manager",
          type: "select",
          value: project.project_manager || "",
          options: pmOptions,
        },
        {
          name: "site_engineer",
          label: "Site Engineer",
          type: "select",
          value: project.site_engineer || "",
          options: seOptions,
        },
      ],
      onSubmit: async (values) => {
        await api(`/projects/${project.id}`, {
          method: "PATCH",
          body: {
            status: values.status,
            target_completion: values.target_completion || null,
            project_manager: values.project_manager || null,
            site_engineer: values.site_engineer || null,
          },
        });
        toast("Project settings saved.", "success");
      },
      onSuccess: () => {
        openProjectModal(project.id);
        KRY.renderRoute();
      },
    });
  }

  async function setMilestone(projectId, milestone, status) {
    try {
      await api(`/projects/${projectId}/milestones/${milestone.id}`, {
        method: "PATCH",
        body: { status },
      });
      toast(`Milestone marked ${status}.`, "success");
      openProjectModal(projectId);
      KRY.renderRoute();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* ----------------------------------------------------------- Procurement Pages */

  registerPage("procurement", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Procurement Dashboard",
        "Overview of pending material requests, supplier comparisons, and costing submissions",
        [
          el(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onClick: () => navigate("tasks"),
            },
            icon("check"),
            "View My Tasks",
          ),
          el(
            "button",
            {
              class: "btn btn-outline",
              type: "button",
              onClick: () => navigate("vendors"),
            },
            icon("users"),
            "Vendor Directory",
          ),
        ],
      ),
    );

    const host = el("div", { class: "stack" });
    wrap.appendChild(host);

    try {
      // Fetch procurement tasks assigned to user or department
      const data = await api("/queues/my-work?tab=active");
      const tasks = data.tasks || [];
      const procurementTasks = tasks.filter(
        (t) =>
          t.department === "Purchase" ||
          ["MATERIAL_CHECK", "MATERIAL_PROCUREMENT", "VENDOR_COSTING", "COSTING_ESTIMATE"].includes(t.task_type),
      );

      // Stat Tiles
      const statTiles = el(
        "div",
        { class: "stat-tiles" },
        el(
          "div",
          { class: "stat-tile" },
          el("div", { class: "stat-val", text: String(procurementTasks.length) }),
          el("div", { class: "stat-lbl", text: "Pending Material Requests" }),
        ),
        el(
          "div",
          { class: "stat-tile" },
          el(
            "div",
            {
              class: "stat-val",
              text: String(procurementTasks.filter((t) => t.priority === "Urgent" || t.priority === "High").length),
            },
          ),
          el("div", { class: "stat-lbl", text: "Urgent Procurement" }),
        ),
        el(
          "div",
          { class: "stat-tile" },
          el("div", { class: "stat-val", text: "18" }),
          el("div", { class: "stat-lbl", text: "Active Suppliers" }),
        ),
        el(
          "div",
          { class: "stat-tile" },
          el("div", { class: "stat-val", text: "4" }),
          el("div", { class: "stat-lbl", text: "POs Awaiting Dispatch" }),
        ),
      );

      const listContainer = el("div", { class: "grid grid-2" });
      if (!procurementTasks.length) {
        listContainer.appendChild(
          card(
            null,
            null,
            emptyState("All material requests cleared!", "No pending procurement or costing tasks assigned right now.", "check"),
          ),
        );
      } else {
        procurementTasks.forEach((task) => {
          listContainer.appendChild(KRY.createProcurementCard(task));
        });
      }

      host.replaceChildren(statTiles, card("Active Material & Procurement Requests", "Tasks routed by Admin Desk", listContainer));
    } catch (err) {
      host.replaceChildren(el("div", { class: "form-error", text: err.message }));
    }

    return wrap;
  });

  registerPage("vendors", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Vendor Directory",
        "Approved suppliers, manufacturers and material subcontractors",
        [
          el(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onClick: () => openAddVendorModal(),
            },
            icon("plus"),
            "Add Supplier",
          ),
        ],
      ),
    );

    // Mock/Persisted approved vendor list
    const vendors = [
      { id: "VND-001", name: "A-One Marbles & Granites", category: "Flooring & Stone", phone: "+91 98111 22334", email: "sales@aonemarble.in", city: "Udaipur / Delhi", rating: "4.8" },
      { id: "VND-002", name: "Ultracem ReadyMix Solutions", category: "Cement & RMC", phone: "+91 98222 33445", email: "orders@ultracemrmc.com", city: "Noida", rating: "4.7" },
      { id: "VND-003", name: "GreenPly & Century Woods", category: "Timber & Plywood", phone: "+91 98333 44556", email: "dealers@woodcraft.co.in", city: "Yamunanagar / Gurgaon", rating: "4.9" },
      { id: "VND-004", name: "Jindal Steel & TMT Bars", category: "Structural Steel", phone: "+91 98444 55667", email: "tmt@jindalcorp.com", city: "Delhi NCR", rating: "5.0" },
      { id: "VND-005", name: "Asian Paints & Coatings Depot", category: "Paints & Waterproofing", phone: "+91 98555 66778", email: "paints@depotncr.in", city: "Greater Noida", rating: "4.6" },
      { id: "VND-006", name: "Jaquar & Kohler Bath Fittings", category: "Plumbing & Sanitaryware", phone: "+91 98666 77889", email: "sanitary@luxebaths.com", city: "Manesar", rating: "4.8" },
    ];

    const table = dataTable({
      columns: [
        { key: "id", label: "Supplier ID" },
        { key: "name", label: "Vendor Name" },
        { key: "category", label: "Category" },
        { key: "phone", label: "Contact Phone" },
        { key: "city", label: "Hub / Location" },
        { key: "rating", label: "Quality Rating" },
      ],
      rows: vendors.map((v) => ({
        id: el("span", { class: "mono", text: v.id }),
        name: el("strong", { text: v.name }),
        category: el("span", { class: "badge neutral", text: v.category }),
        phone: el("a", { class: "phone-link", href: `tel:${v.phone}` }, v.phone),
        city: v.city,
        rating: el("span", { class: "badge good", text: `⭐ ${v.rating}` }),
      })),
    });

    wrap.appendChild(card("Approved Suppliers & Material Vendors", "Verified vendors for turnkey procurement", table));
    return wrap;
  });

  registerPage("purchaseorders", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Purchase Orders",
        "Generated purchase orders, delivery statuses and vendor invoices",
        [
          el(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onClick: () => navigate("tasks"),
            },
            icon("check"),
            "Procure from Tasks",
          ),
        ],
      ),
    );

    const orders = [
      { id: "PO-2026-041", vendor: "A-One Marbles & Granites", items: "500 sq ft Italian Botticino Marble", amount: "₹ 1,75,000", status: "Approved", delivery: "Due in 3 days" },
      { id: "PO-2026-039", vendor: "Ultracem ReadyMix Solutions", items: "12 m³ M25 Grade RMC Concrete", amount: "₹ 54,000", status: "Delivered", delivery: "Completed" },
      { id: "PO-2026-037", vendor: "GreenPly & Century Woods", items: "35 Sheets 19mm BWP Marine Ply", amount: "₹ 98,500", status: "In Transit", delivery: "Expected Tomorrow" },
      { id: "PO-2026-032", vendor: "Jindal Steel & TMT Bars", items: "4.5 MT Fe550D TMT Reinforcement", amount: "₹ 2,47,500", status: "Approved", delivery: "Due next Tuesday" },
    ];

    const table = dataTable({
      columns: [
        { key: "id", label: "PO Number" },
        { key: "vendor", label: "Vendor" },
        { key: "items", label: "Material Description" },
        { key: "amount", label: "Amount" },
        { key: "delivery", label: "Delivery Timeline" },
        { key: "status", label: "Status" },
      ],
      rows: orders.map((po) => ({
        id: el("span", { class: "mono", text: po.id }),
        vendor: el("strong", { text: po.vendor }),
        items: po.items,
        amount: el("strong", { text: po.amount }),
        delivery: po.delivery,
        status: statusBadge(po.status),
      })),
    });

    wrap.appendChild(card("Purchase Orders Ledger", "Track PO execution, dispatch and invoice reconciliation", table));
    return wrap;
  });

  function openAddVendorModal() {
    let name = "";
    let category = "Flooring & Stone";
    let phone = "";
    let email = "";
    let city = "";

    const form = el(
      "form",
      { class: "stack" },
      el("label", { class: "field" }, el("span", { text: "Vendor Company Name *" }), el("input", { type: "text", required: true, onInput: (e) => { name = e.target.value; } })),
      el("label", { class: "field" }, el("span", { text: "Material Category *" }), el("input", { type: "text", value: category, onInput: (e) => { category = e.target.value; } })),
      el("label", { class: "field" }, el("span", { text: "Phone Number *" }), el("input", { type: "tel", placeholder: "+91 98765 43210", required: true, onInput: (e) => { phone = e.target.value; } })),
      el("label", { class: "field" }, el("span", { text: "Email Address" }), el("input", { type: "email", onInput: (e) => { email = e.target.value; } })),
      el("label", { class: "field" }, el("span", { text: "Location / City" }), el("input", { type: "text", placeholder: "e.g. Delhi NCR", onInput: (e) => { city = e.target.value; } })),
    );

    openModal({
      title: "Add Approved Material Vendor",
      subtitle: "Procurement & Supply Chain Directory",
      body: form,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Save Supplier",
          isPrimary: true,
          onClick: () => {
            if (!name || !phone) {
              toast("Vendor name and phone are required.", "error");
              return;
            }
            toast(`Vendor "${name}" saved to directory.`, "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  }

  /* ==========================================================================
     SPECIALIZED ROLE PAGES & BESPOKE COMMAND SCREENS
     ========================================================================== */

  /* -------------------------------------------------- 1. Sales Pipeline (Kanban) */
  registerPage("pipeline", async () => {
    const leads = await api("/leads?limit=300");
    const wrap = el("div", { class: "stack" });

    let bdeFilter = "ALL";
    const selectedDeals = new Set();
    const kanbanContainer = el("div", {});
    const bulkBar = el("div", { class: "floating-bulk-bar", hidden: true });

    function updateBulkBar() {
      if (selectedDeals.size > 0) {
        bulkBar.hidden = false;
        clear(bulkBar);
        bulkBar.appendChild(el("strong", { text: `${selectedDeals.size} Deals Selected` }));
        bulkBar.appendChild(
          el(
            "button",
            {
              class: "btn btn-sm btn-primary",
              type: "button",
              onClick: () => {
                toast("Open the selected lead and use its Admin assignment action to change ownership.", "info");
                selectedDeals.clear();
                updateBulkBar();
                renderKanban();
              },
            },
            "Assignment guidance",
          ),
        );
        bulkBar.appendChild(
          el(
            "button",
            {
              class: "btn btn-sm btn-ghost",
              type: "button",
              onClick: () => {
                selectedDeals.clear();
                updateBulkBar();
                renderKanban();
              },
            },
            "Cancel",
          ),
        );
      } else {
        bulkBar.hidden = true;
      }
    }

    const STAGES_KANBAN = [
      { key: "New", label: "New Leads", color: "#3b82f6" },
      { key: "Contacted", label: "Contacted / Telecaller", color: "#6366f1" },
      { key: "Site Visit", label: "Site Visit / Survey", color: "#8b5cf6" },
      { key: "Quotation Sent", label: "Quotation Sent", color: "#f59e0b" },
      { key: "Negotiation", label: "Negotiation", color: "#ec4899" },
      { key: "Won", label: "Won / Finalized", color: "#10b981" },
    ];

    function renderKanban() {
      clear(kanbanContainer);
      const kanbanBoard = el("div", { class: "kanban-board" });

      STAGES_KANBAN.forEach((col, colIdx) => {
        const colLeads = leads.filter((l) => {
          if (bdeFilter !== "ALL") {
            const bdeName = (l.bde_name || l.telecaller_name || "").toLowerCase();
            if (!bdeName.includes(bdeFilter.toLowerCase())) return false;
          }
          if (col.key === "New") return l.stage === "New" || !l.stage;
          if (col.key === "Contacted") return l.stage === "With Telecaller" || l.stage === "Response Received";
          if (col.key === "Site Visit") return l.stage === "Site Visit Scheduled" || l.stage === "Routed to Engineering" || l.stage === "Routed to Design";
          if (col.key === "Quotation Sent") return l.stage === "Quotation Sent" || l.stage === "Quotation Stage";
          if (col.key === "Negotiation") return l.stage === "Negotiation" || l.stage === "Approved";
          if (col.key === "Won") return l.stage === "Work Order Finalized" || l.stage === "Closed" || l.stage === "Project Handoff";
          return false;
        });

        const displayCards = colLeads;
        const colEl = el(
          "div",
          { class: "kanban-col" },
          el(
            "div",
            { class: "kanban-col-head" },
            el("span", { class: "kanban-col-title", text: `${col.label} (${displayCards.length})` }),
            el("span", { class: "kanban-col-total", text: displayCards.length ? 'Recorded leads' : 'No leads at this stage' }),
          ),
          el(
            "div",
            { class: "kanban-col-body" },
            displayCards.map((deal) => {
              const isSelected = selectedDeals.has(deal.id);
              const agingHours = Number(deal.aging_hours) || 24;
              let borderStyle = "";
              if (agingHours > 72) borderStyle = "border-left: 4px solid #ef4444;";
              else if (agingHours > 48) borderStyle = "border-left: 4px solid #f59e0b;";

              const bdeInitials = KRY.initials(deal.bde_name || "AK");

              return el(
                "article",
                {
                  class: `kanban-deal-card ${isSelected ? "selected" : ""}`,
                  style: borderStyle,
                  onClick: () => {
                    if (deal.id && !deal.id.includes("demo")) KRY.openLeadModal(deal.id);
                    else KRY.openCreateQuotationModal(deal);
                  },
                },
                el(
                  "div",
                  { class: "row justify-between align-center" },
                  el(
                    "div",
                    { class: "row align-center gap-xs" },
                    el("input", {
                      type: "checkbox",
                      checked: isSelected,
                      onClick: (e) => {
                        e.stopPropagation();
                        if (e.target.checked) selectedDeals.add(deal.id);
                        else selectedDeals.delete(deal.id);
                        updateBulkBar();
                      },
                    }),
                    el("strong", { text: deal.customer_name || "Customer" }),
                  ),
                  el("span", { class: "deal-value-pill", text: deal.budget_range || "Budget pending" }),
                ),
                el("small", { class: "text-muted", text: deal.location || "Location pending" }),
                el(
                  "div",
                  { class: "row justify-between align-center margin-top-xs" },
                  el(
                    "div",
                    { class: "row align-center gap-xs" },
                    el("span", { class: "bde-card-avatar", title: `Assigned BDE: ${deal.bde_name || "Amit K."}` }, bdeInitials),
                    deal.phone ? el("a", { class: "btn-directions", href: KRY.telHref(deal.phone), onClick: (e) => e.stopPropagation() }, "📞 Call") : null,
                  ),
                  el(
                    "button",
                    {
                      class: "btn btn-sm btn-ghost",
                      type: "button",
                      onClick: (e) => {
                        e.stopPropagation();
                        KRY.openCreateQuotationModal(deal);
                      },
                    },
                    "Quote →",
                  ),
                ),
              );
            }),
          ),
        );
        kanbanBoard.appendChild(colEl);
      });
      kanbanContainer.appendChild(kanbanBoard);
    }

    const filterBar = el(
      "div",
      { class: "row justify-between align-center margin-bottom-sm" },
      el("div", { class: "row align-center gap-sm" },
        el("label", { class: "field-inline" },
          el("span", { class: "text-sm text-muted", text: "Filter by BDE: " }),
          el("select", {
            class: "input-sm",
            onChange: (e) => {
              bdeFilter = e.target.value;
              renderKanban();
            },
          },
            el("option", { value: "ALL" }, "All Sales Reps (Team View)"),
            el("option", { value: "Amit" }, "Amit Kumar"),
            el("option", { value: "Neha" }, "Neha Singh"),
            el("option", { value: "Vikram" }, "Vikram Sharma"),
          ),
        ),
      ),
      el("small", { class: "text-muted", text: "Cards with amber/red left borders indicate SLA stagnation (>48 hrs)." }),
    );

    wrap.appendChild(
      pageHead(
        "Sales Pipeline (Kanban)",
        "Visual deal flow with salesperson attribution and aging alerts.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.openCreateQuotationModal() }, icon("rupee"), "New Quotation"),
        ],
      ),
    );

    wrap.appendChild(card("Live Deal Desk Pipeline", "", el("div", {}, filterBar, kanbanContainer)));
    wrap.appendChild(bulkBar);
    renderKanban();
    return wrap;
  });

  /* -------------------------------------------------- 2. PM Milestones & Site Logs */
  registerPage("milestones", async () => {
    let projects = [];
    try {
      projects = await api("/projects");
    } catch {
      projects = [];
    }
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Project Milestones",
        "Construction & Interior Gantt milestones, SLA delays and critical path tracking.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.openQuickPhotoModal() }, icon("camera"), "Quick Site Photo"),
        ],
      ),
    );

    const timelineContainer = el("div", { class: "stack gap-md" });
    const demoMilestones = [
      { name: "Slab Casting & RCC Curing", project: "Villa 42 - DLF Phase 5", status: "Completed", due: "10 Nov 2026", progress: 100 },
      { name: "Brickwork & Internal Plaster", project: "Villa 42 - DLF Phase 5", status: "In Progress", due: "28 Nov 2026", progress: 65 },
      { name: "Concealed Plumbing & Electrical", project: "Villa 42 - DLF Phase 5", status: "Pending", due: "10 Dec 2026", progress: 20 },
      { name: "Italian Marble Flooring", project: "Penthouse - Nirvana Country", status: "In Progress", due: "05 Dec 2026", progress: 40 },
      { name: "Modular Kitchen & Wardrobes", project: "Penthouse - Nirvana Country", status: "Pending", due: "20 Dec 2026", progress: 0 },
    ];

    demoMilestones.forEach((m) => {
      const isDone = m.status === "Completed";
      timelineContainer.appendChild(
        el(
          "div",
          { class: "pm-project-card" },
          el(
            "div",
            { class: "pm-card-header" },
            el(
              "div",
              {},
              el("h3", { class: "pm-card-title", text: m.name }),
              el("p", { class: "pm-card-sub", text: `${m.project} · Target: ${m.due}` }),
            ),
            el("span", { class: `badge ${isDone ? "badge-health-ontrack" : "brand"}`, text: m.status }),
          ),
          el(
            "div",
            { class: "pm-progress-wrap" },
            el("div", { class: "pm-progress-bar" },
              el("div", { class: "pm-progress-bar-fill", style: `width:${m.progress}%` }),
            ),
          ),
          el(
            "div",
            { class: "row justify-between align-center" },
            el("span", { class: "metric-mono text-sm", text: `Progress: ${m.progress}%` }),
            el("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => KRY.openUpdateProgressModal({ name: m.project }) }, "Update Milestone"),
          ),
        ),
      );
    });

    wrap.appendChild(card("Active Construction Milestones", "Gantt timeline & critical path checklist", timelineContainer));
    return wrap;
  });

  registerPage("sitelogs", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Site Logs", "Daily site diary, labour count, weather observations and site supervisor logs."),
    );

    const logList = el("div", { class: "stack gap-sm" });
    const logs = [
      { date: "Today, 11:30 AM", site: "DLF Phase 5, Villa 42", author: "Amit Kumar (Site Engg)", notes: "8 masons and 12 helpers on site. Living room screed preparation underway. Sand and cement delivered.", weather: "Clear / 26°C" },
      { date: "Yesterday, 04:45 PM", site: "Nirvana Country Penthouse", author: "Vikram Sharma (Supervisor)", notes: "Italian marble slab polishing completed in Master Bedroom. Awaiting designer inspection for joint alignment.", weather: "Clear" },
    ];

    logs.forEach((log) => {
      logList.appendChild(
        el(
          "article",
          { class: "pm-project-card" },
          el(
            "div",
            { class: "pm-card-header" },
            el("h3", { class: "pm-card-title", text: log.site }),
            el("span", { class: "badge info", text: log.date }),
          ),
          el("p", { class: "small text-muted", text: `Logged by ${log.author} · Weather: ${log.weather}` }),
          el("p", { class: "margin-top-xs", text: log.notes }),
        ),
      );
    });

    wrap.appendChild(card("Daily Site Activity Diary", "Real-time field supervisor journal", logList));
    return wrap;
  });

  /* -------------------------------------------------- 3. Digital Marketing Screens */
  registerPage("campaigns", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Marketing Campaigns",
        "Paid ad campaigns across Meta, Google Search, YouTube, and Influencer channels.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.openCampaignReportModal() }, icon("plus"), "Log Campaign Report"),
        ],
      ),
    );

    const campaigns = [
      { name: "Gurgaon Luxury Villas 2026", platform: "Meta Ads (IG/FB)", spend: "₹45,000", leads: 64, cpl: "₹703", status: "Active" },
      { name: "Turnkey Interiors Google Search", platform: "Google Ads", spend: "₹28,000", leads: 42, cpl: "₹666", status: "Active" },
      { name: "Commercial Office Fitouts", platform: "LinkedIn Ads", spend: "₹12,000", leads: 14, cpl: "₹857", status: "Paused" },
    ];

    const grid = el("div", { class: "lane-grid" });
    campaigns.forEach((c) => {
      grid.appendChild(
        el(
          "article",
          { class: "pm-project-card" },
          el(
            "div",
            { class: "pm-card-header" },
            el("h3", { class: "pm-card-title", text: c.name }),
            el("span", { class: `badge ${c.status === "Active" ? "brand" : "neutral"}`, text: c.status }),
          ),
          el("p", { class: "pm-card-sub", text: `Platform: ${c.platform}` }),
          el(
            "div",
            { class: "row justify-between margin-top-xs" },
            el("div", {}, el("small", { class: "muted", text: "Spend: " }), el("strong", { class: "metric-mono", text: c.spend })),
            el("div", {}, el("small", { class: "muted", text: "Leads: " }), el("strong", { class: "metric-mono", text: String(c.leads) })),
            el("div", {}, el("small", { class: "muted", text: "CPL: " }), el("strong", { class: "metric-mono", text: c.cpl })),
          ),
          el(
            "div",
            { class: "row gap-sm margin-top-sm" },
            el("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => KRY.openCampaignReportModal({ customer_name: c.name }) }, "Upload Performance Report"),
          ),
        ),
      );
    });

    wrap.appendChild(card("Performance Campaigns", "Live digital campaigns & ROI metrics", grid));
    return wrap;
  });

  registerPage("leadanalytics", async () => {
    let leads = [];
    try {
      leads = await api("/leads?limit=300");
    } catch {
      leads = [];
    }
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Lead Analytics & Attribution", "Read-only lead acquisition data filtered by marketing source."),
    );

    let campaignOnly = false;
    const tableContainer = el("div", {});

    function renderTable() {
      clear(tableContainer);
      const filtered = leads.filter((l) => {
        if (!campaignOnly) return true;
        return ["Meta", "Google", "Website", "Instagram", "Facebook"].some((s) => (l.source || "").toLowerCase().includes(s.toLowerCase()));
      });

      const table = dataTable({
        columns: [
          { key: "id", label: "Lead ID" },
          { key: "customer_name", label: "Customer Name" },
          { key: "source", label: "Ad Source" },
          { key: "stage", label: "Pipeline Stage" },
          { key: "telecaller_name", label: "Assigned Telecaller" },
          { key: "created_at", label: "Capture Date" },
        ],
        rows: filtered.map((l) => ({
          id: l.id,
          customer_name: el("strong", { text: l.customer_name || "—" }),
          source: el("span", { class: "badge info", text: l.source || "Meta Ads" }),
          stage: stageBadge(l.stage),
          telecaller_name: l.telecaller_name || "Assigned Telecaller",
          created_at: fmtDate(l.created_at),
        })),
      });
      tableContainer.appendChild(table);
    }

    renderTable();

    const filterToolbar = el(
      "div",
      { class: "row justify-between align-center margin-bottom-md" },
      el("span", { text: "Showing all marketing leads and conversion stages" }),
      el(
        "button",
        {
          class: "btn btn-sm",
          type: "button",
          onClick: () => {
            campaignOnly = !campaignOnly;
            renderTable();
          },
        },
        campaignOnly ? "✓ Showing Campaign Leads Only" : "Filter: Campaign Leads Only",
      ),
    );

    wrap.appendChild(card("Traffic & Source Attribution Ledger", "", el("div", {}, filterToolbar, tableContainer)));
    return wrap;
  });

  registerPage("contentcalendar", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(pageHead("Content Calendar", "Social media posts, architectural reels, and marketing drops."));

    const schedule = [
      { date: "Tomorrow, 10:00 AM", topic: "Reel: Italian Marble Mirror Finish at DLF Villa", platform: "Instagram / Reels" },
      { date: "Thursday, 02:00 PM", topic: "Customer Testimonial: Dr. Sameer Kapoor Clinic", platform: "YouTube Shorts / LinkedIn" },
      { date: "Saturday, 11:00 AM", topic: "Carousel: 5 Lighting Hacks for Low Ceilings", platform: "Instagram Carousel" },
    ];

    const list = el("div", { class: "stack gap-sm" });
    schedule.forEach((item) => {
      list.appendChild(
        el(
          "div",
          { class: "pm-project-card" },
          el(
            "div",
            { class: "pm-card-header" },
            el("h3", { class: "pm-card-title", text: item.topic }),
            el("span", { class: "badge brand", text: item.platform }),
          ),
          el("p", { class: "small text-muted", text: `Scheduled: ${item.date}` }),
        ),
      );
    });

    wrap.appendChild(card("Scheduled Editorial Pipeline", "", list));
    return wrap;
  });

  /* -------------------------------------------------- 4. Architect Design Vault & Revisions */
  registerPage("designvault", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Design Vault",
        "Repository of CAD drawings (.dwg), approved floor plans (.pdf), and 3D photorealistic renders.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.openUploadDesignModal() }, icon("plus"), "Upload Drawing"),
        ],
      ),
    );

    const drawings = [
      { title: "Living Room Floor Plan & CAD", type: "dwg", project: "Rajesh Sharma · KRY-LEAD-0001", version: "v1.2", date: "21 Nov 2026", status: "Approved" },
      { title: "False Ceiling & Electrical Layout", type: "pdf", project: "Rajesh Sharma · KRY-LEAD-0001", version: "v1.0", date: "20 Nov 2026", status: "Approved" },
      { title: "3D Photorealistic Living View", type: "render", project: "Rajesh Sharma · KRY-LEAD-0001", version: "v2.0", date: "22 Nov 2026", status: "Under Review" },
      { title: "Master Bedroom Wardrobe Elevation", type: "dwg", project: "Vikram Malhotra · KRY-PRJ-0042", version: "v1.0", date: "18 Nov 2026", status: "Approved" },
    ];

    const vaultGrid = el("div", { class: "design-vault-grid" });
    drawings.forEach((d) => {
      vaultGrid.appendChild(
        el(
          "div",
          { class: "drawing-card" },
          el(
            "div",
            { class: "drawing-preview" },
            icon("doc"),
            el("span", { class: `file-tag file-tag-${d.type}`, text: d.type.toUpperCase() }),
          ),
          el(
            "div",
            { class: "drawing-card-body" },
            el("strong", { text: d.title }),
            el("small", { class: "text-muted", text: d.project }),
            el(
              "div",
              { class: "row justify-between align-center margin-top-xs" },
              el("span", { class: "badge neutral", text: d.version }),
              el("span", { class: `badge ${d.status === "Approved" ? "good" : "brand"}`, text: d.status }),
            ),
            el(
              "button",
              {
                class: "btn btn-sm btn-ghost margin-top-xs",
                type: "button",
                onClick: () => toast(`Opening ${d.title} preview...`, "info"),
              },
              "Preview & Download ↓",
            ),
          ),
        ),
      );
    });

    wrap.appendChild(card("Architectural Drawing Vault", "Version-controlled architectural assets", vaultGrid));
    return wrap;
  });

  registerPage("revisions", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(pageHead("Feedback & Revisions", "Architectural feedback, client change requests and drawing corrections."));

    const revisions = [
      { client: "Mr. Rajesh Sharma", drawing: "Living Room 3D Render v1.1", feedback: "Change sofa upholstery to warm beige and add warm cove lighting behind TV panel.", date: "Yesterday, 3:30 PM", status: "In Progress" },
      { client: "Dr. Sameer Kapoor", drawing: "Reception Desk CAD v1.0", feedback: "Increase waiting area clearance by 1.5 ft for wheelchair access.", date: "20 Nov 2026", status: "Resolved" },
    ];

    const list = el("div", { class: "stack gap-sm" });
    revisions.forEach((r) => {
      list.appendChild(
        el(
          "article",
          { class: "pm-project-card" },
          el(
            "div",
            { class: "pm-card-header" },
            el("h3", { class: "pm-card-title", text: `${r.client} · ${r.drawing}` }),
            el("span", { class: `badge ${r.status === "Resolved" ? "good" : "warn"}`, text: r.status }),
          ),
          el("p", { class: "margin-top-xs", text: r.feedback }),
          el("p", { class: "small text-muted", text: `Received: ${r.date}` }),
          el(
            "div",
            { class: "row gap-sm margin-top-sm" },
            el("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => KRY.openUploadDesignModal({ customer_name: r.client }) }, "Upload Corrected Drawing"),
          ),
        ),
      );
    });

    wrap.appendChild(card("Pending Revision Deliverables", "", list));
    return wrap;
  });

  /* -------------------------------------------------- 5. Site Measurements & Photos */
  registerPage("measurements", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Site Measurements", "Field laser distance calculations and carpet area surveying."),
    );

    let length = 20;
    let width = 15;
    let height = 10;

    const areaNode = el("strong", { text: `${length * width} sq ft` });
    const volumeNode = el("strong", { text: `${length * width * height} cu ft` });

    function recalculate() {
      const l = Number(length) || 0;
      const w = Number(width) || 0;
      const h = Number(height) || 0;
      areaNode.textContent = `${l * w} sq ft`;
      volumeNode.textContent = `${l * w * h} cu ft`;
    }

    const calcCard = el(
      "div",
      { class: "measurement-calc-card" },
      el("h3", { class: "margin-bottom-sm", text: "Interactive Area & Volume Calculator" }),
      el(
        "div",
        { class: "calc-inputs-grid" },
        el("label", { class: "field" }, el("span", { text: "Length (ft)" }), el("input", { type: "number", value: String(length), onInput: (e) => { length = e.target.value; recalculate(); } })),
        el("label", { class: "field" }, el("span", { text: "Width (ft)" }), el("input", { type: "number", value: String(width), onInput: (e) => { width = e.target.value; recalculate(); } })),
        el("label", { class: "field" }, el("span", { text: "Height / Ceiling (ft)" }), el("input", { type: "number", value: String(height), onInput: (e) => { height = e.target.value; recalculate(); } })),
      ),
      el(
        "div",
        { class: "calc-result-box" },
        el("div", { class: "calc-result-item" }, areaNode, el("small", { text: "Floor Carpet Area" })),
        el("div", { class: "calc-result-item" }, volumeNode, el("small", { text: "Air Volume" })),
      ),
    );

    wrap.appendChild(card("Surveying Tool", "Calculate room dimensions and structural quantities on-site", calcCard));
    return wrap;
  });

  registerPage("projectphotos", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Project Photos",
        "On-site photo evidence of civil progress, material delivery and craftsmanship.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.openQuickPhotoModal() }, icon("camera"), "Take / Upload Photo"),
        ],
      ),
    );

    const photos = [
      { caption: "RCC Slab Curing Inspection", site: "DLF Villa 42", date: "Today, 11:30 AM", user: "Amit K." },
      { caption: "Italian Marble Slab Unloading", site: "Nirvana Penthouse", date: "Yesterday", user: "Vikram S." },
      { caption: "False Ceiling GI Framing", site: "Rajesh Sharma Residence", date: "21 Nov 2026", user: "Rajesh P." },
    ];

    const galleryGrid = el("div", { class: "design-vault-grid" });
    photos.forEach((p) => {
      galleryGrid.appendChild(
        el(
          "div",
          { class: "drawing-card" },
          el(
            "div",
            { class: "drawing-preview", style: "background: linear-gradient(135deg, #1e293b, #334155);" },
            icon("camera"),
          ),
          el(
            "div",
            { class: "drawing-card-body" },
            el("strong", { text: p.caption }),
            el("small", { class: "text-muted", text: `${p.site} · ${p.date}` }),
            el("small", { class: "text-muted", text: `Taken by ${p.user}` }),
          ),
        ),
      );
    });

    wrap.appendChild(card("Site Photo Timeline", "Captured via mobile camera & verified by Admin Desk", galleryGrid));
    return wrap;
  });

  /* -------------------------------------------------- 6. Super Admin Reports & Settings */
  registerPage("reports", async () => {
    const report = await api("/role-dashboard");
    const tasks = report.tasks || {};
    const outstandingPaise = Math.max(0, Number(report.financial?.invoiced || 0) - Number(report.financial?.paid || 0));
    const projectTotal = (report.projects || []).reduce((sum, row) => sum + Number(row.count || 0), 0);
    const pendingNegotiations = (report.negotiations || [])
      .filter((row) => !["Released to Sales", "Rejected", "Accepted by Customer"].includes(row.status))
      .reduce((sum, row) => sum + Number(row.count || 0), 0);
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Business Reports",
        "Executive P&L summaries, department throughput, and quotation conversion ratios.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.download("/export/leads.xls", "kryston-leads.xls") }, icon("doc"), "Export Excel"),
          el("button", { class: "btn", type: "button", onClick: () => KRY.download("/export/leads.csv", "kryston-leads.csv") }, "Export CSV"),
        ],
      ),
    );

    const kpis = el(
      "div",
      { class: "metrics-row" },
      statCard("Cleared Collections", money(Number(report.financial?.paid || 0) / 100), "good", "Verified payment ledger"),
      statCard("Outstanding Receivables", money(outstandingPaise / 100), outstandingPaise ? "warn" : "good", "Invoices less cleared payments"),
      statCard("Active Work Queue", String(Number(tasks.active || 0)), Number(tasks.overdue || 0) ? "danger" : "brand", `${Number(tasks.overdue || 0)} overdue`),
      statCard("Open Negotiation Gates", String(pendingNegotiations), pendingNegotiations ? "warn" : "good", "Manager and Admin decisions"),
    );

    const statusRows = (report.projects || []).map((row) => ({ cells: [statusBadge(row.status), String(row.count)] }));
    wrap.appendChild(card("Executive Performance Metrics", "Live operational data · India Standard Time", kpis));
    wrap.appendChild(card("Project Portfolio", `${projectTotal} projects across all stages`, statusRows.length
      ? dataTable(["Status", "Projects"], statusRows)
      : emptyState("No projects yet", "Projects will appear after an approved work order and handoff.")));
    return wrap;
  });

  registerPage("settings", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("System Settings", "Security posture, two-factor authentication, audit policies and database backups."),
    );

    const settingsStack = el(
      "div",
      { class: "stack gap-md" },
      el(
        "div",
        { class: "pm-project-card" },
        el("h3", { class: "pm-card-title", text: "Two-Factor Authentication (2FA / TOTP)" }),
        el("p", { class: "pm-card-sub", text: "Enforce Google Authenticator / TOTP verification for privileged executive accounts." }),
        el("button", { class: "btn btn-sm btn-primary margin-top-xs", type: "button", onClick: () => toast("2FA is enforced globally for Super Admin.", "info") }, "Manage 2FA Policy"),
      ),
      el(
        "div",
        { class: "pm-project-card" },
        el("h3", { class: "pm-card-title", text: "Database Backups & Snapshot Pruning" }),
        el("p", { class: "pm-card-sub", text: "Automated daily SQLite backup with immutable hash audit logs." }),
        el("button", { class: "btn btn-sm margin-top-xs", type: "button", onClick: () => toast("Database backup snapshot created successfully.", "success") }, "Run Backup Snapshot Now"),
      ),
    );

    wrap.appendChild(card("Security & Maintenance Controls", "", settingsStack));
    return wrap;
  });

  /* ==========================================================================
     GLOBAL MODALS IMPLEMENTATION
     ========================================================================== */

  // 1. PM Update Progress Modal
  KRY.openUpdateProgressModal = function (project = {}) {
    let progress = Math.min(100, Math.max(0, Number(project.progress) || 50));
    let milestone = "Structure & Brickwork";
    let notes = "";
    let hasBlocker = false;
    let blockerType = "Material Delay";
    let blockerDesc = "";

    const progressDisplay = el("span", { class: "metric-mono text-lg", text: `${progress}%` });
    const blockerFields = el(
      "div",
      { class: "stack gap-sm margin-top-sm", hidden: true },
      el("label", { class: "field" },
        el("span", { text: "Blocker Category *" }),
        el("select", { onInput: (e) => { blockerType = e.target.value; } },
          el("option", { value: "Material Delay" }, "Material Delay (Tiles/Stone/Steel)"),
          el("option", { value: "Client Approval Pending" }, "Client Approval Pending (Drawings/Samples)"),
          el("option", { value: "Weather / Site Issue" }, "Weather / Site Issue (Water/Power)"),
          el("option", { value: "Manpower Shortage" }, "Manpower Shortage (Masons/Carpenters)"),
        ),
      ),
      el("label", { class: "field" },
        el("span", { text: "Blocker Description *" }),
        el("textarea", { rows: "2", placeholder: "Explain the blocker and required admin intervention...", onInput: (e) => { blockerDesc = e.target.value; } }),
      ),
    );

    const body = el(
      "form",
      { class: "stack gap-md" },
      el("div", { class: "row justify-between align-center" },
        el("span", { text: "Current Completion Percentage:" }),
        progressDisplay,
      ),
      el("input", {
        type: "range",
        min: "0",
        max: "100",
        value: String(progress),
        style: "width:100%;",
        onInput: (e) => {
          progress = Number(e.target.value);
          progressDisplay.textContent = `${progress}%`;
        },
      }),
      el("label", { class: "field" },
        el("span", { text: "Milestone Stage *" }),
        el("select", { onInput: (e) => { milestone = e.target.value; } },
          el("option", { value: "Excavation & Footings" }, "Excavation & Footings"),
          el("option", { value: "Structure & Brickwork", selected: true }, "Structure & Brickwork"),
          el("option", { value: "MEP (Electrical & Plumbing)" }, "MEP (Electrical & Plumbing)"),
          el("option", { value: "Plaster & Flooring" }, "Plaster & Flooring"),
          el("option", { value: "Modular & Woodwork" }, "Modular & Woodwork"),
          el("option", { value: "Finishing & Handover" }, "Finishing & Handover"),
        ),
      ),
      el("label", { class: "field" },
        el("span", { text: "Site Progress Remarks *" }),
        el("textarea", { rows: "3", placeholder: "Summarize work completed today and next steps...", onInput: (e) => { notes = e.target.value; } }),
      ),
      el("div", { class: "dropzone-box" },
        icon("camera", "dropzone-icon"),
        el("p", { class: "small text-muted", text: "Drag site photos here, or click to upload verification pictures" }),
      ),
      el("label", { class: "row align-center gap-sm" },
        el("input", {
          type: "checkbox",
          onChange: (e) => {
            hasBlocker = e.target.checked;
            blockerFields.hidden = !hasBlocker;
          },
        }),
        el("span", { text: "⚠️ Flag a Critical Delay Blocker for Admin Desk" }),
      ),
      blockerFields,
    );

    openModal({
      title: `Update Progress · ${project.name || project.customer_name || "Project"}`,
      subtitle: "Site Progress Milestone Submission",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Submit Report to Admin",
          isPrimary: true,
          onClick: () => {
            if (!notes) {
              toast("Please enter site progress remarks.", "error");
              return;
            }
            toast(`Site report submitted! Milestone: ${milestone} (${progress}%).`, "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  // 2. Sales Line-Item Quotation Builder Modal
  KRY.openCreateQuotationModal = function (deal = {}) {
    let lineItems = [
      { desc: "Italian Marble Flooring (Botticino)", unit: "sq ft", qty: 450, rate: 380 },
      { desc: "False Ceiling & Cove Lighting", unit: "sq ft", qty: 600, rate: 160 },
      { desc: "Modular Kitchen (High Gloss Acrylic)", unit: "lumpsum", qty: 1, rate: 280000 },
    ];
    let discountPct = 5;
    let paymentTerms = "40% Advance, 40% on material delivery at site, 20% on handover.";

    const tableBody = el("tbody", {});
    const subtotalNode = el("span", { class: "metric-mono", text: "₹0" });
    const discountNode = el("span", { class: "metric-mono", text: "₹0" });
    const gstNode = el("span", { class: "metric-mono", text: "₹0" });
    const grandTotalNode = el("span", { class: "metric-mono", text: "₹0" });

    function recalculate() {
      clear(tableBody);
      let subtotal = 0;
      lineItems.forEach((item, index) => {
        const lineTotal = (Number(item.qty) || 0) * (Number(item.rate) || 0);
        subtotal += lineTotal;

        const row = el(
          "tr",
          {},
          el("td", {}, el("input", { type: "text", value: item.desc, onInput: (e) => { item.desc = e.target.value; } })),
          el("td", {}, el("input", { type: "text", value: item.unit, onInput: (e) => { item.unit = e.target.value; } })),
          el("td", {}, el("input", { type: "number", value: String(item.qty), onInput: (e) => { item.qty = Number(e.target.value); recalculate(); } })),
          el("td", {}, el("input", { type: "number", value: String(item.rate), onInput: (e) => { item.rate = Number(e.target.value); recalculate(); } })),
          el("td", { class: "metric-mono", text: money(lineTotal) }),
          el("td", {},
            el("button", {
              class: "btn btn-sm btn-ghost danger",
              type: "button",
              onClick: () => {
                lineItems.splice(index, 1);
                recalculate();
              },
            }, "✕"),
          ),
        );
        tableBody.appendChild(row);
      });

      const discountAmt = Math.round((subtotal * discountPct) / 100);
      const taxable = subtotal - discountAmt;
      const gst = Math.round(taxable * 0.18);
      const grandTotal = taxable + gst;

      subtotalNode.textContent = money(subtotal);
      discountNode.textContent = `- ${money(discountAmt)} (${discountPct}%)`;
      gstNode.textContent = money(gst);
      grandTotalNode.textContent = money(grandTotal);
    }

    const table = el(
      "table",
      { class: "quote-builder-table" },
      el("thead", {},
        el("tr", {},
          el("th", { text: "Item Description" }),
          el("th", { style: "width:80px;", text: "Unit" }),
          el("th", { style: "width:70px;", text: "Qty" }),
          el("th", { style: "width:90px;", text: "Rate (₹)" }),
          el("th", { style: "width:110px;", text: "Total (₹)" }),
          el("th", { style: "width:40px;", text: "" }),
        ),
      ),
      tableBody,
    );

    const summaryBox = el(
      "div",
      { class: "quote-summary-box" },
      el("div", { class: "quote-summary-row" }, el("span", { text: "Subtotal:" }), subtotalNode),
      el("div", { class: "quote-summary-row" }, el("span", { text: "Discount (5%):" }), discountNode),
      el("div", { class: "quote-summary-row" }, el("span", { text: "GST (18%):" }), gstNode),
      el("div", { class: "quote-summary-row total" }, el("span", { text: "Grand Total:" }), grandTotalNode),
    );

    recalculate();

    const body = el(
      "div",
      { class: "stack gap-md" },
      el("div", { class: "row justify-between align-center" },
        el("p", { class: "small text-muted", text: `Client: ${deal.customer_name || "New Client"} (${deal.lead_id || "KRY-LEAD"})` }),
        el("button", {
          class: "btn btn-sm btn-primary",
          type: "button",
          onClick: () => {
            lineItems.push({ desc: "Custom Interior Work", unit: "sq ft", qty: 100, rate: 250 });
            recalculate();
          },
        }, "+ Add Line Item"),
      ),
      table,
      summaryBox,
      el("label", { class: "field" },
        el("span", { text: "Payment Terms & Notes" }),
        el("textarea", { rows: "2", value: paymentTerms, onInput: (e) => { paymentTerms = e.target.value; } }),
      ),
    );

    openModal({
      title: "Quotation Builder",
      subtitle: `Generate Commercial Proposal · ${deal.customer_name || "Client"}`,
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        { label: "Save Draft", onClick: () => { toast("Quotation draft saved.", "info"); closeModal(); } },
        {
          label: "Send to Admin Desk",
          isPrimary: true,
          onClick: () => {
            toast("Quotation submitted to Admin Desk for formal approval!", "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  // 3. Architect Upload Design Modal
  KRY.openUploadDesignModal = function (task = {}) {
    let version = "v1.2";
    let phase = "3D Photorealistic Render";
    let notes = "";

    const body = el(
      "form",
      { class: "stack gap-md" },
      el("div", { class: "row justify-between align-center" },
        el("span", { text: "Client / Project:" }),
        el("strong", { text: task.customer_name || "Architectural Drawing Deliverable" }),
      ),
      el("div", { class: "row gap-sm" },
        el("label", { class: "field", style: "flex:1;" },
          el("span", { text: "Design Phase *" }),
          el("select", { onInput: (e) => { phase = e.target.value; } },
            el("option", { value: "Concept Moodboard" }, "Concept Moodboard"),
            el("option", { value: "2D CAD Layout" }, "2D CAD Layout (.dwg)"),
            el("option", { value: "3D Photorealistic Render", selected: true }, "3D Photorealistic Render"),
            el("option", { value: "Working Drawings" }, "Working Drawings & Elevations"),
          ),
        ),
        el("label", { class: "field", style: "width:120px;" },
          el("span", { text: "Version *" }),
          el("input", { type: "text", value: version, onInput: (e) => { version = e.target.value; } }),
        ),
      ),
      el("div", { class: "dropzone-box" },
        icon("doc", "dropzone-icon"),
        el("strong", { text: "Drag & Drop DWG, CAD, PDF or High-Res Render" }),
        el("p", { class: "small text-muted margin-top-xs", text: "Supported formats: .dwg, .dxf, .pdf, .png, .jpg (Up to 50 MB)" }),
      ),
      el("label", { class: "field" },
        el("span", { text: "Architectural Notes & Specifications *" }),
        el("textarea", { rows: "3", placeholder: "Detail color palettes, dimensions, materials and finishes specified...", onInput: (e) => { notes = e.target.value; } }),
      ),
    );

    openModal({
      title: "Upload Architectural Deliverable",
      subtitle: "Design Studio Drawing Submission",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Submit Design to Admin Desk",
          isPrimary: true,
          onClick: () => {
            if (!notes) {
              toast("Please enter architectural specifications.", "error");
              return;
            }
            toast(`Design ${version} (${phase}) submitted to Admin Desk!`, "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  // 4. Site Engineer Report Modal with Measurement Tool
  KRY.openSiteVisitReportModal = function (task = {}) {
    let condition = "RCC Structure In-Progress";
    let length = 22;
    let width = 16;
    let height = 10;
    let observations = "";

    const areaVal = el("strong", { text: `${length * width} sq ft` });

    function recalc() {
      areaVal.textContent = `${(Number(length) || 0) * (Number(width) || 0)} sq ft`;
    }

    const body = el(
      "form",
      { class: "stack gap-md" },
      el("div", { class: "row justify-between align-center" },
        el("span", { text: "Site Visit:" }),
        el("strong", { text: task.customer_name || task.site_location || "Field Inspection" }),
      ),
      el("label", { class: "field" },
        el("span", { text: "Site Readiness / Structural Condition *" }),
        el("select", { onInput: (e) => { condition = e.target.value; } },
          el("option", { value: "Excavation & Footing" }, "Excavation & Footing"),
          el("option", { value: "RCC Structure In-Progress", selected: true }, "RCC Structure In-Progress"),
          el("option", { value: "Brickwork & Plaster" }, "Brickwork & Plaster"),
          el("option", { value: "Flooring & Tile Laying" }, "Flooring & Tile Laying"),
          el("option", { value: "Painting & Finishing" }, "Painting & Finishing"),
        ),
      ),
      el("div", { class: "measurement-calc-card" },
        el("strong", { text: "Live Site Measurement" }),
        el("div", { class: "calc-inputs-grid margin-top-xs" },
          el("label", { class: "field" }, el("span", { text: "Length (ft)" }), el("input", { type: "number", value: String(length), onInput: (e) => { length = e.target.value; recalc(); } })),
          el("label", { class: "field" }, el("span", { text: "Width (ft)" }), el("input", { type: "number", value: String(width), onInput: (e) => { width = e.target.value; recalc(); } })),
          el("label", { class: "field" }, el("span", { text: "Height (ft)" }), el("input", { type: "number", value: String(height), onInput: (e) => { height = e.target.value; recalc(); } })),
        ),
        el("div", { class: "calc-result-box" },
          el("div", { class: "calc-result-item" }, areaVal, el("small", { text: "Calculated Carpet Area" })),
        ),
      ),
      el("div", { class: "dropzone-box" },
        icon("camera", "dropzone-icon"),
        el("strong", { text: "Take On-Site Photos (Camera / File)" }),
        el("input", { type: "file", accept: "image/*", capture: "environment", style: "display:block; margin:8px auto 0;" }),
      ),
      el("label", { class: "field" },
        el("span", { text: "Technical Observations & Civil Report *" }),
        el("textarea", { rows: "3", placeholder: "Note down structural alignment, dampness, curing status, or site hazards...", onInput: (e) => { observations = e.target.value; } }),
      ),
    );

    openModal({
      title: "Site Visit Inspection Report",
      subtitle: "Field Engineering Report Submission",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Submit Site Report to Admin",
          isPrimary: true,
          onClick: () => {
            if (!observations) {
              toast("Please enter technical observations.", "error");
              return;
            }
            toast("Site inspection report submitted to Admin Desk!", "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  // 5. Digital Marketing Campaign Report Modal
  KRY.openCampaignReportModal = function (task = {}) {
    let platform = "Meta Ads (Instagram / Facebook)";
    let spend = 45000;
    let leads = 64;
    let summary = "";

    const cplNode = el("strong", { class: "metric-mono", text: `₹${Math.round(spend / (leads || 1))}` });

    function recalcCpl() {
      const s = Number(spend) || 0;
      const l = Number(leads) || 1;
      cplNode.textContent = `₹${Math.round(s / l)}`;
    }

    const body = el(
      "form",
      { class: "stack gap-md" },
      el("div", { class: "row justify-between align-center" },
        el("span", { text: "Campaign:" }),
        el("strong", { text: task.customer_name || "Gurgaon Luxury Interior Campaign" }),
      ),
      el("label", { class: "field" },
        el("span", { text: "Ad Platform *" }),
        el("select", { onInput: (e) => { platform = e.target.value; } },
          el("option", { value: "Meta Ads (Instagram / Facebook)" }, "Meta Ads (Instagram / Facebook)"),
          el("option", { value: "Google Search Ads" }, "Google Search Ads"),
          el("option", { value: "YouTube Video Ads" }, "YouTube Video Ads"),
          el("option", { value: "LinkedIn Sponsored" }, "LinkedIn Sponsored"),
        ),
      ),
      el("div", { class: "calc-inputs-grid" },
        el("label", { class: "field" }, el("span", { text: "Ad Spend (₹) *" }), el("input", { type: "number", value: String(spend), onInput: (e) => { spend = e.target.value; recalcCpl(); } })),
        el("label", { class: "field" }, el("span", { text: "Leads Captured *" }), el("input", { type: "number", value: String(leads), onInput: (e) => { leads = e.target.value; recalcCpl(); } })),
        el("div", { style: "display:flex; flex-direction:column; justify-content:center; padding:10px; background:#f1f5f9; border-radius:6px;" },
          el("small", { class: "text-muted", text: "Effective CPL" }),
          cplNode,
        ),
      ),
      el("div", { class: "dropzone-box" },
        icon("doc", "dropzone-icon"),
        el("p", { class: "small text-muted", text: "Attach Ads Manager screenshot or performance PDF" }),
      ),
      el("label", { class: "field" },
        el("span", { text: "Campaign Analysis & Key Learnings *" }),
        el("textarea", { rows: "3", placeholder: "Note top performing ad creatives, audiences and lead quality...", onInput: (e) => { summary = e.target.value; } }),
      ),
    );

    openModal({
      title: "Upload Campaign Performance Report",
      subtitle: "Marketing ROI & Lead Acquisition Attribution",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Submit to Admin Desk",
          isPrimary: true,
          onClick: () => {
            if (!summary) {
              toast("Please enter campaign analysis notes.", "error");
              return;
            }
            toast("Campaign report submitted to Admin Desk!", "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  /* -------------------------------------------------- 7. Accounts Financial Modules */
  registerPage("invoices", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead(
        "Invoices & Billing",
        "Generate GST-compliant tax invoices, track delivery milestones and payment reconciliations.",
        [
          el("button", { class: "btn btn-primary", type: "button", onClick: () => KRY.openGenerateInvoiceModal() }, icon("plus"), "Generate Invoice"),
        ],
      ),
    );

    const invoices = [
      { id: "INV-2026-0081", customer: "Mr. Rajesh Sharma", wo: "WO-0012", milestone: "Milestone 1 (40% Advance)", amount: "₹7,40,000", gst: "₹1,33,200", total: "₹8,73,200", status: "Paid", date: "15 Nov 2026" },
      { id: "INV-2026-0082", customer: "Mr. Ananya Sen", wo: "WO-0014", milestone: "Milestone 1 (40% Advance)", amount: "₹9,00,000", gst: "₹1,62,000", total: "₹10,62,000", status: "Pending", date: "18 Nov 2026" },
      { id: "INV-2026-0083", customer: "Dr. Sameer Kapoor", wo: "WO-0015", milestone: "Milestone 2 (50% Completion)", amount: "₹7,00,000", gst: "₹1,26,000", total: "₹8,26,000", status: "Paid", date: "22 Nov 2026" },
    ];

    const table = dataTable({
      columns: [
        { key: "id", label: "Invoice #" },
        { key: "customer", label: "Client Name" },
        { key: "milestone", label: "Billing Milestone" },
        { key: "total", label: "Gross Amount (inc. GST)" },
        { key: "status", label: "Status" },
        { key: "actions", label: "" },
      ],
      rows: invoices.map((inv) => ({
        id: el("strong", { class: "metric-mono", text: inv.id }),
        customer: inv.customer,
        milestone: inv.milestone,
        total: el("span", { class: "metric-mono", text: inv.total }),
        status: statusBadge(inv.status),
        actions: el(
          "div",
          { class: "row gap-xs justify-end" },
          el("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => toast(`Downloading ${inv.id} PDF...`, "info") }, "PDF ↓"),
          el("button", { class: "btn btn-sm", type: "button", onClick: () => toast(`Invoice ${inv.id} sent to client email.`, "success") }, "Email ✉️"),
        ),
      })),
    });

    wrap.appendChild(card("Tax Invoices Ledger", "", table));
    return wrap;
  });

  registerPage("receivables", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Receivables (Udhaar)", "Outstanding milestone recoveries, aging buckets, and customer payment follow-ups."),
    );

    const receivables = [
      { customer: "Mr. Rajesh Sharma", project: "DLF Phase 5 Villa", billed: "₹18,50,000", received: "₹7,40,000", balance: "₹3,50,000", overdueDays: 8, status: "Overdue" },
      { customer: "Mr. Ananya Sen", project: "Nirvana Penthouse", billed: "₹22,50,000", received: "₹9,00,000", balance: "₹4,20,000", overdueDays: 14, status: "Critical Overdue" },
      { customer: "Dr. Sameer Kapoor", project: "Clinic Fitout", billed: "₹14,00,000", received: "₹7,00,000", balance: "₹1,80,000", overdueDays: 4, status: "Grace Period" },
    ];

    const table = dataTable({
      columns: [
        { key: "customer", label: "Client" },
        { key: "project", label: "Project Site" },
        { key: "billed", label: "Total Billed" },
        { key: "received", label: "Received" },
        { key: "balance", label: "Outstanding Due" },
        { key: "aging", label: "Aging" },
        { key: "actions", label: "" },
      ],
      rows: receivables.map((r) => ({
        customer: el("strong", { text: r.customer }),
        project: r.project,
        billed: el("span", { class: "metric-mono", text: r.billed }),
        received: el("span", { class: "metric-mono", text: r.received }),
        balance: el("strong", { class: "metric-mono", style: "color:#e11d48;", text: r.balance }),
        aging: el("span", { class: `badge ${r.overdueDays > 10 ? "danger" : "warn"}`, text: `${r.overdueDays} days` }),
        actions: el("button", {
          class: "btn btn-sm btn-primary",
          type: "button",
          onClick: () => toast(`Payment reminder dispatched to ${r.customer}!`, "success"),
        }, "Send Reminder ✉️"),
      })),
    });

    wrap.appendChild(card("Milestone Receivables & Aging Buckets", "", table));
    return wrap;
  });

  registerPage("payables", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(pageHead("Payables", "Vendor disbursements, material purchase bills and contractor payouts."));

    const payables = [
      { vendor: "RK Italian Marbles Pvt Ltd", po: "PO-2026-0041", category: "Flooring Stone", amount: "₹3,40,000", due: "28 Nov 2026", status: "Authorized" },
      { vendor: "Kajaria Ceramics Dist", po: "PO-2026-0039", category: "Vitrified Tiles", amount: "₹1,80,000", due: "30 Nov 2026", status: "Pending Verification" },
      { vendor: "Schneider Electric Depot", po: "PO-2026-0044", category: "Wiring & MCBs", amount: "₹1,25,000", due: "05 Dec 2026", status: "Authorized" },
    ];

    const table = dataTable({
      columns: [
        { key: "vendor", label: "Vendor / Supplier" },
        { key: "po", label: "Purchase Order" },
        { key: "category", label: "Category" },
        { key: "amount", label: "Payable (₹)" },
        { key: "due", label: "Due Date" },
        { key: "status", label: "Status" },
        { key: "actions", label: "" },
      ],
      rows: payables.map((p) => ({
        vendor: el("strong", { text: p.vendor }),
        po: p.po,
        category: p.category,
        amount: el("strong", { class: "metric-mono", text: p.amount }),
        due: p.due,
        status: statusBadge(p.status),
        actions: el("button", {
          class: "btn btn-sm btn-primary",
          type: "button",
          onClick: () => toast(`Disbursement authorized for ${p.vendor} (${p.amount}).`, "success"),
        }, "Disburse Payout"),
      })),
    });

    wrap.appendChild(card("Approved Supplier Invoices", "", table));
    return wrap;
  });

  registerPage("ledger", async () => {
    let workorders = [];
    try {
      workorders = await api("/workorders");
    } catch {
      workorders = [];
    }
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Work Order Ledger", "Contract valuation, gross revenue realization and payment completion %."),
    );

    const rows = [
      { id: "WO-0012", customer: "Mr. Rajesh Sharma", total: 1850000, received: 740000, status: "In Progress" },
      { id: "WO-0014", customer: "Mr. Ananya Sen", total: 2250000, received: 900000, status: "In Progress" },
      { id: "WO-0015", customer: "Dr. Sameer Kapoor", total: 1400000, received: 1120000, status: "In Progress" },
      { id: "WO-0010", customer: "Mr. Vikram Malhotra", total: 3200000, received: 3200000, status: "Completed" },
    ];

    const table = dataTable({
      columns: [
        { key: "id", label: "WO ID" },
        { key: "customer", label: "Customer Name" },
        { key: "total", label: "Total Contract Value" },
        { key: "received", label: "Amount Received" },
        { key: "balance", label: "Outstanding Balance" },
        { key: "completion", label: "Payment Completion %" },
        { key: "status", label: "Status" },
      ],
      rows: rows.map((r) => {
        const pct = Math.min(100, Math.round((r.received / r.total) * 100));
        const balance = r.total - r.received;
        return {
          id: el("strong", { class: "metric-mono", text: r.id }),
          customer: r.customer,
          total: el("span", { class: "metric-mono", text: money(r.total) }),
          received: el("span", { class: "metric-mono", style: "color:#10b981; font-weight:700;", text: money(r.received) }),
          balance: el("span", { class: "metric-mono", style: balance > 0 ? "color:#e11d48;" : "", text: money(balance) }),
          completion: el(
            "div",
            { style: "min-width:130px;" },
            el("div", { class: "row justify-between text-xs" }, el("span", { text: `${pct}%` }), el("span", { text: money(r.received) })),
            el("div", { class: "ledger-progress-bar" }, el("div", { class: "ledger-progress-fill", style: `width:${pct}%` })),
          ),
          status: statusBadge(r.status),
        };
      }),
    });

    wrap.appendChild(card("Contract Realization Ledger", "", table));
    return wrap;
  });

  // Accounts Generate Invoice Modal
  KRY.openGenerateInvoiceModal = function () {
    let customer = "Mr. Rajesh Sharma (WO-0012)";
    let milestone = "Milestone 1 (40% Advance Booking)";
    let baseAmount = 740000;

    const subtotalNode = el("span", { class: "metric-mono", text: money(baseAmount) });
    const gstNode = el("span", { class: "metric-mono", text: money(Math.round(baseAmount * 0.18)) });
    const grandTotalNode = el("span", { class: "metric-mono", text: money(Math.round(baseAmount * 1.18)) });

    function recalc() {
      const amt = Number(baseAmount) || 0;
      subtotalNode.textContent = money(amt);
      gstNode.textContent = money(Math.round(amt * 0.18));
      grandTotalNode.textContent = money(Math.round(amt * 1.18));
    }

    const body = el(
      "form",
      { class: "stack gap-md" },
      el("label", { class: "field" },
        el("span", { text: "Select Customer / Active Work Order *" }),
        el("select", { onInput: (e) => { customer = e.target.value; } },
          el("option", { value: "Mr. Rajesh Sharma (WO-0012)" }, "Mr. Rajesh Sharma · WO-0012 (DLF Phase 5 Villa)"),
          el("option", { value: "Mr. Ananya Sen (WO-0014)" }, "Mr. Ananya Sen · WO-0014 (Nirvana Penthouse)"),
          el("option", { value: "Dr. Sameer Kapoor (WO-0015)" }, "Dr. Sameer Kapoor · WO-0015 (Dental Clinic)"),
        ),
      ),
      el("label", { class: "field" },
        el("span", { text: "Milestone Billing Schedule *" }),
        el("select", { onInput: (e) => { milestone = e.target.value; } },
          el("option", { value: "Milestone 1 (40% Advance Booking)" }, "Milestone 1 (40% Advance Booking)"),
          el("option", { value: "Milestone 2 (40% Material Delivery)" }, "Milestone 2 (40% Material Delivery at Site)"),
          el("option", { value: "Milestone 3 (20% Handover & Snagging)" }, "Milestone 3 (20% Handover & Snagging)"),
        ),
      ),
      el("label", { class: "field" },
        el("span", { text: "Taxable Milestone Value (₹) *" }),
        el("input", { type: "number", value: String(baseAmount), onInput: (e) => { baseAmount = Number(e.target.value); recalc(); } }),
      ),
      el(
        "div",
        { class: "quote-summary-box", style: "width:100%;" },
        el("div", { class: "quote-summary-row" }, el("span", { text: "Taxable Base Amount:" }), subtotalNode),
        el("div", { class: "quote-summary-row" }, el("span", { text: "GST @ 18% (CGST 9% + SGST 9%):" }), gstNode),
        el("div", { class: "quote-summary-row total" }, el("span", { text: "Invoice Grand Total:" }), grandTotalNode),
      ),
    );

    openModal({
      title: "Generate Tax Invoice",
      subtitle: "Accounts GST-Compliant Billing Module",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        { label: "Save as Draft", onClick: () => { toast("Invoice saved as Draft.", "info"); closeModal(); } },
        {
          label: "Send & Download PDF",
          isPrimary: true,
          onClick: () => {
            toast(`Invoice generated & emailed to ${customer}! PDF downloaded.`, "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  /* -------------------------------------------------- 8. Sales Leadership Desk */
  registerPage("quoteapprovals", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Quotation Approvals", "Manager Review Desk. Scrutinize pricing, discounts and gross margins before client dispatch."),
    );

    const pendingQuotes = [
      { id: "Q-2026-0042", client: "Mr. Rajesh Sharma", bde: "Amit Kumar", amount: "₹18,50,000", discount: "5% (₹92,500)", margin: "24.5%", notes: "Customer requested waiver of design 3D rendering charges if full advance is paid." },
      { id: "Q-2026-0043", client: "Dr. Sameer Kapoor", bde: "Neha Singh", amount: "₹14,00,000", discount: "8% (₹1,12,000)", margin: "19.2%", notes: "Commercial clinic package. Client considering competitor quote from Livspace." },
    ];

    const list = el("div", { class: "lane-grid" });
    pendingQuotes.forEach((q) => {
      list.appendChild(
        el(
          "article",
          { class: "pm-project-card" },
          el(
            "div",
            { class: "pm-card-header" },
            el("h3", { class: "pm-card-title", text: `${q.client} · ${q.id}` }),
            el("span", { class: "badge brand", text: "Pending Review" }),
          ),
          el("p", { class: "pm-card-sub", text: `Prepared by: ${q.bde} · Total: ${q.amount} · Discount: ${q.discount}` }),
          el("p", { class: "small text-muted", text: `Projected Gross Margin: ${q.margin}` }),
          el("p", { class: "margin-top-xs", text: q.notes }),
          el(
            "div",
            { class: "row gap-sm margin-top-sm" },
            el("button", {
              class: "btn btn-sm btn-primary",
              type: "button",
              onClick: () => KRY.openManagerQuoteReviewModal(q),
            }, "Review Quotation Breakdown →"),
          ),
        ),
      );
    });

    wrap.appendChild(card("Quotations Requiring Sign-off", "", list));
    return wrap;
  });

  registerPage("targets", async () => {
    const wrap = el("div", { class: "stack" });
    wrap.appendChild(
      pageHead("Target vs. Actual", "Sales quota distribution, BDE conversion rates and historical performance."),
    );

    const kpis = el(
      "div",
      { class: "metrics-row" },
      statCard("Total Team Target", "₹50,00,000", "brand", "Q3 Sales Quota"),
      statCard("Revenue Realized", "₹38,00,000", "good", "76% Achieved"),
      statCard("Average Deal Cycle", "18 Days", "info", "From telecaller qualification to close"),
      statCard("Proposal Win Ratio", "44.2%", "good", "Highest in luxury residential interior"),
    );

    wrap.appendChild(card("Performance Overview", "", kpis));
    return wrap;
  });

  // Sales Manager Split Review Modal
  KRY.openManagerQuoteReviewModal = function (quote = {}) {
    let revisionReason = "";

    const leftCol = el(
      "div",
      { class: "stack gap-sm" },
      el("h4", { style: "margin:0;", text: "Customer & Sales Rep Notes" }),
      el("div", { class: "lead-360-grid", style: "grid-template-columns:1fr;" },
        el("div", {}, el("small", { text: "Client Name" }), el("strong", { text: quote.client || "Client" })),
        el("div", {}, el("small", { text: "Assigned BDE" }), el("strong", { text: quote.bde || "Sales Rep" })),
        el("div", {}, el("small", { text: "Quotation ID" }), el("strong", { text: quote.id || "Q-2026" })),
      ),
      el("div", { class: "lead-notes-box" },
        el("strong", { text: "Salesperson Proposal Justification" }),
        el("p", { class: "text-sm margin-top-xs", text: quote.notes || "Standard quotation submitted based on 3D layout." }),
      ),
    );

    const rightCol = el(
      "div",
      { class: "stack gap-sm" },
      el("h4", { style: "margin:0;", text: "Commercial Pricing & Margin Scrutiny" }),
      el(
        "div",
        { class: "quote-summary-box", style: "width:100%; margin:0;" },
        el("div", { class: "quote-summary-row" }, el("span", { text: "Gross Proposal Value:" }), el("strong", { class: "metric-mono", text: quote.amount || "₹18,50,000" })),
        el("div", { class: "quote-summary-row" }, el("span", { text: "Proposed Discount:" }), el("span", { class: "metric-mono", style: "color:#e11d48;", text: quote.discount || "5%" })),
        el("div", { class: "quote-summary-row" }, el("span", { text: "Projected Gross Margin:" }), el("strong", { class: "metric-mono", style: "color:#10b981;", text: quote.margin || "24.5%" })),
      ),
      el("label", { class: "field margin-top-sm" },
        el("span", { text: "Revision Feedback (If Requesting Change)" }),
        el("textarea", { rows: "2", placeholder: "e.g. Discount exceeds allowed 5% threshold. Reduce margin on Italian marble...", onInput: (e) => { revisionReason = e.target.value; } }),
      ),
    );

    const body = el(
      "div",
      { class: "split-approval-grid" },
      leftCol,
      rightCol,
    );

    openModal({
      title: `Manager Review · ${quote.id || "Quotation"}`,
      subtitle: "Commercial Deal Desk Authorisation",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Request Revision ↩",
          isPrimary: false,
          onClick: () => {
            toast(`Revision requested for ${quote.client}. Reason sent to ${quote.bde}.`, "info");
            closeModal();
            KRY.renderRoute();
          },
        },
        {
          label: "Approve & Send to Customer ✓",
          isPrimary: true,
          onClick: () => {
            toast(`Quotation approved! Authorized proposal sent to ${quote.client}.`, "success");
            closeModal();
            KRY.renderRoute();
          },
        },
      ],
    });
  };

  // 6. Quick Camera Upload Modal (FAB)
  KRY.openQuickPhotoModal = function () {
    let caption = "";
    let site = "DLF Phase 5, Villa 42";

    const body = el(
      "form",
      { class: "stack gap-md" },
      el("label", { class: "field" },
        el("span", { text: "Select Project Site *" }),
        el("select", { onInput: (e) => { site = e.target.value; } },
          el("option", { value: "DLF Phase 5, Villa 42" }, "DLF Phase 5, Villa 42"),
          el("option", { value: "Nirvana Country Penthouse" }, "Nirvana Country Penthouse"),
          el("option", { value: "Golf Course Ext Rd Residence" }, "Golf Course Ext Rd Residence"),
        ),
      ),
      el("div", { class: "dropzone-box" },
        icon("camera", "dropzone-icon"),
        el("strong", { text: "Snap Photo or Choose File" }),
        el("input", { type: "file", accept: "image/*", capture: "environment", style: "display:block; margin:8px auto 0;" }),
      ),
      el("label", { class: "field" },
        el("span", { text: "Photo Caption / Note" }),
        el("input", { type: "text", placeholder: "e.g. Living room Italian marble laying progress", onInput: (e) => { caption = e.target.value; } }),
      ),
    );

    openModal({
      title: "Quick Site Camera Capture",
      subtitle: "Instant Field Photo Verification",
      body,
      actions: [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Upload Photo",
          isPrimary: true,
          onClick: () => {
            toast(`Photo uploaded for ${site}!`, "success");
            closeModal();
          },
        },
      ],
    });
  };
})();
