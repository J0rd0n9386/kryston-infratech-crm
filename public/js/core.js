/**
 * Kryston Infratech CRM - client core.
 *
 * Shared state, DOM helpers, API client, plain-language formatting, modal and
 * wizard builders, navigation, media attachments and the activity feed.
 *
 * Every view is built with createElement/textContent, so the strict CSP never
 * needs 'unsafe-inline'. All visible copy comes from `KRY.t()` (i18n.js), which
 * supports English, Hindi and Hinglish without a reload.
 */
'use strict';

(function () {
  const KRY = (window.KRY = window.KRY || {});
  const t = (key, vars) => KRY.t(key, vars);

  const STAGES = [
    'New',
    'With Telecaller',
    'Response Received',
    'Routed to Sales',
    'Routed to Engineering',
    'Routed to Design',
    'Routed to Purchase',
    'Routed to Accounts',
    'Update Received',
    'Follow-up Required',
    'Site Visit Scheduled',
    'Design In Progress',
    'Quotation Stage',
    'Quotation Sent',
    'Negotiation',
    'Approved',
    'Work Order Pending Admin Approval',
    'Work Order Finalized',
    'Project Handoff',
    'In Progress',
    'Completed',
    'Closed',
    'Lost',
    'Nurture',
  ];

  const CENTRAL_ROLES = ['SUPER_ADMIN', 'ADMIN_DESK'];
  const SALES_ROLES = ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'];
  const ROLE_LABELS = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN_DESK: 'Admin Desk',
    SALES_MANAGER: 'Sales Manager',
    SENIOR_BDM: 'Senior BDM',
    BDM: 'BDM',
    BDE: 'BDE',
    TELECALLER: 'Telecaller',
    SITE_ENGINEER: 'Site Engineer',
    ARCHITECT: 'Architect',
    DIGITAL_MARKETING: 'Digital Marketing',
    PROJECT_MANAGER: 'Project Manager',
    PURCHASE: 'Purchase',
    ACCOUNTS: 'Accounts',
  };

  const PAGE_META = {
    overview: { titleKey: 'page.myday.title', eyebrowKey: 'page.myday.eyebrow' },
    actionqueue: { titleKey: 'page.actionqueue.title', eyebrowKey: 'page.actionqueue.eyebrow' },
    reports: { titleKey: 'page.reports.title', eyebrowKey: 'page.reports.eyebrow' },
    taskboard: { titleKey: 'page.taskboard.title', eyebrowKey: 'page.taskboard.eyebrow' },
    leads: { titleKey: 'page.leads.title', eyebrowKey: 'page.leads.eyebrow' },
    telecaller: { titleKey: 'page.telecaller.title', eyebrowKey: 'page.telecaller.eyebrow' },
    tasks: { titleKey: 'page.tasks.title', eyebrowKey: 'page.tasks.eyebrow' },
    pipeline: { titleKey: 'page.pipeline.title', eyebrowKey: 'page.pipeline.eyebrow' },
    sitevisits: { titleKey: 'page.sitevisits.title', eyebrowKey: 'page.sitevisits.eyebrow' },
    measurements: { titleKey: 'page.measurements.title', eyebrowKey: 'page.measurements.eyebrow' },
    projectphotos: {
      titleKey: 'page.projectphotos.title',
      eyebrowKey: 'page.projectphotos.eyebrow',
    },
    designs: { titleKey: 'page.designs.title', eyebrowKey: 'page.designs.eyebrow' },
    designvault: { titleKey: 'page.designvault.title', eyebrowKey: 'page.designvault.eyebrow' },
    revisions: { titleKey: 'page.revisions.title', eyebrowKey: 'page.revisions.eyebrow' },
    quotations: { titleKey: 'page.quotations.title', eyebrowKey: 'page.quotations.eyebrow' },
    workorders: { titleKey: 'page.workorders.title', eyebrowKey: 'page.workorders.eyebrow' },
    projects: { titleKey: 'page.projects.title', eyebrowKey: 'page.projects.eyebrow' },
    milestones: { titleKey: 'page.milestones.title', eyebrowKey: 'page.milestones.eyebrow' },
    sitelogs: { titleKey: 'page.sitelogs.title', eyebrowKey: 'page.sitelogs.eyebrow' },
    campaigns: { titleKey: 'page.campaigns.title', eyebrowKey: 'page.campaigns.eyebrow' },
    leadanalytics: {
      titleKey: 'page.leadanalytics.title',
      eyebrowKey: 'page.leadanalytics.eyebrow',
    },
    contentcalendar: {
      titleKey: 'page.contentcalendar.title',
      eyebrowKey: 'page.contentcalendar.eyebrow',
    },
    procurement: { titleKey: 'page.procurement.title', eyebrowKey: 'page.procurement.eyebrow' },
    vendors: { titleKey: 'page.vendors.title', eyebrowKey: 'page.vendors.eyebrow' },
    purchaseorders: {
      titleKey: 'page.purchaseorders.title',
      eyebrowKey: 'page.purchaseorders.eyebrow',
    },
    employees: { titleKey: 'page.employees.title', eyebrowKey: 'page.employees.eyebrow' },
    audit: { titleKey: 'page.audit.title', eyebrowKey: 'page.audit.eyebrow' },
    settings: { titleKey: 'page.settings.title', eyebrowKey: 'page.settings.eyebrow' },
    triage: { titleKey: 'page.triage.title', eyebrowKey: 'page.triage.eyebrow' },
    approvals: { titleKey: 'page.approvals.title', eyebrowKey: 'page.approvals.eyebrow' },
    invoices: { titleKey: 'page.invoices.title', eyebrowKey: 'page.invoices.eyebrow' },
    receivables: { titleKey: 'page.receivables.title', eyebrowKey: 'page.receivables.eyebrow' },
    payables: { titleKey: 'page.payables.title', eyebrowKey: 'page.payables.eyebrow' },
    ledger: { titleKey: 'page.ledger.title', eyebrowKey: 'page.ledger.eyebrow' },
    quoteapprovals: {
      titleKey: 'page.quoteapprovals.title',
      eyebrowKey: 'page.quoteapprovals.eyebrow',
    },
    targets: { titleKey: 'page.targets.title', eyebrowKey: 'page.targets.eyebrow' },
  };

  const ROLE_PAGE_GUARD = {
    overview: () => true,
    actionqueue: () => KRY.isCentral(),
    triage: () => KRY.isCentral(),
    approvals: () => KRY.isCentral(),
    reports: () => KRY.isCentral(),
    taskboard: () => KRY.isCentral() || KRY.roleIs('DIGITAL_MARKETING'),
    leads: () => KRY.isCentral() || KRY.isSales(),
    telecaller: () => KRY.roleIs('TELECALLER') || KRY.isSales(),
    tasks: () =>
      !KRY.roleIs('SUPER_ADMIN') &&
      !KRY.roleIs('PROJECT_MANAGER') &&
      !KRY.roleIs('DIGITAL_MARKETING') &&
      !KRY.roleIs('ACCOUNTS'),
    pipeline: () => KRY.isSales() || KRY.isCentral(),
    sitevisits: () => KRY.isCentral() || KRY.roleIs('SITE_ENGINEER'),
    measurements: () => KRY.isCentral() || KRY.roleIs('SITE_ENGINEER'),
    projectphotos: () =>
      KRY.isCentral() || KRY.roleIs('SITE_ENGINEER') || KRY.roleIs('PROJECT_MANAGER'),
    designs: () => KRY.isCentral() || KRY.roleIs('ARCHITECT'),
    designvault: () => KRY.isCentral() || KRY.roleIs('ARCHITECT'),
    revisions: () => KRY.isCentral() || KRY.roleIs('ARCHITECT'),
    quotations: () => KRY.isCentral() || KRY.isSales(),
    workorders: () => KRY.isCentral() || KRY.isSales() || KRY.roleIs('PROJECT_MANAGER'),
    projects: () => KRY.isCentral() || KRY.roleIs('PROJECT_MANAGER') || KRY.roleIs('SITE_ENGINEER'),
    milestones: () => KRY.isCentral() || KRY.roleIs('PROJECT_MANAGER'),
    sitelogs: () => KRY.isCentral() || KRY.roleIs('PROJECT_MANAGER'),
    campaigns: () => KRY.isCentral() || KRY.roleIs('DIGITAL_MARKETING'),
    leadanalytics: () => KRY.isCentral() || KRY.roleIs('DIGITAL_MARKETING'),
    contentcalendar: () => KRY.isCentral() || KRY.roleIs('DIGITAL_MARKETING'),
    procurement: () =>
      KRY.isCentral() ||
      KRY.roleIs('PURCHASE') ||
      KRY.roleIs('PROJECT_MANAGER') ||
      KRY.roleIs('SITE_ENGINEER'),
    vendors: () => KRY.isCentral() || KRY.roleIs('PURCHASE'),
    purchaseorders: () => KRY.isCentral() || KRY.roleIs('PURCHASE'),
    invoices: () => KRY.isCentral() || KRY.roleIs('ACCOUNTS'),
    receivables: () => KRY.isCentral() || KRY.roleIs('ACCOUNTS'),
    payables: () => KRY.isCentral() || KRY.roleIs('ACCOUNTS'),
    ledger: () => KRY.isCentral() || KRY.roleIs('ACCOUNTS'),
    quoteapprovals: () => KRY.isCentral() || KRY.isSalesManager(),
    targets: () => KRY.isCentral() || KRY.isSalesManager(),
    employees: () => KRY.isCentral(),
    audit: () => KRY.isCentral(),
    settings: () => KRY.roleIs('SUPER_ADMIN'),
  };

  const state = {
    token: '',
    user: null,
    page: 'overview',
    employees: null,
    employeesAt: 0,
    notifications: [],
    notifyOpen: false,
  };
  KRY.state = state;
  KRY.pages = {};
  KRY.STAGES = STAGES;
  KRY.CENTRAL_ROLES = CENTRAL_ROLES;
  KRY.SALES_ROLES = SALES_ROLES;
  KRY.ROLE_LABELS = ROLE_LABELS;

  /* ------------------------------------------------------------ DOM helpers */

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach((entry) => append(parent, entry));
      return;
    }
    if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'onClick' || (key.startsWith('on') && typeof value === 'function')) {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key in node) {
          try {
            node[key] = value;
          } catch {
            node.setAttribute(key, value);
          }
        } else {
          node.setAttribute(key, value);
        }
      }
    }
    append(node, children);
    return node;
  }

  function icon(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  KRY.el = el;
  KRY.icon = icon;
  KRY.clear = clear;
  window.el = el;
  window.icon = icon;
  window.clear = clear;

  /* -------------------------------------------------------------- Formatting */

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value).trim();
    if (!text) return null;
    // Date-only values describe a calendar day, so parse them as local time.
    const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (dayOnly) {
      return new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]));
    }
    // SQLite "YYYY-MM-DD HH:MM:SS" is UTC.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
      return new Date(`${text.replace(' ', 'T')}Z`);
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function fmtDate(value) {
    const date = parseDate(value);
    return date
      ? date.toLocaleDateString(KRY.dateLocale(), {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—';
  }

  function fmtDateTime(value) {
    const date = parseDate(value);
    return date
      ? date.toLocaleString(KRY.dateLocale(), {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';
  }

  function timeAgo(value) {
    const date = parseDate(value);
    if (!date) return '—';
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return t('time.justNow');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    const days = Math.round(hours / 24);
    if (days < 30) return t('time.daysAgo', { count: days });
    return fmtDate(value);
  }

  const inr = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
  function money(value) {
    const number = Number(value);
    return Number.isFinite(number) ? inr.format(number) : '—';
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  }

  function titleCase(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function localISO(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  /** "2 days", "6 hr", "20 min" from a number of hours. */
  function durationText(hours) {
    const value = Number(hours);
    if (!Number.isFinite(value)) return '';
    const abs = Math.abs(value);
    if (abs < 1) return t('duration.minutes', { count: Math.max(1, Math.round(abs * 60)) });
    if (abs < 24) return t('duration.hours', { count: Math.round(abs) });
    return t('duration.days', { count: Math.round(abs / 24) });
  }

  /**
   * Plain-language due line used on every card:
   * "Late by 2 days", "Due today", "6 hr left", "Waiting 3 days".
   */
  function dueLabel(item) {
    if (!item) return t('due.noDue');
    if (item.status === 'Submitted' || item.status === 'Reviewed') {
      const days = Number(item.waiting_days) || 0;
      return KRY.tp(days, 'due.waitingOne', 'due.waitingMany', { count: days });
    }
    if (item.sla && item.sla.status === 'overdue') {
      return t('due.lateBy', { duration: durationText(Math.abs(item.sla.hoursRemaining)) });
    }
    if (item.due_date) {
      const today = localISO();
      const due = String(item.due_date).slice(0, 10);
      if (due < today) {
        const days = Math.max(
          1,
          Math.round((parseDate(today).getTime() - parseDate(due).getTime()) / 86_400_000),
        );
        return t('due.lateBy', { duration: t('duration.days', { count: days }) });
      }
      if (due === today) return t('due.dueToday');
      if (due === localISO(1)) return t('due.dueTomorrow');
      return t('due.dueOn', { date: fmtDate(due) });
    }
    if (item.sla && ['warning', 'on_track'].includes(item.sla.status)) {
      return t('due.left', { duration: durationText(item.sla.hoursRemaining) });
    }
    if (item.kind === 'quotation' && item.waiting_days) {
      return KRY.tp(item.waiting_days, 'due.pendingOne', 'due.pendingMany', {
        count: item.waiting_days,
      });
    }
    if (['lead', 'work_order'].includes(item.kind) && item.waiting_days) {
      return KRY.tp(item.waiting_days, 'due.pendingOne', 'due.pendingMany', {
        count: item.waiting_days,
      });
    }
    if (item.kind === 'project') return t('due.noDue');
    return t('due.noDue');
  }

  function dueTone(item) {
    if (!item) return 'neutral';
    if (item.bucket === 'late') return 'danger';
    if (item.bucket === 'today' || item.bucket === 'urgent') return 'warn';
    if (item.bucket === 'waiting') return 'info';
    return 'good';
  }

  KRY.parseDate = parseDate;
  KRY.fmtDate = fmtDate;
  KRY.fmtDateTime = fmtDateTime;
  KRY.timeAgo = timeAgo;
  KRY.money = money;
  KRY.initials = initials;
  KRY.titleCase = titleCase;
  KRY.localISO = localISO;
  KRY.durationText = durationText;
  KRY.dueLabel = dueLabel;
  KRY.dueTone = dueTone;

  /* ---------------------------------------------------------------- Badges */

  function stageTone(stage) {
    if (!stage) return 'neutral';
    if (['Lost'].includes(stage)) return 'danger';
    if (['Closed', 'Completed', 'Approved', 'Work Order Finalized'].includes(stage)) return 'good';
    if (['Nurture', 'Follow-up Required', 'Negotiation'].includes(stage)) return 'warn';
    if (
      [
        'Work Order Pending Admin Approval',
        'Project Handoff',
        'In Progress',
        'Site Visit Scheduled',
        'Design In Progress',
      ].includes(stage)
    ) {
      return 'brand';
    }
    return 'info';
  }

  function badge(text, tone = 'neutral') {
    return el('span', { class: `badge ${tone}`, text });
  }

  function stageBadge(stage) {
    return badge(stage ? KRY.stageLabel(stage) : '—', stageTone(stage));
  }

  function statusTone(status) {
    if (!status) return 'neutral';
    if (['Assigned', 'Draft', 'Pending', 'Planning', 'Requested'].includes(status))
      return 'neutral';
    if (['In Progress', 'Sent', 'Submitted', 'Negotiation', 'Active'].includes(status))
      return 'info';
    if (
      ['Reviewed', 'Completed', 'Approved', 'Finalized', 'Delivered', 'Received'].includes(status)
    )
      return 'good';
    if (
      ['Revision Needed', 'Clarification Needed', 'On Hold', 'Delayed', 'Warning'].includes(status)
    )
      return 'warn';
    if (['Rejected', 'Cancelled', 'Overdue', 'Dishonoured'].includes(status)) return 'danger';
    if (status === 'Pending Admin Approval') return 'brand';
    return 'neutral';
  }

  function statusBadge(status) {
    return badge(status ? KRY.statusLabel(status) : '—', statusTone(status));
  }

  function priorityBadge(priority) {
    const tone =
      { Urgent: 'danger', High: 'warn', Medium: 'info', Low: 'neutral' }[priority] || 'neutral';
    return badge(KRY.priorityLabel(priority || 'Medium'), tone);
  }

  function slaBadge(sla) {
    if (!sla || sla.status === 'unknown') return badge(t('due.noDue'), 'neutral');
    if (sla.status === 'overdue') {
      return badge(
        t('due.lateBy', { duration: durationText(Math.abs(sla.hoursRemaining)) }),
        'danger',
      );
    }
    if (sla.status === 'warning') {
      return badge(t('due.left', { duration: durationText(sla.hoursRemaining) }), 'warn');
    }
    return badge(t('due.left', { duration: durationText(sla.hoursRemaining) }), 'good');
  }

  function dueBadge(item) {
    return badge(dueLabel(item), dueTone(item));
  }

  function roleBadge(role) {
    const tone = CENTRAL_ROLES.includes(role)
      ? 'brand'
      : SALES_ROLES.includes(role)
        ? 'info'
        : 'neutral';
    return badge(KRY.roleLabel(role), tone);
  }

  KRY.badge = badge;
  KRY.stageBadge = stageBadge;
  KRY.statusBadge = statusBadge;
  KRY.priorityBadge = priorityBadge;
  KRY.slaBadge = slaBadge;
  KRY.dueBadge = dueBadge;
  KRY.roleBadge = roleBadge;

  /* ------------------------------------------------------------ Role gates */

  KRY.isCentral = (user = state.user) => Boolean(user && CENTRAL_ROLES.includes(user.role));
  KRY.isSales = (user = state.user) => Boolean(user && SALES_ROLES.includes(user.role));
  KRY.isSalesManager = (user = state.user) => Boolean(user && user.role === 'SALES_MANAGER');
  KRY.roleIs = (role, user = state.user) => Boolean(user && user.role === role);

  /* ------------------------------------------------------------- Toast/API */

  function toast(message, tone = 'info', action = null) {
    const root = document.getElementById('toastRoot');
    const node = el('div', { class: `toast ${tone}`, text: message });
    if (action && action.label && typeof action.onClick === 'function') {
      const btn = el('button', {
        type: 'button',
        class: 'btn btn-sm btn-outline ms-2',
        text: action.label,
        onClick: (e) => {
          e.stopPropagation();
          node.remove();
          action.onClick();
        },
      });
      node.appendChild(btn);
    }
    root.appendChild(node);
    setTimeout(() => {
      node.remove();
    }, 6000);
  }
  KRY.toast = toast;

  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    localStorage.removeItem('kryston.token');
  }

  async function api(path, options = {}) {
    const headers = {};
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const csrfToken = getCookie('kryston_csrf');
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const response = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.status === 401) {
      clearSession();
      if (typeof KRY.showLogin === 'function') KRY.showLogin();
      const error = new Error(t('error.sessionExpired'));
      error.status = 401;
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      if (response.status === 409) {
        toast('Refresh, someone else changed this', 'error', {
          label: 'Refresh',
          onClick: () => window.location.reload(),
        });
      }
      const error = new Error(
        (data && data.error) ||
          (response.status === 409
            ? 'Refresh, someone else changed this'
            : `Request failed (${response.status}).`),
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }
  KRY.api = api;

  async function download(path, fallbackName) {
    const headers = {};
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const csrfToken = getCookie('kryston_csrf');
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers,
    });
    if (!response.ok) {
      let message = `Download failed (${response.status}).`;
      try {
        const data = await response.json();
        if (data && data.error) message = data.error;
      } catch {
        /* binary response */
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const name = match ? match[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: name });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(t('common.downloading'), 'success');
  }
  KRY.download = download;

  /* ---------------------------------------------------------------- Modals */

  const modalRoot = () => document.getElementById('modalRoot');

  function closeModal() {
    if (typeof KRY.onBeforeModalClose === 'function') {
      try {
        KRY.onBeforeModalClose();
      } catch {
        /* cleanup is best effort */
      }
    }
    const root = modalRoot();
    clear(root);
    root.hidden = true;
  }
  KRY.closeModal = closeModal;

  function openModal({ title, subtitle, body, actions = [], footer = null, size = '' }) {
    const root = modalRoot();
    clear(root);

    const foot =
      footer ||
      (actions.length
        ? el(
            'div',
            { class: 'modal-foot' },
            actions.map((action) =>
              el('button', {
                class: `btn ${action.class || ''}`.trim(),
                type: 'button',
                text: action.label,
                disabled: Boolean(action.disabled),
                onClick: action.onClick,
              }),
            ),
          )
        : null);

    const modal = el(
      'div',
      { class: `modal ${size}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el(
        'div',
        { class: 'modal-head' },
        el('div', {}, el('h2', { text: title }), subtitle ? el('p', { text: subtitle }) : null),
        el(
          'button',
          {
            class: 'btn btn-icon',
            type: 'button',
            'aria-label': t('common.close'),
            onClick: closeModal,
          },
          icon('close'),
        ),
      ),
      el('div', { class: 'modal-body' }, body),
      foot,
    );

    modal.addEventListener('click', (event) => event.stopPropagation());
    const previousFocus = document.activeElement;
    modal.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const items = [
        ...modal.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      ].filter((node) => node.getClientRects().length);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      }
    });
    const restoreFocus = new window.MutationObserver(() => {
      if (!root.hidden) return;
      restoreFocus.disconnect();
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    restoreFocus.observe(root, { attributes: true, attributeFilter: ['hidden'] });
    root.appendChild(modal);
    root.hidden = false;

    const focusTarget = modal.querySelector('input, select, textarea, button');
    if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
  }
  KRY.openModal = openModal;

  /* ----------------------------------------------------------------- Forms */

  let fieldSequence = 0;

  function field(def) {
    fieldSequence += 1;
    const id = `f-${def.name}-${fieldSequence}`;

    if (def.type === 'checkbox') {
      return el(
        'label',
        { class: 'checkbox-row' },
        el('input', {
          id,
          name: def.name,
          type: 'checkbox',
          checked: Boolean(def.value),
        }),
        el('span', { text: def.label }),
      );
    }

    let input;
    if (def.type === 'textarea') {
      input = el('textarea', {
        id,
        name: def.name,
        required: Boolean(def.required),
        placeholder: def.placeholder || '',
        value: def.value === undefined || def.value === null ? '' : def.value,
        rows: def.rows || 3,
      });
    } else if (def.type === 'select') {
      input = el(
        'select',
        { id, name: def.name, required: Boolean(def.required) },
        (def.options || []).map((option) =>
          el('option', {
            value: option.value,
            text: option.label,
            selected: String(option.value) === String(def.value),
          }),
        ),
      );
      if (def.value !== undefined && def.value !== null) input.value = String(def.value);
    } else {
      input = el('input', {
        id,
        name: def.name,
        type: def.type || 'text',
        required: Boolean(def.required),
        placeholder: def.placeholder || '',
        value: def.value === undefined || def.value === null ? '' : def.value,
        min: def.min,
        max: def.max,
        step: def.step,
        autocomplete: def.autocomplete || 'off',
        inputmode: def.inputmode,
      });
    }

    return el(
      'label',
      { class: `field${def.span2 ? ' span-2' : ''}` },
      el('span', { text: def.label }),
      input,
      def.hint ? el('small', { text: def.hint }) : null,
    );
  }

  function formValues(form) {
    const values = {};
    for (const element of Array.from(form.elements)) {
      if (!element.name) continue;
      if (element.type === 'checkbox') values[element.name] = element.checked;
      else if (element.type === 'number') {
        values[element.name] = element.value === '' ? null : Number(element.value);
      } else values[element.name] = element.value;
    }
    return values;
  }

  function openFormModal({
    title,
    subtitle,
    fields = [],
    submitLabel = t('common.save'),
    size = '',
    onSubmit,
    onSuccess,
    extra,
    note,
    body: customBody,
  }) {
    const error = el('p', { class: 'form-error', hidden: true, role: 'alert' });
    const form = el('form', { class: 'form-stack', novalidate: true });
    fields.forEach((def) => form.appendChild(field(def)));
    if (extra) form.appendChild(extra);
    if (customBody) form.appendChild(customBody);
    if (note) form.appendChild(el('p', { class: 'form-note', text: note }));
    form.appendChild(error);
    form.appendChild(el('button', { type: 'submit', hidden: true }));

    const submit = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: submitLabel,
      onClick: () => form.requestSubmit(),
    });

    let saving = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      saving = true;
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Saving…';
      form.setAttribute('aria-busy', 'true');
      try {
        await onSubmit(formValues(form), form);
        closeModal();
        if (typeof onSuccess === 'function') onSuccess();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        saving = false;
        submit.disabled = false;
        submit.textContent = submitLabel;
        form.removeAttribute('aria-busy');
      }
    });

    openModal({
      title,
      subtitle,
      size,
      body: form,
      footer: el(
        'div',
        { class: 'modal-foot' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: t('common.cancel'),
          onClick: closeModal,
        }),
        submit,
      ),
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        { label: submitLabel, class: 'btn-primary', onClick: () => form.requestSubmit() },
      ],
    });
  }
  KRY.openFormModal = openFormModal;

  function confirmAction({
    title,
    message,
    confirmLabel = t('common.save'),
    danger = false,
    onConfirm,
  }) {
    openModal({
      title,
      size: 'narrow',
      body: el('p', { class: 'muted', text: message }),
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: confirmLabel,
          class: danger ? 'btn-danger' : 'btn-primary',
          onClick: async () => {
            try {
              await onConfirm();
              closeModal();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.confirmAction = confirmAction;

  /** Collapsible "More details" block for advanced fields. */
  function moreDetails(children, label) {
    return el(
      'details',
      { class: 'more-details' },
      el('summary', {}, icon('plus'), el('span', { text: label || t('common.moreDetails') })),
      el('div', { class: 'more-body' }, children),
    );
  }
  KRY.moreDetails = moreDetails;

  /**
   * Large tappable cards used instead of dropdowns for the guided flows.
   * `options`: [{ value, label, description, icon }]
   */
  function choiceCards(options, value, onSelect, { compact = false } = {}) {
    const wrap = el('div', { class: `choice-grid${compact ? ' compact' : ''}` });
    options.forEach((option) => {
      const button = el(
        'button',
        {
          class: `choice-card${String(option.value) === String(value) ? ' selected' : ''}`,
          type: 'button',
          dataset: { value: String(option.value) },
          onClick: () => {
            wrap.querySelectorAll('.choice-card').forEach((node) => {
              node.classList.remove('selected');
              node.setAttribute('aria-pressed', 'false');
            });
            button.classList.add('selected');
            button.setAttribute('aria-pressed', 'true');
            onSelect(option.value);
          },
        },
        option.icon ? el('span', { class: 'choice-icon' }, icon(option.icon)) : null,
        el('strong', { text: option.label }),
        option.description ? el('small', { text: option.description }) : null,
        option.meta ? el('span', { class: 'choice-meta', text: option.meta }) : null,
      );
      button.setAttribute('aria-pressed', String(String(option.value) === String(value)));
      wrap.appendChild(button);
    });
    return wrap;
  }
  KRY.choiceCards = choiceCards;

  function chipRow(options, value, onSelect) {
    const wrap = el('div', { class: 'chip-row' });
    options.forEach((option) => {
      const button = el(
        'button',
        {
          class: `chip-button${String(option.value) === String(value) ? ' selected' : ''}`,
          type: 'button',
          dataset: { value: String(option.value) },
          onClick: () => {
            wrap
              .querySelectorAll('.chip-button')
              .forEach((node) => node.classList.remove('selected'));
            button.classList.add('selected');
            onSelect(option.value);
          },
        },
        option.label,
      );
      wrap.appendChild(button);
    });
    return wrap;
  }
  KRY.chipRow = chipRow;

  /* ----------------------------------------------------------------- Wizard */

  /**
   * Step-by-step flow. Only the current step is rendered; advanced fields live
   * inside a "More details" disclosure. Each step receives `data` (persisted
   * across back/next) and a `rerender` callback for dependent controls.
   *
   * steps: [{ titleKey, helpKey, render(data, ctx) -> Node, collect(data, root) -> error|null }]
   */
  function openWizard({
    title,
    subtitle,
    steps,
    submitLabel,
    size = '',
    onComplete,
    initialData,
    data: incomingData,
  }) {
    if (!Array.isArray(steps) || !steps.length) return null;

    const data = Object.assign({}, incomingData || initialData);
    let index = 0;
    let busy = false;

    const error = el('p', { class: 'form-error', hidden: true, role: 'alert' });
    const stepper = el('div', { class: 'wizard-steps' });
    const stepCount = el('span', { class: 'wizard-count' });
    const stepTitle = el('h3', { class: 'wizard-step-title' });
    const stepHelp = el('p', { class: 'wizard-step-help' });
    const body = el('div', { class: 'wizard-body' });
    const progressLabel = el('span', { class: 'wizard-progress' });
    const backButton = el('button', { class: 'btn', type: 'button', text: t('common.back') });
    const nextButton = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: t('common.next'),
    });

    const foot = el(
      'div',
      { class: 'wizard-foot' },
      progressLabel,
      el('span', { class: 'spacer' }),
      backButton,
      nextButton,
    );

    const root = el(
      'div',
      { class: 'wizard' },
      stepper,
      el('div', { class: 'wizard-head' }, stepTitle, stepCount),
      stepHelp,
      body,
      error,
    );

    function showError(message) {
      error.textContent = message || '';
      error.hidden = !message;
    }

    function renderStepper() {
      clear(stepper);
      steps.forEach((step, stepIndex) => {
        const stateClass = stepIndex < index ? 'done' : stepIndex === index ? 'current' : 'todo';
        stepper.appendChild(
          el(
            'button',
            {
              class: `wizard-step ${stateClass}`,
              type: 'button',
              disabled: stepIndex > index || busy,
              onClick: () => {
                if (busy || stepIndex >= index) return;
                index = stepIndex;
                renderStep();
              },
            },
            el('span', {
              class: 'wizard-step-dot',
              text: stateClass === 'done' ? '✓' : String(stepIndex + 1),
            }),
            el('span', { class: 'wizard-step-label', text: t(step.titleKey) }),
          ),
        );
      });
      progressLabel.textContent = `${Math.round(((index + 1) / steps.length) * 100)}%`;
    }

    function renderStep() {
      const step = steps[index];
      showError('');
      backButton.hidden = index === 0;
      backButton.disabled = busy;
      nextButton.disabled = busy;
      nextButton.textContent =
        index === steps.length - 1 ? submitLabel || t('common.finish') : t('common.next');
      stepTitle.textContent = t(step.titleKey);
      stepHelp.textContent = step.helpKey ? t(step.helpKey) : '';
      stepHelp.hidden = !step.helpKey;
      stepCount.textContent = t('wizard.step', { current: index + 1, total: steps.length });
      clear(body);
      try {
        const content = step.render(data, {
          data,
          rerender: renderStep,
          setData(patch) {
            Object.assign(data, patch);
          },
        });
        if (content) body.appendChild(content);
      } catch (err) {
        console.error('Wizard step render error:', err);
        showError(err.message || String(err));
      }
      renderStepper();
      const focusTarget = body.querySelector('input, select, textarea');
      if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
    }

    function collectCurrent() {
      const step = steps[index];
      if (typeof step.collect !== 'function') return true;
      const message = step.collect(data, body);
      if (message) {
        showError(message);
        return false;
      }
      return true;
    }

    async function submit() {
      if (busy) return;
      busy = true;
      backButton.disabled = true;
      nextButton.disabled = true;
      nextButton.textContent = t('common.save');
      try {
        await onComplete(data);
        closeModal();
      } catch (err) {
        showError(err.message || String(err));
        busy = false;
        backButton.disabled = false;
        nextButton.disabled = false;
        nextButton.textContent = submitLabel || t('common.finish');
      }
    }

    backButton.addEventListener('click', () => {
      if (busy || index === 0) return;
      index -= 1;
      renderStep();
    });

    nextButton.addEventListener('click', () => {
      if (busy || !collectCurrent()) return;
      if (index === steps.length - 1) {
        submit();
        return;
      }
      index += 1;
      renderStep();
    });

    openModal({ title, subtitle, size, body: root, footer: foot });
    renderStep();
    return { data, close: closeModal };
  }
  KRY.openWizard = openWizard;

  /* ------------------------------------------------------------- UI builders */

  function pageHead(title, description, actions) {
    const actionList = (actions || []).filter(Boolean);
    return el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        { class: 'page-head-copy' },
        el('h2', { text: title }),
        description ? el('p', { text: description }) : null,
      ),
      actionList.length ? el('div', { class: 'page-head-actions' }, actionList) : null,
    );
  }

  function sectionHeader(title, description, action) {
    return el(
      'div',
      { class: 'section-head' },
      el('div', {}, el('h2', { text: title }), description ? el('p', { text: description }) : null),
      el('span', { class: 'spacer' }),
      action || null,
    );
  }

  function card(title, description, body, options = {}) {
    return el(
      'section',
      { class: 'card' },
      title || options.actions
        ? el(
            'div',
            { class: 'card-head' },
            el(
              'div',
              {},
              el('h2', { text: title || '' }),
              description ? el('p', { text: description }) : null,
            ),
            el('span', { class: 'spacer' }),
            options.actions || null,
          )
        : null,
      options.tight ? body : el('div', { class: 'card-body' }, body),
      options.footer ? el('div', { class: 'card-foot' }, options.footer) : null,
    );
  }

  function statCard(label, value, foot, tone = '') {
    const tones = ['brand', 'accent', 'good', 'warn', 'danger', 'info', 'neutral'];
    if (tones.includes(foot) && tone && !tones.includes(tone)) [foot, tone] = [tone, foot];
    return el(
      'div',
      { class: `stat-card ${tone}`.trim() },
      el('span', { class: 'stat-label', text: label }),
      el('span', { class: 'stat-value', text: value }),
      foot ? el('span', { class: 'stat-foot', text: foot }) : null,
    );
  }

  function emptyState(title, message, iconName) {
    return el(
      'div',
      { class: 'empty-state' },
      iconName ? el('span', { class: 'empty-icon' }, icon(iconName)) : null,
      el('strong', { text: title }),
      message ? el('span', { text: message }) : null,
    );
  }

  function kv(rows) {
    const list = el('dl', { class: 'kv' });
    rows.forEach(([term, value]) => {
      if (value === undefined || value === null || value === '') return;
      list.appendChild(el('dt', { text: term }));
      list.appendChild(el('dd', {}, value instanceof Node ? value : String(value)));
    });
    return list;
  }

  function dataTable(
    headers,
    rows,
    { emptyTitle = t('common.nothingHere'), emptyMessage = '', clickable = false } = {},
  ) {
    if (!rows.length) return emptyState(emptyTitle, emptyMessage);
    return el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            headers.map((header) => el('th', { text: header })),
          ),
        ),
        el(
          'tbody',
          {},
          rows.map((row) =>
            el(
              'tr',
              { class: clickable || row.onClick ? 'clickable' : '', onClick: row.onClick },
              row.cells.map((cell, index) =>
                el(
                  'td',
                  { 'data-label': headers[index] || '' },
                  cell instanceof Node ? cell : String(cell ?? '—'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function formatTimelineRemarks(text) {
    if (!text) return null;
    // Check if remarks contain structured call log patterns like [Connected] [Initial Enquiry]
    if (text.includes('[') && text.includes(']')) {
      const container = el('div', { class: 'timeline-text structured-timeline-text' });
      // Split into parts matching [Tag] or regular text
      const regex = /\[(.*?)\]/g;
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          const preText = text.substring(lastIndex, match.index);
          container.appendChild(document.createTextNode(preText));
        }

        const tagText = match[1];
        let badgeCls = 'structured-call-badge';
        const lower = tagText.toLowerCase();
        if (lower.includes('connected')) badgeCls += ' badge-outcome-connected';
        else if (lower.includes('callback')) badgeCls += ' badge-outcome-callback';
        else if (lower.includes('no answer') || lower.includes('busy'))
          badgeCls += ' badge-outcome-busy';
        else if (lower.includes('wrong') || lower.includes('invalid'))
          badgeCls += ' badge-outcome-wrong';
        else badgeCls += ' badge-purpose';

        container.appendChild(el('span', { class: badgeCls, text: `[${tagText}]` }));
        lastIndex = regex.lastIndex;
      }

      if (lastIndex < text.length) {
        const postText = text.substring(lastIndex);
        // Highlight keys like Requirement:, Budget:, Location:, Notes:
        const formatted = postText
          .replace(/\|\s*Requirement:/g, '\n**Requirement:**')
          .replace(/\(Budget:/g, '· **Budget:**')
          .replace(/\|\s*Location:/g, '\n**Location:**')
          .replace(/Notes:/g, '\n**Notes:**');

        const lines = formatted.split('\n');
        lines.forEach((line, idx) => {
          if (idx > 0) container.appendChild(el('br'));
          const boldMatch = line.match(/\*\*(.*?)\*\*(.*)/);
          if (boldMatch) {
            container.appendChild(el('strong', { text: boldMatch[1] + ' ' }));
            container.appendChild(document.createTextNode(boldMatch[2]));
          } else {
            container.appendChild(document.createTextNode(line));
          }
        });
      }

      return container;
    }

    return el('div', { class: 'timeline-text', text });
  }

  function timeline(entries) {
    if (!entries.length) return emptyState(t('common.nothingHere'), t('myday.activityEmpty'));
    return el(
      'div',
      { class: 'timeline' },
      entries
        .slice()
        .reverse()
        .map((entry) =>
          el(
            'div',
            { class: 'timeline-item' },
            el('span', { class: 'timeline-dot' }),
            el(
              'div',
              { class: 'timeline-body' },
              el(
                'div',
                { class: 'between' },
                el('span', {
                  class: 'timeline-title',
                  text:
                    t(`activity.${entry.action_type}`) === `activity.${entry.action_type}`
                      ? titleCase(entry.action_type)
                      : t(`activity.${entry.action_type}`),
                }),
                el('span', { class: 'timeline-meta', text: fmtDateTime(entry.created_at) }),
              ),
              el('div', {
                class: 'timeline-meta',
                text: [
                  entry.from_employee_name || entry.from_name,
                  entry.to_employee_name || entry.to_name
                    ? `→ ${entry.to_employee_name || entry.to_name}`
                    : '',
                  entry.to_department,
                ]
                  .filter(Boolean)
                  .join(' '),
              }),
              entry.remarks ? formatTimelineRemarks(entry.remarks) : null,
              entry.old_stage || entry.new_stage
                ? el(
                    'div',
                    { class: 'pill-row' },
                    entry.old_stage ? badge(KRY.stageLabel(entry.old_stage), 'neutral') : null,
                    entry.new_stage
                      ? badge(`→ ${KRY.stageLabel(entry.new_stage)}`, stageTone(entry.new_stage))
                      : null,
                  )
                : null,
            ),
          ),
        ),
    );
  }

  function progressBar(value, tone = '') {
    const number = Math.max(0, Math.min(100, Number(value) || 0));
    return el('progress', { class: tone, max: 100, value: number });
  }

  function toolbar(children) {
    return el('div', { class: 'toolbar' }, children);
  }

  function searchInput(placeholder, value, onInput) {
    const input = el('input', {
      type: 'search',
      placeholder,
      value: value || '',
      'aria-label': placeholder,
    });
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => onInput(input.value.trim()), 250);
    });
    return el('div', { class: 'search-input' }, icon('search'), input);
  }

  function listRow({ iconName, title, meta, detail, right, onClick }) {
    return el(
      'div',
      { class: `list-item${onClick ? ' clickable' : ''}`, onClick },
      el('span', { class: 'list-icon' }, icon(iconName || 'check')),
      el(
        'div',
        { class: 'list-body' },
        el('div', { class: 'list-title', text: title }),
        meta ? el('div', { class: 'list-meta', text: meta }) : null,
        detail ? el('div', { class: 'small muted', text: detail }) : null,
      ),
      right || null,
    );
  }

  Object.assign(KRY, {
    pageHead,
    sectionHeader,
    card,
    statCard,
    emptyState,
    kv,
    dataTable,
    timeline,
    progressBar,
    toolbar,
    searchInput,
    listRow,
    field,
    formValues,
  });

  window.card = card;
  window.statCard = statCard;
  window.emptyState = emptyState;
  window.dataTable = dataTable;
  window.pageHead = pageHead;
  window.api = api;

  /* --------------------------------------------------------- Employee cache */

  async function getEmployees(force = false) {
    if (!force && state.employees && Date.now() - state.employeesAt < 60_000) {
      return state.employees;
    }
    const rows = await api('/employees');
    state.employees = rows;
    state.employeesAt = Date.now();
    return rows;
  }
  KRY.getEmployees = getEmployees;

  function optionsFor(employees, predicate, { placeholder = t('common.select') } = {}) {
    return [
      { value: '', label: placeholder },
      ...employees.filter(predicate).map((employee) => ({
        value: employee.id,
        label: `${employee.name} · ${KRY.roleLabel(employee.role)}`,
      })),
    ];
  }
  KRY.optionsFor = optionsFor;

  /* ---------------------------------------------------------------- Session */

  function setSession(token, user) {
    state.token = token || '';
    state.user = user;
    localStorage.removeItem('kryston.token');
  }
  KRY.setSession = setSession;
  KRY.clearSession = clearSession;

  function updateChrome() {
    const user = state.user;
    if (!user) return;
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userRole').textContent = KRY.roleLabel(user.role);
    document.getElementById('userInitials').textContent = initials(user.name);
    document.getElementById('topbarName').textContent = user.name;
    document.getElementById('topbarDept').textContent =
      `${KRY.roleLabel(user.role)} · ${KRY.deptLabel(user.department)}`;
    document.getElementById('topbarInitials').textContent = initials(user.name);

    document.querySelectorAll('#nav .nav-item').forEach((button) => {
      const page = button.dataset.page;
      const guard = ROLE_PAGE_GUARD[page];
      button.hidden = Boolean(guard && !guard());
    });

    // Handle role-specific section headers
    document.querySelectorAll('.nav-label').forEach((label) => {
      const group = label.dataset.group;
      if (user.role === 'SUPER_ADMIN') {
        if (group === 'today') {
          label.textContent = 'Executive';
          label.hidden = false;
        } else if (group === 'work') {
          label.textContent = 'Operations';
          label.hidden = false;
        } else if (group === 'leads') {
          label.hidden = true;
        } else if (group === 'admin') {
          label.textContent = 'System';
          label.hidden = false;
        } else {
          label.hidden = true;
        }
      } else {
        if (label.dataset.central !== undefined) {
          label.hidden = !KRY.isCentral();
        } else if (group === 'procurement') {
          label.hidden = !(
            KRY.isCentral() ||
            KRY.roleIs('PURCHASE') ||
            KRY.roleIs('PROJECT_MANAGER') ||
            KRY.roleIs('SITE_ENGINEER')
          );
        } else if (group === 'marketing') {
          label.hidden = !(KRY.isCentral() || KRY.roleIs('DIGITAL_MARKETING'));
        } else if (group === 'accounts') {
          label.hidden = !(KRY.isCentral() || KRY.roleIs('ACCOUNTS'));
        } else if (group === 'salesmgr') {
          label.hidden = !(KRY.isCentral() || KRY.isSalesManager());
        } else {
          label.hidden = false;
        }
      }
    });

    // Role-specific button labels and navigation adaptations
    const myDayBtn = document.querySelector(
      '#nav button[data-page="overview"] span:not(.nav-badge)',
    );
    if (myDayBtn) {
      if (user.role === 'SUPER_ADMIN') myDayBtn.textContent = 'Command Center';
      else if (user.role === 'ADMIN') myDayBtn.textContent = 'Mission Control';
      else if (user.role === 'PROJECT_MANAGER') myDayBtn.textContent = 'Overview';
      else if (user.role === 'DIGITAL_MARKETING') myDayBtn.textContent = 'Marketing Overview';
      else if (user.role === 'ARCHITECT') myDayBtn.textContent = 'Design Studio';
      else if (user.role === 'SITE_ENGINEER') myDayBtn.textContent = 'Field Dashboard';
      else if (user.role === 'ACCOUNTS') myDayBtn.textContent = 'Financial Dashboard';
      else if (KRY.isSalesManager()) myDayBtn.textContent = 'Team Dashboard';
      else if (KRY.isSales()) myDayBtn.textContent = 'Sales Dashboard';
      else if (user.role === 'PURCHASE') myDayBtn.textContent = 'Procurement Dashboard';
      else myDayBtn.textContent = t('nav.myday') || 'My Day';
    }

    const taskboardBtn = document.querySelector(
      '#nav button[data-page="taskboard"] span:not(.nav-badge)',
    );
    if (taskboardBtn && user.role === 'ADMIN') {
      taskboardBtn.textContent = 'Global Pipeline';
    }

    const employeesBtn = document.querySelector(
      '#nav button[data-page="employees"] span:not(.nav-badge)',
    );
    if (employeesBtn && (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN')) {
      employeesBtn.textContent = 'Team Directory';
    }

    const pipelineBtn = document.querySelector(
      '#nav button[data-page="pipeline"] span:not(.nav-badge)',
    );
    if (pipelineBtn && KRY.isSalesManager()) {
      pipelineBtn.textContent = 'Team Pipeline';
    }

    const telecallerBtn = document.querySelector(
      '#nav button[data-page="telecaller"] span:not(.nav-badge)',
    );
    if (telecallerBtn) {
      if (KRY.isSales()) telecallerBtn.textContent = 'Follow-ups Due';
      else telecallerBtn.textContent = t('nav.telecaller') || 'Calls';
    }

    const projectsBtn = document.querySelector(
      '#nav button[data-page="projects"] span:not(.nav-badge)',
    );
    if (projectsBtn) {
      if (user.role === 'PROJECT_MANAGER') projectsBtn.textContent = 'My Projects';
      else projectsBtn.textContent = t('nav.projects') || 'Projects';
    }

    const sitevisitsBtn = document.querySelector(
      '#nav button[data-page="sitevisits"] span:not(.nav-badge)',
    );
    if (sitevisitsBtn) {
      if (user.role === 'SITE_ENGINEER') sitevisitsBtn.textContent = 'My Site Visits';
      else sitevisitsBtn.textContent = t('nav.sitevisits') || 'Site Visits';
    }

    const procurementBtn = document.querySelector(
      '#nav button[data-page="procurement"] span:not(.nav-badge)',
    );
    if (procurementBtn) {
      if (user.role === 'SITE_ENGINEER' || user.role === 'PROJECT_MANAGER')
        procurementBtn.textContent = 'Material Requests';
      else procurementBtn.textContent = 'Procurement Dashboard';
    }

    const workTasksBtn = document.querySelector(
      '#nav button[data-page="tasks"] span:not(.nav-badge)',
    );
    if (workTasksBtn) {
      if (user.role === 'PURCHASE') workTasksBtn.textContent = 'My Tasks';
      else workTasksBtn.textContent = t('nav.tasks') || 'My Work';
    }

    // Role-specific Floating Action Button (FAB)
    let fab = document.getElementById('roleFabButton');
    if (user.role === 'PROJECT_MANAGER' || user.role === 'SITE_ENGINEER') {
      if (!fab) {
        fab = document.createElement('button');
        fab.id = 'roleFabButton';
        fab.className = 'fab-btn';
        fab.type = 'button';
        fab.title = user.role === 'PROJECT_MANAGER' ? 'Quick Site Photo / Log' : 'Quick Site Photo';
        fab.innerHTML = '<svg class="icon"><use href="#i-camera"></use></svg>';
        fab.onclick = () => {
          if (typeof KRY.openQuickPhotoModal === 'function') {
            KRY.openQuickPhotoModal();
          } else {
            toast('Opening Quick Camera upload...', 'info');
          }
        };
        document.body.appendChild(fab);
      }
      fab.hidden = false;
    } else if (fab) {
      fab.hidden = true;
    }

    // Keyboard shortcut Cmd+K / Ctrl+K for Global Search
    if (!window._globalSearchBound) {
      window._globalSearchBound = true;
      window.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          const searchInput = document.getElementById('globalSearchInput');
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
        }
      });

      const searchInput = document.getElementById('globalSearchInput');
      if (searchInput) {
        searchInput.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (!query) return;
            try {
              const results = await api(`/leads?query=${encodeURIComponent(query)}&limit=10`);
              if (results && results.length) {
                KRY.openLeadModal(results[0].id);
                toast(`Found lead: ${results[0].customer_name} (${results[0].id})`, 'info');
              } else {
                toast(`No leads found matching "${query}".`, 'info');
              }
            } catch {
              /* ignore */
            }
          }
        });
      }
    }

    KRY.applyStaticText(document);
  }
  KRY.updateChrome = updateChrome;

  /* ------------------------------------------------------------ Notifications */

  async function refreshNotifications() {
    if (!state.user) return;
    // Badges are cheap; refresh them alongside the inbox.
    refreshBadges();
    try {
      const [rows, unread] = await Promise.all([
        api('/notifications?limit=20'),
        api('/notifications/unread-count'),
      ]);
      state.notifications = rows;
      const badgeNode = document.getElementById('notifyBadge');
      const count = Number(unread.unread) || 0;
      badgeNode.textContent = count > 99 ? '99+' : String(count);
      badgeNode.hidden = count === 0;
      renderNotificationList();
    } catch {
      /* notification polling is best-effort */
    }
  }
  KRY.refreshNotifications = refreshNotifications;

  function setBadge(id, count) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = count > 99 ? '99+' : String(count);
    node.hidden = !count;
  }

  async function refreshBadges() {
    if (!state.user) return;
    try {
      const [counts, queues] = await Promise.all([
        api('/badges'),
        api('/queues/summary').catch(() => null),
      ]);
      setBadge('navMyDayBadge', counts.myDay);
      setBadge('navWorkBadge', queues?.myWork ? queues.myWork.total : counts.myWork);
      setBadge('navCallsBadge', queues?.calling !== undefined ? queues.calling : counts.calls);
      setBadge('navActionBadge', counts.actionRequired);
    } catch {
      /* badges are best-effort */
    }
  }
  KRY.refreshBadges = refreshBadges;

  function renderNotificationList() {
    const list = document.getElementById('notifyList');
    clear(list);
    if (!state.notifications.length) {
      list.appendChild(emptyState(t('notify.empty'), t('notify.emptyHelp')));
      return;
    }
    state.notifications.forEach((item) => {
      list.appendChild(
        el(
          'button',
          {
            class: `notify-item ${item.read_at ? '' : 'unread'}`,
            type: 'button',
            onClick: async () => {
              try {
                if (!item.read_at) await api(`/notifications/${item.id}/read`, { method: 'PATCH' });
              } catch {
                /* ignore */
              }
              document.getElementById('notifyPanel').hidden = true;
              state.notifyOpen = false;
              if (item.link) {
                const target = String(item.link).replace(/^#\/?/, '').split('/')[0];
                navigate(target || 'overview');
              }
              if (item.entity_type === 'lead' && item.entity_id) {
                setTimeout(() => {
                  if (typeof KRY.openLeadModal === 'function') KRY.openLeadModal(item.entity_id);
                }, 200);
              } else if (item.entity_type === 'task' && item.entity_id) {
                setTimeout(() => {
                  if (typeof KRY.openTaskModal === 'function') KRY.openTaskModal(item.entity_id);
                }, 200);
              }
              refreshNotifications();
            },
          },
          el('span', { class: 'notify-message', text: item.message }),
          el('span', { class: 'notify-time', text: timeAgo(item.created_at) }),
        ),
      );
    });
  }

  /* --------------------------------------------------------------- Navigation */

  function navigate(page) {
    const target = `#/${page}`;
    if (location.hash === target) renderRoute();
    else location.hash = target;
  }
  KRY.navigate = navigate;

  function currentPage() {
    const raw = location.hash.replace(/^#\/?/, '').split('/')[0];
    return raw || 'overview';
  }

  async function renderRoute() {
    if (!state.user) return;
    let page = currentPage();
    if (!KRY.pages[page]) page = 'overview';
    const guard = ROLE_PAGE_GUARD[page];
    if (guard && !guard()) page = 'overview';

    state.page = page;
    const meta = PAGE_META[page] || PAGE_META.overview;
    const title = t(meta.titleKey);
    document.getElementById('pageTitle').textContent = title;
    document.getElementById('pageEyebrow').textContent = t(meta.eyebrowKey);
    document.title = `${title} · ${t('app.brand')}`;
    document.querySelectorAll('#nav .nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.page === page);
    });
    document.getElementById('sidebar').classList.remove('open');

    const view = document.getElementById('view');
    clear(view);
    view.appendChild(el('div', { class: 'loading-block', text: t('common.loading') }));

    try {
      const node = await KRY.pages[page]();
      clear(view);
      view.appendChild(node || emptyState(t('common.nothingHere'), t('myday.allClearCopy')));
      view.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      refreshBadges();
    } catch (err) {
      clear(view);
      view.appendChild(
        card(
          t('error.loadScreen'),
          null,
          el(
            'div',
            { class: 'stack' },
            el('p', { class: 'form-error', text: err.message }),
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: t('common.retry'),
              onClick: () => renderRoute(),
            }),
          ),
        ),
      );
    }
  }
  KRY.renderRoute = renderRoute;

  function registerPage(name, renderer) {
    KRY.pages[name] = renderer;
  }
  KRY.registerPage = registerPage;

  /* ----------------------------------------------------------- Media helpers */

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Downscale a photo in the browser so a site phone photo stays under the
   * server's 2 MB limit. Falls back to the original bytes when canvas is not
   * available (for example a very old browser).
   */
  function compressImage(file, maxDimension = 1400, quality = 0.72) {
    return new Promise((resolve) => {
      if (!String(file.type).startsWith('image/')) {
        resolve(null);
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
          const width = Math.max(1, Math.round(image.width * scale));
          const height = Math.max(1, Math.round(image.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          URL.revokeObjectURL(url);
          resolve({
            dataUrl,
            name: String(file.name || 'site-photo').replace(/\.[^.]+$/, '') + '.jpg',
            mime: 'image/jpeg',
            bytes: Math.round((dataUrl.length * 3) / 4),
          });
        } catch {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    });
  }

  async function fileToAttachment(file, caption = '') {
    if (String(file.type).startsWith('image/')) {
      const compressed = await compressImage(file);
      if (compressed) {
        return { ...compressed, caption };
      }
    }
    const dataUrl = await fileToDataUrl(file);
    return {
      dataUrl,
      name: file.name || 'attachment',
      mime: file.type || 'application/octet-stream',
      bytes: file.size,
      caption,
    };
  }

  async function uploadAttachment({ entityType, entityId, attachment }) {
    return api('/attachments', {
      method: 'POST',
      body: {
        entity_type: entityType,
        entity_id: String(entityId),
        file_name: attachment.name,
        mime_type: attachment.mime,
        caption: attachment.caption || '',
        data: attachment.dataUrl,
      },
    });
  }

  async function uploadAttachments({ entityType, entityId, attachments }) {
    const uploaded = [];
    for (const attachment of attachments) {
      // Sequential on purpose: each request stays small and progress is simple.
      uploaded.push(await uploadAttachment({ entityType, entityId, attachment }));
    }
    return uploaded;
  }

  function loadAttachments({ leadId, entityType, entityId }) {
    const query = leadId
      ? `?lead_id=${encodeURIComponent(leadId)}`
      : `?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`;
    return api(`/attachments${query}`);
  }

  async function mediaUrl(path) {
    const response = await fetch(`/api${path}`, {
      headers: state.token ? { authorization: `Bearer ${state.token}` } : {},
    });
    if (!response.ok) throw new Error('Could not load the file.');
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Renders photos and voice notes. Media is fetched with the session token and
   * shown from a local blob URL, so the files are never public.
   */
  function attachmentGallery(files, { compact = false } = {}) {
    if (!files || !files.length) return emptyState(t('common.noFiles'), '');
    const grid = el('div', { class: `attachment-grid${compact ? ' compact' : ''}` });
    files.forEach((file) => {
      const tile = el(
        'figure',
        { class: 'attachment' },
        el(
          'div',
          { class: 'attachment-stage' },
          el('span', { class: 'attachment-loading', text: '…' }),
        ),
        el(
          'figcaption',
          {},
          el('strong', { text: file.file_name }),
          file.caption ? el('small', { text: file.caption }) : null,
        ),
      );
      const stage = tile.querySelector('.attachment-stage');
      mediaUrl(file.url)
        .then((url) => {
          clear(stage);
          if (file.is_image) {
            stage.appendChild(
              el('img', { src: url, alt: file.caption || file.file_name, loading: 'lazy' }),
            );
          } else if (file.is_audio) {
            stage.appendChild(el('audio', { src: url, controls: true, preload: 'metadata' }));
          } else {
            stage.appendChild(
              el('a', { href: url, target: '_blank', rel: 'noopener', text: file.file_name }),
            );
          }
        })
        .catch(() => {
          clear(stage);
          stage.appendChild(el('span', { class: 'small muted', text: '—' }));
        });
      grid.appendChild(tile);
    });
    return grid;
  }

  Object.assign(KRY, {
    fileToDataUrl,
    compressImage,
    fileToAttachment,
    uploadAttachment,
    uploadAttachments,
    loadAttachments,
    mediaUrl,
    attachmentGallery,
  });

  /* ----------------------------------------------------------- Day actions */

  const ACTION_LABEL_KEYS = {
    log_call: 'action.logCall',
    submit_report: 'action.submitReport',
    submit_site_report: 'action.submitSiteReport',
    submit_drawing: 'action.submitDrawing',
    review_submission: 'action.reviewSubmission',
    route_lead: 'action.routeLead',
    assign_telecaller: 'action.assignTelecaller',
    prepare_quotation: 'action.prepareQuotation',
    send_quotation: 'action.sendQuotation',
    approve_quotation: 'action.approveQuotation',
    follow_up_quote: 'action.callCustomer',
    create_work_order: 'action.createWorkOrder',
    approve_work_order: 'action.approveWorkOrder',
    report_progress: 'action.reportProgress',
    open_task: 'action.openTask',
    open_quote: 'action.openQuote',
  };

  function actionLabel(action) {
    return t(ACTION_LABEL_KEYS[action] || 'action.openTask');
  }

  function telHref(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    return `tel:${digits.length === 10 ? `+91${digits}` : digits}`;
  }

  function toLeadLike(item) {
    return {
      id: item.lead_id || item.id,
      task_id: item.lead_id ? item.id : item.task_id || null,
      customer_name: item.customer_name,
      phone: item.phone,
      stage: item.stage,
      requirement: item.requirement,
      budget_range: item.budget_range,
      location: item.location,
      priority: item.priority,
      source: item.source,
    };
  }

  function toTaskLike(item) {
    return {
      id: item.id,
      lead_id: item.lead_id,
      customer_name: item.customer_name,
      customer_phone: item.phone,
      phone: item.phone,
      department: item.department,
      task_type: item.task_type,
      status: item.status,
      lead_stage: item.stage,
      brief: item.brief,
      due_date: item.due_date,
    };
  }

  async function runAction(item) {
    if (!item) return;
    switch (item.action) {
      case 'log_call':
        if (typeof KRY.openTelecallerForm === 'function') KRY.openTelecallerForm(toLeadLike(item));
        else if (item.lead_id) KRY.openLeadModal(item.lead_id);
        return;
      case 'submit_report':
        if (typeof KRY.openTaskSubmission === 'function') KRY.openTaskSubmission(toTaskLike(item));
        return;
      case 'submit_site_report':
        if (typeof KRY.openSiteInspection === 'function') KRY.openSiteInspection(toTaskLike(item));
        return;
      case 'submit_drawing':
        if (typeof KRY.openDesignSubmission === 'function')
          KRY.openDesignSubmission(toTaskLike(item));
        return;
      case 'review_submission':
        if (typeof KRY.openTaskReview === 'function') KRY.openTaskReview(toTaskLike(item));
        return;
      case 'route_lead':
        if (typeof KRY.openRouteWizard === 'function') KRY.openRouteWizard(toLeadLike(item));
        return;
      case 'assign_telecaller':
        if (typeof KRY.openAssignTelecaller === 'function')
          KRY.openAssignTelecaller(toLeadLike(item));
        return;
      case 'prepare_quotation':
        if (typeof KRY.openQuotationWizard === 'function')
          KRY.openQuotationWizard({ lead: toLeadLike(item) });
        return;
      case 'send_quotation':
        if (typeof KRY.openQuoteDecision === 'function') KRY.openQuoteDecision(item, 'Sent');
        return;
      case 'approve_quotation':
        if (typeof KRY.openQuoteDecision === 'function') KRY.openQuoteDecision(item);
        return;
      case 'follow_up_quote':
        if (item.lead_id) KRY.openLeadModal(item.lead_id);
        return;
      case 'create_work_order':
        if (typeof KRY.openWorkOrderWizard === 'function')
          KRY.openWorkOrderWizard({ lead: toLeadLike(item) });
        return;
      case 'approve_work_order':
        if (typeof KRY.openWorkOrderApproval === 'function') KRY.openWorkOrderApproval(item);
        return;
      case 'report_progress':
        if (typeof KRY.openProjectProgress === 'function') KRY.openProjectProgress(item.id);
        return;
      case 'open_quote':
        if (typeof KRY.openQuotationModal === 'function') KRY.openQuotationModal(item.id);
        return;
      case 'open_task':
      default:
        if (item.kind === 'project' && typeof KRY.openProjectModal === 'function') {
          KRY.openProjectModal(item.id);
        } else if (item.kind === 'quotation' && typeof KRY.openQuotationModal === 'function') {
          KRY.openQuotationModal(item.id);
        } else if (item.kind === 'lead' && item.lead_id) {
          KRY.openLeadModal(item.lead_id);
        } else if (item.id) {
          KRY.openTaskModal(item.id);
        }
    }
  }

  function toTitleCase(str) {
    if (!str) return '—';
    return String(str)
      .toLowerCase()
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function formatRelativeTime(createdDate, dueDate) {
    const now = new Date();
    if (dueDate) {
      const due = new Date(dueDate);
      const diffMs = due.getTime() - now.getTime();
      const diffHours = Math.round(diffMs / (1000 * 60 * 60));
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffMs < 0) {
        const overdueDays = Math.abs(diffDays);
        return overdueDays <= 1 ? 'Overdue by 1 day' : `Overdue by ${overdueDays} days`;
      }
      if (diffHours <= 24 && diffHours > 0) {
        return `Due in ${diffHours} hour${diffHours === 1 ? '' : 's'}`;
      }
      if (diffDays === 0) return 'Due today';
      if (diffDays === 1) return 'Due tomorrow';
      return `Due in ${diffDays} days`;
    }
    if (createdDate) {
      const created = new Date(createdDate);
      const diffDays = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return 'Assigned today';
      if (diffDays === 1) return 'Waiting 1 day';
      return `Waiting ${diffDays} days`;
    }
    return 'Active';
  }

  Object.assign(KRY, {
    actionLabel,
    telHref,
    toTitleCase,
    formatRelativeTime,
    toLeadLike,
    toTaskLike,
    runAction,
    ACTION_LABEL_KEYS,
  });
})();
