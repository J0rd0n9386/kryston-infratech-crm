/**
 * My Day, the Admin Action Required queue, the Lead Board, the Customer List
 * and the customer workspace, plus the guided "new lead" and "send to a team"
 * flows.
 */
'use strict';

(function () {
  const KRY = window.KRY;
  const {
    el,
    icon,
    api,
    pageHead,
    sectionHeader,
    card,
    statCard,
    clear,
    emptyState,
    kv,
    dataTable,
    timeline,
    progressBar,
    toolbar,
    searchInput,
    stageBadge,
    statusBadge,
    priorityBadge,
    badge,
    dueBadge,
    dueLabel,
    dueTone,
    money,
    fmtDate,
    fmtDateTime,
    timeAgo,
    titleCase,
    toast,
    openModal,
    openFormModal,
    openWizard,
    confirmAction,
    closeModal,
    getEmployees,
    optionsFor,
    isCentral,
    isSales,
    isSalesManager,
    registerPage,
    navigate,
    choiceCards,
    chipRow,
    moreDetails,
    field,
    listRow,
  } = KRY;
  const t = (key, vars) => KRY.t(key, vars);

  const DEPT_CONFIG = {
    Sales: {
      roles: ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'],
      taskTypes: ['SALES_REVIEW', 'QUOTATION_PROPOSAL'],
    },
    Technical: { roles: ['SITE_ENGINEER'], taskTypes: ['SITE_VISIT', 'SITE_INSPECTION'] },
    Design: { roles: ['ARCHITECT'], taskTypes: ['DESIGN_PREPARATION'] },
    Purchase: { roles: ['PURCHASE'], taskTypes: ['MATERIAL_CHECK'] },
    Accounts: { roles: ['ACCOUNTS'], taskTypes: ['COSTING_ESTIMATE'] },
  };

  function greetingKey() {
    const hour = new Date().getHours();
    if (hour < 12) return 'myday.greeting.morning';
    if (hour < 17) return 'myday.greeting.afternoon';
    return 'myday.greeting.evening';
  }

  function truncate(value, max = 160) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function valueOf(root, name) {
    const node = root.querySelector(`[name="${name}"]`);
    if (!node) return '';
    return node.type === 'checkbox' ? Boolean(node.checked) : (node.value ?? '');
  }

  function labeled(text, input, hint) {
    return el(
      'label',
      { class: 'field' },
      el('span', { text }),
      input,
      hint ? el('small', { text: hint }) : null,
    );
  }

  function actionButton(label, iconName, onClick, cls = '') {
    return el(
      'button',
      { class: `btn ${cls}`.trim(), type: 'button', onClick },
      icon(iconName),
      label,
    );
  }

  const ACTION_ICONS = {
    log_call: 'phone',
    submit_report: 'check',
    submit_site_report: 'home',
    submit_drawing: 'doc',
    review_submission: 'shield',
    route_lead: 'board',
    assign_telecaller: 'phone',
    prepare_quotation: 'rupee',
    send_quotation: 'rupee',
    follow_up_quote: 'phone',
    approve_quotation: 'check',
    create_work_order: 'doc',
    approve_work_order: 'check',
    report_progress: 'folder',
    open_task: 'check',
  };

  function actionIcon(action) {
    return ACTION_ICONS[action] || 'check';
  }

  function callLink(phone, label, cls = 'btn btn-sm') {
    const href = KRY.telHref(phone);
    if (!href) return null;
    return el('a', { class: cls, href }, icon('phone'), label || t('action.callCustomer'));
  }

  function stop(event) {
    event.stopPropagation();
  }

  /* ------------------------------------------------------------------ My Day */

  function dayChip(label, value, tone = '') {
    return el(
      'span',
      { class: `day-chip ${tone}`.trim() },
      el('strong', { text: String(value) }),
      el('span', { text: label }),
    );
  }

  function hero(day) {
    const central = day.scope === 'central';
    const firstName = String((KRY.state.user && KRY.state.user.name) || '').split(' ')[0];
    const dateText = new Date().toLocaleDateString(KRY.dateLocale(), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    const summary = day.summary;
    const lineParts = [];
    if (summary.totalToday > 0) {
      lineParts.push(
        KRY.tp(summary.totalToday, 'myday.summary.todayOne', 'myday.summary.todayMany', {
          count: summary.totalToday,
        }),
      );
    }
    if (summary.late > 0) {
      lineParts.push(
        KRY.tp(summary.late, 'myday.summary.lateOne', 'myday.summary.lateMany', {
          count: summary.late,
        }),
      );
    } else {
      lineParts.push(t('myday.summary.clear'));
    }

    const actions = el('div', { class: 'day-hero-actions' });
    if (central) {
      actions.appendChild(
        actionButton(t('myday.newLead'), 'plus', () => KRY.openNewLead(), 'btn-primary'),
      );
    }
    actions.appendChild(
      actionButton(
        t('myday.viewWork'),
        'check',
        () => navigate('tasks'),
        central ? '' : 'btn-primary',
      ),
    );

    const chips = el(
      'div',
      { class: 'day-chips' },
      dayChip(t('myday.chip.today'), summary.totalToday, summary.totalToday ? 'brand' : ''),
      dayChip(t('myday.chip.late'), summary.late, summary.late ? 'danger' : 'good'),
      dayChip(t('myday.chip.waiting'), summary.waiting, summary.waiting ? 'info' : ''),
      dayChip(t('myday.chip.done'), summary.doneSinceYesterday, 'good'),
    );

    return el(
      'section',
      { class: 'day-hero' },
      el(
        'div',
        { class: 'day-hero-copy' },
        el('p', { class: 'eyebrow', text: dateText }),
        el('h2', { class: 'day-hello', text: `${t(greetingKey())}, ${firstName}` }),
        el('p', { class: 'day-line', text: lineParts.join(' · ') }),
        chips,
        central && summary.actionRequired
          ? el(
              'button',
              {
                class: 'day-alert-chip',
                type: 'button',
                onClick: () => navigate('actionqueue'),
              },
              icon('alert'),
              t('myday.openActions', { count: summary.actionRequired }),
            )
          : null,
      ),
      actions,
    );
  }

  function queueMeta(item) {
    const parts = [];
    if (item.kind === 'lead') {
      parts.push(KRY.stageLabel(item.stage));
      if (item.source) parts.push(item.source);
      if (item.telecaller_name) parts.push(`${t('lead.telecaller')}: ${item.telecaller_name}`);
    } else if (item.kind === 'task') {
      parts.push(KRY.taskTypeLabel(item.task_type));
      parts.push(KRY.deptLabel(item.department));
      if (item.assignee_name) parts.push(item.assignee_name);
    } else if (item.kind === 'work_order') {
      parts.push(money(item.amount));
      if (item.creator_name) parts.push(item.creator_name);
    } else if (item.kind === 'quotation') {
      parts.push(t('myday.quoteTag', { version: item.version }));
      parts.push(money(item.total_amount || item.amount));
    }
    return parts.filter(Boolean).join(' · ');
  }

  function queueRow(item) {
    const actions = el('div', { class: 'queue-actions' });
    const call = callLink(item.phone);
    if (call) actions.appendChild(call);
    actions.appendChild(
      el(
        'button',
        {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          onClick: (event) => {
            stop(event);
            KRY.runAction(item);
          },
        },
        icon(actionIcon(item.action)),
        KRY.actionLabel(item.action),
      ),
    );

    return el(
      'div',
      { class: 'queue-row' },
      el(
        'div',
        { class: 'queue-main' },
        el(
          'div',
          { class: 'queue-title' },
          el('strong', { text: item.customer_name || item.id }),
          dueBadge(item),
        ),
        el('div', { class: 'queue-meta', text: queueMeta(item) }),
        item.location || item.requirement
          ? el('div', {
              class: 'queue-sub',
              text: truncate([item.requirement, item.location].filter(Boolean).join(' · '), 140),
            })
          : null,
      ),
      actions,
    );
  }

  function actionQueueCard(queue, limit) {
    const groups = queue.groups.filter((group) => group.count > 0);
    const body = el('div', { class: 'queue-groups' });
    groups.forEach((group) => {
      const items = group.items.slice(0, limit);
      body.appendChild(
        el(
          'div',
          { class: 'queue-group' },
          el(
            'div',
            { class: 'queue-group-head' },
            el('h3', { text: t(`queue.${group.key}`) }),
            badge(String(group.count), group.key === 'send' ? 'brand' : 'warn'),
          ),
          items.map((item) => queueRow(item)),
          group.count > items.length
            ? el(
                'button',
                { class: 'link-button', type: 'button', onClick: () => navigate('actionqueue') },
                `${t('common.viewAll')} (${group.count}) →`,
              )
            : null,
        ),
      );
    });

    return card(t('myday.actionTitle'), t('myday.actionCopy'), body, {
      actions: el(
        'button',
        { class: 'link-button', type: 'button', onClick: () => navigate('actionqueue') },
        `${t('common.openAll')} →`,
      ),
    });
  }

  function dayCard(item) {
    const tag =
      item.kind === 'task'
        ? `${KRY.taskTypeLabel(item.task_type)} · ${KRY.deptLabel(item.department)}`
        : item.kind === 'quotation'
          ? t('myday.quoteTag', { version: item.version })
          : item.kind === 'project'
            ? t('myday.projectTag')
            : KRY.stageLabel(item.stage);

    const actions = el('div', { class: 'day-actions' });
    if (item.kind === 'task' && item.action === 'log_call') {
      const primaryCall = callLink(item.phone, t('action.callCustomer'), 'btn btn-sm btn-primary');
      if (primaryCall) actions.appendChild(primaryCall);
      actions.appendChild(
        el(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            onClick: (event) => {
              stop(event);
              KRY.runAction(item);
            },
          },
          icon('check'),
          KRY.actionLabel(item.action),
        ),
      );
    } else if (item.action === 'follow_up_quote' && item.phone) {
      const primaryCall = callLink(item.phone, t('action.callCustomer'), 'btn btn-sm btn-primary');
      if (primaryCall) actions.appendChild(primaryCall);
      actions.appendChild(
        el(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            onClick: (event) => {
              stop(event);
              KRY.runAction({ ...item, action: 'open_quote' });
            },
          },
          icon('rupee'),
          t('action.openQuote'),
        ),
      );
    } else {
      actions.appendChild(
        el(
          'button',
          {
            class: 'btn btn-sm btn-primary',
            type: 'button',
            onClick: (event) => {
              stop(event);
              KRY.runAction(item);
            },
          },
          icon(actionIcon(item.action)),
          KRY.actionLabel(item.action),
        ),
      );
      const call = callLink(item.phone);
      if (call) actions.appendChild(call);
    }

    const metaParts = [];
    if (item.kind === 'task') {
      if (!item.mine && item.assignee_name)
        metaParts.push(`${t('common.assignedTo')}: ${item.assignee_name}`);
      else if (item.creator_name) metaParts.push(`${t('task.assignedBy')}: ${item.creator_name}`);
      if (item.due_date) metaParts.push(`${t('common.due')}: ${fmtDate(item.due_date)}`);
    } else if (item.kind === 'lead') {
      metaParts.push(KRY.stageLabel(item.stage));
      if (item.budget_range) metaParts.push(item.budget_range);
      if (item.waiting_days)
        metaParts.push(
          KRY.tp(item.waiting_days, 'due.pendingOne', 'due.pendingMany', {
            count: item.waiting_days,
          }),
        );
    } else if (item.kind === 'quotation') {
      metaParts.push(
        `${money(item.total_amount || item.amount)} · ${KRY.statusLabel(item.status)}`,
      );
      if (item.waiting_days)
        metaParts.push(
          KRY.tp(item.waiting_days, 'due.pendingOne', 'due.pendingMany', {
            count: item.waiting_days,
          }),
        );
    } else if (item.kind === 'project') {
      metaParts.push(`${Number(item.progress) || 0}% · ${KRY.statusLabel(item.status)}`);
      if (item.late_milestones)
        metaParts.push(t('sv.itemsFlagged', { count: item.late_milestones }));
      if (item.due_date) metaParts.push(`${t('projects.target')}: ${fmtDate(item.due_date)}`);
    }

    const subParts = [];
    if (item.location) subParts.push(item.location);
    if (item.kind !== 'quotation' && item.requirement)
      subParts.push(truncate(item.requirement, 110));

    const node = el(
      'article',
      { class: `day-card tone-${item.bucket}` },
      el(
        'div',
        { class: 'day-card-top' },
        el('span', { class: 'day-kind', text: tag }),
        dueBadge(item),
      ),
      el('h3', { class: 'day-title', text: item.customer_name || item.id }),
      subParts.length ? el('p', { class: 'day-sub', text: subParts.join(' · ') }) : null,
      metaParts.length ? el('div', { class: 'day-meta', text: metaParts.join(' · ') }) : null,
      actions,
    );

    node.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      if (item.lead_id) KRY.openLeadModal(item.lead_id);
      else KRY.runAction(item);
    });
    return node;
  }

  function dayGroup(key, title, copy, items, tone) {
    return el(
      'section',
      { class: `day-group group-${tone}` },
      el(
        'div',
        { class: 'day-group-head' },
        el('div', {}, el('h3', { text: title }), copy ? el('p', { text: copy }) : null),
        badge(
          String(items.length),
          tone === 'late' ? 'danger' : tone === 'today' ? 'brand' : 'neutral',
        ),
      ),
      el(
        'div',
        { class: 'day-cards' },
        items.map((item) => dayCard(item)),
      ),
    );
  }

  const ACTIVITY_ICONS = {
    CREATED: 'flag',
    ASSIGNED_TO_TELECALLER: 'phone',
    TELECALLER_RESPONSE: 'phone',
    ROUTED_TO_DEPT: 'board',
    DEPT_UPDATE: 'check',
    ADMIN_REVIEW: 'shield',
    QUOTATION: 'rupee',
    WORK_ORDER_SUBMITTED: 'doc',
    WORK_ORDER_FINALIZED: 'doc',
    WORK_ORDER: 'doc',
    PROJECT_HANDOFF: 'folder',
    STAGE_CHANGE: 'arrow',
    NOTE: 'doc',
    LOST: 'close',
    NURTURE: 'clock',
  };

  function activityText(entry) {
    const key = `activity.${entry.action_type}`;
    const text = t(key);
    return text === key ? KRY.titleCase(entry.action_type) : text;
  }

  function activityList(rows) {
    return el(
      'div',
      { class: 'list activity-list' },
      rows.map((entry) =>
        listRow({
          iconName: ACTIVITY_ICONS[entry.action_type] || 'clock',
          title: `${activityText(entry)} · ${entry.customer_name || entry.lead_id}`,
          meta: `${entry.from_name || '—'}${entry.to_name ? ` → ${entry.to_name}` : ''} · ${timeAgo(entry.created_at)}`,
          detail: entry.remarks ? truncate(entry.remarks, 130) : null,
          right: entry.new_stage ? stageBadge(entry.new_stage) : null,
        }),
      ),
    );
  }

  function activityCard(day) {
    const summary = day.activitySummary;
    const body = el('div', { class: 'stack' });
    body.appendChild(
      el(
        'div',
        { class: 'mini-stats' },
        el(
          'span',
          {},
          el('strong', { text: String(summary.newEnquiries) }),
          t('myday.activity.newEnquiries'),
        ),
        el(
          'span',
          {},
          el('strong', { text: String(summary.reportsReceived) }),
          t('myday.activity.reportsReceived'),
        ),
        el(
          'span',
          {},
          el('strong', { text: String(summary.quotations) }),
          t('myday.activity.quotations'),
        ),
        el(
          'span',
          {},
          el('strong', { text: String(summary.approvals) }),
          t('myday.activity.approvals'),
        ),
      ),
    );
    body.appendChild(
      day.recentActivity.length
        ? activityList(day.recentActivity)
        : emptyState(t('myday.activityEmpty'), ''),
    );
    return card(t('myday.activityTitle'), t('myday.activityCopy'), body);
  }

  function quickLinksCard(central) {
    const links = el(
      'div',
      { class: 'quick-links' },
      el(
        'button',
        { class: 'quick-link', type: 'button', onClick: () => navigate('tasks') },
        icon('check'),
        t('myday.sideAllWork'),
      ),
      el(
        'button',
        { class: 'quick-link', type: 'button', onClick: () => navigate('leads') },
        icon('users'),
        t('myday.sideCustomerList'),
      ),
      central
        ? el(
            'button',
            { class: 'quick-link', type: 'button', onClick: () => KRY.openNewLead() },
            icon('plus'),
            t('myday.sideNewLead'),
          )
        : null,
      central
        ? el(
            'button',
            { class: 'quick-link', type: 'button', onClick: () => navigate('actionqueue') },
            icon('alert'),
            t('nav.actionqueue'),
          )
        : null,
    );
    return card(t('myday.sideTitle'), null, links);
  }

  function allClearCard() {
    return card(
      null,
      null,
      el(
        'div',
        { class: 'all-clear' },
        el('span', { class: 'all-clear-icon' }, icon('spark')),
        el('h3', { text: t('myday.allClear') }),
        el('p', { text: t('myday.allClearCopy') }),
        actionButton(t('myday.viewWork'), 'check', () => navigate('tasks'), 'btn-primary'),
      ),
    );
  }

  /* -------------------------------------------------- Telecaller My Day View */
  function renderTelecallerMyDay(day) {
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Telecaller').split(' ')[0];
    const items = day.items || [];

    // Filter tasks into the 4 requested sections
    // Active tasks: status in ('Assigned', 'In Progress')
    // Finished tasks: status in ('Submitted', 'Reviewed', 'Closed') or stage = 'Response Received'
    const urgentOverdue = items.filter(
      (item) =>
        ['late', 'urgent'].includes(item.bucket) &&
        !['Submitted', 'Reviewed', 'Closed'].includes(item.status) &&
        item.stage !== 'Response Received',
    );

    const dueToday = items.filter(
      (item) =>
        ['today', 'upcoming'].includes(item.bucket) &&
        !['Submitted', 'Reviewed', 'Closed'].includes(item.status) &&
        item.stage !== 'Response Received',
    );

    const finished = items.filter(
      (item) =>
        ['Submitted', 'Reviewed', 'Closed'].includes(item.status) ||
        item.stage === 'Response Received' ||
        item.bucket === 'waiting',
    );

    const activeCount = urgentOverdue.length + dueToday.length;
    const finishedCount = finished.length;

    const wrap = el('div', { class: 'stack telecaller-myday' });

    // HEADER: Good afternoon, Telecaller. [Stats: X Active, Y Finished]
    const header = el(
      'div',
      { class: 'telecaller-day-header' },
      el(
        'div',
        {},
        el('h2', { text: `Good day, ${firstName}` }),
        el('p', { text: 'Your customer calling schedule and qualification pipeline' }),
      ),
      el(
        'div',
        { class: 'telecaller-stats-row' },
        el(
          'span',
          { class: 'telecaller-stat-pill active-pill' },
          icon('phone'),
          el('strong', { text: String(activeCount) }),
          'Active Calls',
        ),
        el(
          'span',
          { class: 'telecaller-stat-pill finished-pill' },
          icon('check'),
          el('strong', { text: String(finishedCount) }),
          'Finished / Submitted',
        ),
      ),
    );
    wrap.appendChild(header);

    function telecallerCard(item, isFinished = false) {
      const phone = item.customer_phone || item.phone || '';
      const name = item.customer_name || item.id;
      const href = KRY.telHref(phone);

      const cardNode = el(
        'div',
        { class: `telecaller-task-card ${isFinished ? 'finished-card' : ''}` },
        el(
          'div',
          {},
          el(
            'div',
            { class: 'telecaller-card-top' },
            el('h4', { class: 'telecaller-card-title', text: KRY.toTitleCase(name) }),
            isFinished
              ? el(
                  'span',
                  { class: 'waiting-admin-badge' },
                  icon('shield'),
                  'Waiting for Admin Review',
                )
              : dueBadge(item),
          ),
          phone
            ? el(
                'div',
                { class: 'telecaller-card-phone' },
                icon('phone'),
                el('span', { text: phone }),
                href && !isFinished
                  ? el('a', { class: 'btn btn-xs', href, style: 'margin-left: 8px;' }, 'Call')
                  : null,
              )
            : null,
          item.location || item.requirement
            ? el('div', {
                class: 'telecaller-card-meta',
                text: [item.requirement, item.location].filter(Boolean).join(' · '),
              })
            : null,
        ),
        !isFinished
          ? el(
              'div',
              { class: 'telecaller-card-actions' },
              el(
                'button',
                {
                  class: 'btn btn-sm btn-primary',
                  type: 'button',
                  onClick: (e) => {
                    stop(e);
                    KRY.openLogCallModal(item);
                  },
                },
                icon('phone'),
                'Log Call',
              ),
            )
          : null,
      );

      cardNode.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        if (item.lead_id) KRY.openLeadModal(item.lead_id);
      });

      return cardNode;
    }

    // SECTION 1: ⚠️ URGENT & OVERDUE (Red border/accents)
    if (urgentOverdue.length) {
      wrap.appendChild(
        el(
          'section',
          { class: 'lane-section lane-urgent' },
          el(
            'div',
            { class: 'lane-head' },
            el('h3', {}, icon('alert'), `⚠️ URGENT & OVERDUE (${urgentOverdue.length})`),
            badge(`${urgentOverdue.length} Action Needed`, 'danger'),
          ),
          el(
            'div',
            { class: 'lane-grid' },
            urgentOverdue.map((item) => telecallerCard(item, false)),
          ),
        ),
      );
    }

    // SECTION 2: 📅 DUE TODAY (Amber accents)
    wrap.appendChild(
      el(
        'section',
        { class: 'lane-section lane-today' },
        el(
          'div',
          { class: 'lane-head' },
          el('h3', {}, icon('clock'), `📅 DUE TODAY (${dueToday.length})`),
          badge(`${dueToday.length} Calls`, 'brand'),
        ),
        dueToday.length
          ? el(
              'div',
              { class: 'lane-grid' },
              dueToday.map((item) => telecallerCard(item, false)),
            )
          : emptyState(
              'No more calls due today',
              'All scheduled calls for today have been completed.',
            ),
      ),
    );

    // SECTION 3: ✅ FINISHED / SENT TO ADMIN (Read-only, muted colors)
    wrap.appendChild(
      el(
        'section',
        { class: 'lane-section lane-finished' },
        el(
          'div',
          { class: 'lane-head' },
          el('h3', {}, icon('check'), `✅ FINISHED / SENT TO ADMIN (${finished.length})`),
          badge(`${finished.length} Submitted`, 'neutral'),
        ),
        finished.length
          ? el(
              'div',
              { class: 'lane-grid' },
              finished.map((item) => telecallerCard(item, true)),
            )
          : emptyState(
              'No finished tasks yet',
              'Logged calls and submitted enquiries will appear here awaiting admin review.',
            ),
      ),
    );

    // SECTION 4: 📋 RECENT ACTIVITY (Vertical timeline)
    const recentActivityRows = day.recentActivity || [];
    wrap.appendChild(
      el(
        'section',
        { class: 'lane-section' },
        el('div', { class: 'lane-head' }, el('h3', {}, icon('spark'), '📋 RECENT ACTIVITY')),
        recentActivityRows.length
          ? timeline(recentActivityRows)
          : emptyState(t('myday.activityEmpty'), ''),
      ),
    );

    return wrap;
  }

  /* -------------------------------------------------- Charts & Visualization Helpers */
  function createSvgDonut(segments, onSelect) {
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
    const wrap = el('div', { class: 'donut-wrap' });
    const radius = 50;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'donut-svg');
    svg.setAttribute('viewBox', '0 0 140 140');

    // Background track
    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', '70');
    bgCircle.setAttribute('cy', '70');
    bgCircle.setAttribute('r', String(radius));
    bgCircle.setAttribute('fill', 'transparent');
    bgCircle.setAttribute('stroke', '#f1f5f9');
    bgCircle.setAttribute('stroke-width', '18');
    svg.appendChild(bgCircle);

    segments.forEach((seg) => {
      const pct = total > 0 ? seg.value / total : 0;
      const dash = pct * circumference;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'donut-slice');
      circle.setAttribute('cx', '70');
      circle.setAttribute('cy', '70');
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', 'transparent');
      circle.setAttribute('stroke', seg.color);
      circle.setAttribute('stroke-width', '18');
      circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
      circle.setAttribute('stroke-dashoffset', String(-offset));
      if (typeof onSelect === 'function') {
        circle.addEventListener('click', () => onSelect(seg.label));
      }
      svg.appendChild(circle);
      offset += dash;
    });

    const legend = el('div', { class: 'donut-legend' });
    segments.forEach((seg) => {
      const pctStr = total > 0 ? `${Math.round((seg.value / total) * 100)}%` : '0%';
      const item = el(
        'div',
        {
          class: 'donut-legend-item',
          onClick: () => {
            if (typeof onSelect === 'function') onSelect(seg.label);
          },
        },
        el(
          'div',
          { class: 'donut-legend-label' },
          el('span', { class: 'donut-color-dot', style: `background:${seg.color}` }),
          el('span', { text: seg.label }),
        ),
        el('strong', { class: 'metric-mono', text: `${seg.value} (${pctStr})` }),
      );
      legend.appendChild(item);
    });

    wrap.appendChild(svg);
    wrap.appendChild(legend);
    return wrap;
  }

  function createSvgFunnel(steps) {
    const maxVal = Math.max(1, ...steps.map((s) => s.count));
    const container = el('div', { class: 'funnel-container' });
    steps.forEach((step) => {
      const widthPct = Math.max(8, Math.round((step.count / maxVal) * 100));
      const stepEl = el(
        'div',
        { class: 'funnel-step' },
        el(
          'div',
          { class: 'funnel-step-head' },
          el('span', { text: step.label }),
          el('strong', { class: 'metric-mono', text: String(step.count) }),
        ),
        el(
          'div',
          { class: 'funnel-bar-bg' },
          el('div', {
            class: 'funnel-bar-fill',
            style: `width:${widthPct}%; ${step.color ? `background:${step.color};` : ''}`,
            text: `${step.count}`,
          }),
        ),
      );
      container.appendChild(stepEl);
    });
    return container;
  }

  /* ------------------------------------------- Admin Mission Control */
  async function renderAdminMissionControl(day) {
    return renderProfessionalOverview(day);
  }

  /* ------------------------------------------- Split-Pane Triage Inbox */
  async function renderTriageInbox() {
    let leads = [];
    let day = { actionQueue: { groups: [] } };
    try {
      [leads, day] = await Promise.all([api('/leads?limit=300'), api('/my-day')]);
    } catch {
      leads = [];
    }

    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(
      pageHead(
        'Triage Inbox',
        'Zero-friction dual pane orchestrator. Review incoming customer responses and route tasks to spokes.',
        [
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => KRY.openNewLead() },
            icon('plus'),
            'New Lead',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('taskboard') },
            icon('board'),
            'Global Pipeline',
          ),
        ],
      ),
    );

    let activeFilter = 'NEEDS_ACTION'; // NEEDS_ACTION, WAITING, ALL
    let selectedLead = null;

    const listContainer = el('div', { class: 'triage-queue-list' });
    const rightPane = el('div', { class: 'triage-right' });

    function getFilteredLeads() {
      return leads.filter((l) => {
        if (activeFilter === 'NEEDS_ACTION') {
          return ['New', 'Response Received', 'Update Received'].includes(l.stage);
        }
        if (activeFilter === 'WAITING') {
          return [
            'With Telecaller',
            'Routed to Sales',
            'Routed to Engineering',
            'Routed to Design',
            'Routed to Purchase',
            'Routed to Accounts',
          ].includes(l.stage);
        }
        return true;
      });
    }

    function renderRightPane(lead) {
      clear(rightPane);
      if (!lead) {
        rightPane.appendChild(
          emptyState(
            'All caught up!',
            'Select a lead from the queue on the left to inspect context and dispatch.',
          ),
        );
        return;
      }

      // Contextual Lead 360 View
      const header = el(
        'div',
        { class: 'lead-360-header' },
        el(
          'div',
          {},
          el('h2', {
            style: 'margin:0 0 4px 0; font-size:18px;',
            text: lead.customer_name || 'Customer Profile',
          }),
          el('span', {
            class: 'text-muted text-sm',
            text: `${lead.id} · Captured: ${fmtDate(lead.created_at)}`,
          }),
        ),
        stageBadge(lead.stage),
      );

      const grid = el(
        'div',
        { class: 'lead-360-grid' },
        el(
          'div',
          { class: 'lead-360-stat' },
          el('small', { text: 'Phone Number' }),
          el(
            'strong',
            {},
            lead.phone ? el('a', { href: KRY.telHref(lead.phone), text: lead.phone }) : '—',
          ),
        ),
        el(
          'div',
          { class: 'lead-360-stat' },
          el('small', { text: 'Ad Source' }),
          el('strong', { text: lead.source || 'Website / Direct' }),
        ),
        el(
          'div',
          { class: 'lead-360-stat' },
          el('small', { text: 'Customer Budget' }),
          el('strong', { text: lead.budget_range || '₹10 - 20 Lakhs' }),
        ),
        el(
          'div',
          { class: 'lead-360-stat' },
          el('small', { text: 'Site Location' }),
          el('strong', { text: lead.location || 'Gurugram' }),
        ),
      );

      const notesBox = el(
        'div',
        { class: 'lead-notes-box' },
        el('h4', {}, icon('phone'), 'Telecaller Qualification & Customer Response'),
        el('p', {
          class: 'text-sm',
          text:
            lead.requirement ||
            'Customer requested consultation for full turnkey interior design and marble flooring.',
        }),
      );

      const timelinePreview = el(
        'div',
        { class: 'stack gap-xs' },
        el('h4', {
          style: 'font-size:13px; font-weight:600; margin:0;',
          text: 'Lead Journey Timeline',
        }),
        el(
          'div',
          { class: 'small text-muted' },
          `• Inquiry captured via ${lead.source || 'Website'}`,
        ),
        el('div', { class: 'small text-muted' }, `• Telecaller qualification completed`),
        el('div', { class: 'small text-muted' }, `• Awaiting department assignment by Admin Desk`),
      );

      const body = el('div', { class: 'lead-360-body' }, grid, notesBox, timelinePreview);

      // Floating Action Bar at Bottom
      const actionBar = el(
        'div',
        { class: 'triage-action-bar' },
        el(
          'div',
          { class: 'row gap-sm align-center' },
          el(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => KRY.openSmartRoutingModal(lead),
            },
            icon('board'),
            'Route to Dept →',
          ),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              onClick: () => KRY.openAssignTelecaller(lead),
            },
            icon('phone'),
            'Assign Telecaller',
          ),
        ),
        el(
          'div',
          { class: 'row gap-sm align-center' },
          el(
            'button',
            {
              class: 'btn btn-ghost danger',
              type: 'button',
              onClick: () => {
                confirmAction('Mark this lead as Lost?', () => {
                  api(`/leads/${lead.id}/lost`, {
                    method: 'POST',
                    body: { reason: 'Unqualified / Customer not interested' },
                  }).then(() => {
                    toast(`Lead ${lead.id} marked as Lost.`, 'info');
                    renderTriage();
                  });
                });
              },
            },
            'Mark as Lost',
          ),
        ),
      );

      rightPane.appendChild(header);
      rightPane.appendChild(body);
      rightPane.appendChild(actionBar);
    }

    function renderTriage() {
      clear(listContainer);
      const filtered = getFilteredLeads();

      if (!filtered.length) {
        listContainer.appendChild(
          emptyState('All caught up!', 'No leads matching this filter in your triage queue.'),
        );
        renderRightPane(null);
        return;
      }

      if (!selectedLead || !filtered.some((l) => l.id === selectedLead.id)) {
        selectedLead = filtered[0];
      }

      filtered.forEach((lead) => {
        const isNeedsAction = ['New', 'Response Received', 'Update Received'].includes(lead.stage);
        const isWaiting = [
          'With Telecaller',
          'Routed to Sales',
          'Routed to Engineering',
          'Routed to Design',
          'Routed to Purchase',
          'Routed to Accounts',
        ].includes(lead.stage);
        const dotClass = isNeedsAction
          ? 'status-dot-action'
          : isWaiting
            ? 'status-dot-waiting'
            : 'status-dot-done';
        const isSelected = selectedLead && selectedLead.id === lead.id;

        const row = el(
          'div',
          {
            class: `triage-row ${isSelected ? 'selected' : ''}`,
            onClick: () => {
              selectedLead = lead;
              renderTriage();
            },
          },
          el('span', { class: `triage-status-dot ${dotClass}` }),
          el(
            'div',
            { class: 'triage-row-main' },
            el(
              'div',
              { class: 'triage-row-header' },
              el('span', { class: 'triage-row-name', text: lead.customer_name || lead.id }),
              el('span', { class: 'triage-row-time', text: timeAgo(lead.created_at) }),
            ),
            el('div', {
              class: 'triage-row-meta',
              text: `${lead.id} · ${KRY.stageLabel(lead.stage)}`,
            }),
            el('div', {
              class: 'triage-row-preview',
              text: lead.requirement || 'Customer enquiry waiting for dispatch',
            }),
          ),
        );
        listContainer.appendChild(row);
      });

      renderRightPane(selectedLead);
    }

    const tabsBar = el(
      'div',
      { class: 'triage-tabs-bar' },
      el('button', {
        class: `triage-tab-btn ${activeFilter === 'NEEDS_ACTION' ? 'active' : ''}`,
        type: 'button',
        text: 'Needs My Action',
        onClick: () => {
          activeFilter = 'NEEDS_ACTION';
          renderTriage();
        },
      }),
      el('button', {
        class: `triage-tab-btn ${activeFilter === 'WAITING' ? 'active' : ''}`,
        type: 'button',
        text: 'Waiting on Dept',
        onClick: () => {
          activeFilter = 'WAITING';
          renderTriage();
        },
      }),
      el('button', {
        class: `triage-tab-btn ${activeFilter === 'ALL' ? 'active' : ''}`,
        type: 'button',
        text: 'All Leads',
        onClick: () => {
          activeFilter = 'ALL';
          renderTriage();
        },
      }),
    );

    const leftPane = el('div', { class: 'triage-left' }, tabsBar, listContainer);

    const container = el('div', { class: 'triage-container' }, leftPane, rightPane);

    renderTriage();
    wrap.appendChild(container);
    return wrap;
  }

  /* ------------------------------------------- Rule-Based Smart Routing Modal */
  KRY.openSmartRoutingModal = function (lead = {}) {
    let selectedDept = 'Sales';
    let selectedAssignee = null;
    let brief = '';

    const DEPTS = [
      { key: 'Sales', name: 'Sales (BDM)', icon: '💼', sub: 'Site visit / Quotation proposal' },
      {
        key: 'Technical',
        name: 'Technical (Site Engg)',
        icon: '📐',
        sub: 'Structural inspection & survey',
      },
      { key: 'Design', name: 'Design (Architect)', icon: '🎨', sub: '2D layout & 3D renders' },
      {
        key: 'Purchase',
        name: 'Purchase (Procurement)',
        icon: '📦',
        sub: 'Material quotes & costing',
      },
      {
        key: 'Accounts',
        name: 'Accounts (Costing)',
        icon: '📊',
        sub: 'Commercial feasibility check',
      },
    ];

    const assigneeContainer = el('div', { class: 'assignee-workload-grid' });
    const dispatchButton = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      disabled: true,
      text: 'Dispatch Task →',
    });

    function updateDispatchState() {
      dispatchButton.disabled = !(selectedDept && selectedAssignee);
    }

    async function loadAssignees() {
      clear(assigneeContainer);
      assigneeContainer.appendChild(
        el('div', { class: 'small text-muted p-2', text: 'Loading available team members...' }),
      );
      try {
        const employees = await getEmployees();
        clear(assigneeContainer);
        const deptEmployees = employees.filter((e) => {
          if (selectedDept === 'Sales') return KRY.isSales(e);
          if (selectedDept === 'Technical') return e.role === 'SITE_ENGINEER';
          if (selectedDept === 'Design') return e.role === 'ARCHITECT';
          if (selectedDept === 'Purchase') return e.role === 'PURCHASE';
          if (selectedDept === 'Accounts') return e.role === 'ACCOUNTS';
          return false;
        });

        if (!deptEmployees.length) {
          assigneeContainer.appendChild(
            el('div', {
              class: 'small text-muted p-2',
              text: 'No active employees in this department.',
            }),
          );
          selectedAssignee = null;
          updateDispatchState();
          return;
        }

        deptEmployees.forEach((emp, index) => {
          // Synthetic workload check for demo UI
          const workloadCount = (index % 3) * 2;
          const isAvailable = workloadCount <= 2;
          const pillClass = isAvailable ? 'workload-pill-available' : 'workload-pill-busy';
          const pillText = isAvailable
            ? `Available (${workloadCount} tasks)`
            : `Heavy Load (${workloadCount} tasks)`;

          const row = el(
            'div',
            {
              class: `assignee-workload-row ${selectedAssignee === emp.id ? 'selected' : ''}`,
              onClick: () => {
                selectedAssignee = emp.id;
                loadAssignees();
                updateDispatchState();
              },
            },
            el(
              'div',
              { class: 'row align-center gap-sm' },
              el('span', { class: 'avatar small' }, KRY.initials(emp.name)),
              el(
                'div',
                {},
                el('strong', { text: emp.name }),
                el('small', { class: 'text-muted block', text: KRY.roleLabel(emp.role) }),
              ),
            ),
            el('span', { class: pillClass, text: pillText }),
          );
          assigneeContainer.appendChild(row);
        });

        if (!selectedAssignee && deptEmployees.length) {
          selectedAssignee = deptEmployees[0].id;
          updateDispatchState();
        }
      } catch {
        clear(assigneeContainer);
        assigneeContainer.appendChild(
          el('div', { class: 'small text-muted p-2', text: 'Could not load employees.' }),
        );
      }
    }

    const deptTilesGrid = el('div', { class: 'dept-tiles-grid' });
    DEPTS.forEach((d) => {
      const tile = el(
        'div',
        {
          class: `dept-tile ${selectedDept === d.key ? 'selected' : ''}`,
          onClick: () => {
            selectedDept = d.key;
            selectedAssignee = null;
            document.querySelectorAll('.dept-tile').forEach((t) => t.classList.remove('selected'));
            tile.classList.add('selected');
            loadAssignees();
            updateDispatchState();
          },
        },
        el('span', { class: 'dept-tile-icon', text: d.icon }),
        el('span', { class: 'dept-tile-name', text: d.name }),
        el('span', { class: 'dept-tile-sub', text: d.sub }),
      );
      deptTilesGrid.appendChild(tile);
    });

    loadAssignees();

    const body = el(
      'form',
      { class: 'stack gap-md' },
      el(
        'div',
        { class: 'row justify-between align-center' },
        el('strong', { text: `Target Lead: ${lead.customer_name || lead.id}` }),
        el('span', { class: 'badge info', text: lead.id }),
      ),
      el(
        'div',
        {},
        el('label', {
          class: 'form-label',
          text: 'Step 1: Select Destination Department (Click Tile) *',
        }),
        deptTilesGrid,
      ),
      el(
        'div',
        {},
        el('label', { class: 'form-label', text: 'Step 2: Assignee & Workload Balancing *' }),
        assigneeContainer,
      ),
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Step 3: Admin Brief & Instructions for Department *' }),
        el('textarea', {
          rows: '3',
          placeholder:
            'Provide exact requirements, client preference, budget constraints and deadline...',
          onInput: (e) => {
            brief = e.target.value;
            updateDispatchState();
          },
        }),
      ),
    );

    dispatchButton.onclick = async () => {
      if (!selectedDept || !selectedAssignee) return;
      try {
        await api(`/leads/${lead.id}/route`, {
          method: 'POST',
          body: {
            task_type: DEPT_CONFIG[selectedDept].taskTypes[0],
            department: selectedDept,
            assigned_to: selectedAssignee,
            brief:
              brief || 'Please attend to customer requirement and submit update to Admin Desk.',
          },
        });
        toast(`Lead successfully routed to ${selectedDept}!`, 'success');
        closeModal();
        KRY.renderRoute();
      } catch (err) {
        toast(err.message || 'Could not route lead.', 'error');
      }
    };

    openModal({
      title: 'Rule-Based Smart Routing',
      subtitle: 'Dispatch Lead Deliverable to Department Spoke',
      body,
      actions: [{ label: 'Cancel', onClick: closeModal }, dispatchButton],
    });
  };

  /* ------------------------------------------- Approvals Desk */
  registerPage('approvals', async () => {
    let day = { items: [] };
    try {
      day = await api('/my-day');
    } catch {
      /* ignore */
    }
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(
      pageHead(
        'Approvals Desk',
        'Executive sign-off gate. Review commercial quotations, vendor costings, and work orders.',
      ),
    );

    const pendingApprovals = [
      {
        title: 'Quotation Approval: Mr. Rajesh Sharma',
        type: 'QUOTATION',
        amount: '₹18,50,000',
        margin: '22%',
        author: 'Amit K. (BDE)',
        notes: 'Customer approved 3D renders. Quoted with 5% promotional discount.',
      },
      {
        title: 'Work Order Finalization: DLF Phase 5 Villa',
        type: 'WORK_ORDER',
        amount: '₹24,00,000',
        margin: '28%',
        author: 'Rahul V. (Sales Manager)',
        notes: 'Contract signed. Initial 40% advance cheque received.',
      },
      {
        title: 'Vendor Quotation: Italian Botticino Marble',
        type: 'VENDOR_COSTING',
        amount: '₹3,40,000',
        margin: '—',
        author: 'Suresh P. (Purchase)',
        notes: '3 competitive quotes gathered. Lowest quote selected from RK Stones.',
      },
    ];

    const list = el('div', { class: 'lane-grid' });
    pendingApprovals.forEach((app) => {
      list.appendChild(
        el(
          'article',
          { class: 'pm-project-card' },
          el(
            'div',
            { class: 'pm-card-header' },
            el('h3', { class: 'pm-card-title', text: app.title }),
            el('span', { class: 'badge brand', text: app.type }),
          ),
          el('p', {
            class: 'pm-card-sub',
            text: `Value: ${app.amount} · Gross Margin: ${app.margin} · Prepared by ${app.author}`,
          }),
          el('p', { class: 'small text-muted', text: app.notes }),
          el(
            'div',
            { class: 'row gap-sm margin-top-sm' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () =>
                  toast(
                    `Approved ${app.title}! Transaction logged to immutable ledger.`,
                    'success',
                  ),
              },
              '✓ Approve & Authorize',
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-ghost danger',
                type: 'button',
                onClick: () => toast(`Revision requested for ${app.title}.`, 'info'),
              },
              'Request Revision',
            ),
          ),
        ),
      );
    });

    wrap.appendChild(card('Pending Commercial & Operational Sign-offs', '', list));
    return wrap;
  });

  registerPage('triage', renderTriageInbox);
  async function renderProfessionalOverview(day) {
    const wrap = el('div', { class: 'stack crm-overview' });
    wrap.appendChild(hero(day));
    let dash;
    try {
      dash = await api('/dashboard');
    } catch (error) {
      wrap.appendChild(
        card(
          'Overview unavailable',
          'Your dashboard could not be loaded.',
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => KRY.renderRoute() },
            'Try again',
          ),
        ),
      );
      return wrap;
    }
    const c = dash.counts || {};
    const shortcuts = el('div', { class: 'workspace-shortcuts' });
    [
      ['New lead', 'Capture a customer enquiry', 'plus', () => KRY.openNewLead()],
      ['Approvals', 'Review pending decisions', 'shield', () => navigate('actionqueue')],
      ['Projects', 'Track delivery and milestones', 'folder', () => navigate('projects')],
      ['Quotations', 'Review commercial proposals', 'doc', () => navigate('quotations')],
    ].forEach(([label, description, glyph, action]) => shortcuts.appendChild(
      el('button', { class: 'workspace-shortcut', type: 'button', onClick: action },
        el('span', { class: 'workspace-shortcut-icon' }, icon(glyph)),
        el('strong', { text: label }), el('small', { text: description })),
    ));
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard('Open leads', String(c.openLeads ?? 0), 'Active customer opportunities', 'brand'),
        statCard(
          'Needs your action',
          String(c.myPendingCount ?? 0),
          'Reviews, routing and approvals',
          'warn',
        ),
        statCard(
          'SLA breached',
          String(c.overdueCount ?? 0),
          'Tasks requiring immediate attention',
          c.overdueCount ? 'danger' : 'good',
        ),
        statCard(
          'Active projects',
          String(c.projectsCount ?? 0),
          'Projects in your workspace',
          'info',
        ),
      ),
    );
    const actions = el('div', { class: 'stack' });
    if (day.actionQueue && day.actionQueue.total)
      actions.appendChild(actionQueueCard(day.actionQueue, 8));
    const requests = await api('/admin-requests');
    requests
      .filter((request) => request.status === 'Open')
      .forEach((request) =>
        actions.appendChild(
          el(
            'div',
            { class: 'crm-action-row' },
            el(
              'div',
              { class: 'crm-action-copy' },
              el('strong', { text: request.customer_name }),
              el('p', { text: request.message }),
              el('small', {
                text: `${request.requester_name} · ${fmtDateTime(request.created_at)}`,
              }),
            ),
            el(
              'button',
              { class: 'btn btn-sm', onClick: () => KRY.openTaskModal(request.task_id) },
              'Review request',
            ),
          ),
        ),
      );
    const overdue = dash.overdueTasks || [];
    if (!overdue.length)
      actions.appendChild(
        emptyState(
          'No overdue tasks',
          'Review the action queue for new submissions and approvals.',
          'check',
        ),
      );
    overdue.forEach((task) =>
      actions.appendChild(
        el(
          'div',
          { class: 'crm-action-row' },
          el('span', { class: 'crm-action-icon' }, icon('clock')),
          el(
            'div',
            { class: 'crm-action-copy' },
            el('strong', { text: task.customer_name || 'Customer task' }),
            el('p', {
              class: 'muted',
              text: `${titleCase(task.task_type || 'Task')} · ${task.assignee_name || task.department || 'Unassigned'}`,
            }),
          ),
          el(
            'button',
            { class: 'btn btn-sm', type: 'button', onClick: () => navigate('actionqueue') },
            'Review',
          ),
        ),
      ),
    );
    actions.appendChild(
      el(
        'button',
        { class: 'btn', type: 'button', onClick: () => navigate('actionqueue') },
        'View action queue',
      ),
    );
    const right = el('div', { class: 'stack' });
    right.appendChild(card('Quick actions', 'Your everyday workspace', shortcuts));
    const projectHost = el('div', { class: 'stack' });
    try {
      const projects = await api('/projects');
      projects.slice(0, 3).forEach((project) => {
        const percent = Math.max(0, Math.min(100, Number(project.progress) || 0));
        projectHost.appendChild(el('article', { class: 'workspace-project' },
          el('div', { class: 'workspace-project-head' },
            el('span', { class: 'workspace-shortcut-icon' }, icon('folder')),
            el('div', {}, el('strong', { text: project.customer_name || project.id }),
              el('p', { class: 'muted small', text: project.project_location || project.id }))),
          el('div', { class: 'workspace-project-head' },
            el('span', { class: 'small muted', text: project.status || 'Project progress' }),
            el('strong', { text: `${percent}%` })),
          el('div', { class: 'workspace-progress', role: 'progressbar', 'aria-label': 'Project progress',
            'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
            el('span', { style: `width:${percent}%` })),
          el('button', { class: 'btn btn-ghost', type: 'button', text: 'View project details',
            onClick: () => KRY.openProjectModal(project.id) })));
      });
      if (!projects.length) projectHost.appendChild(emptyState('No projects yet', 'Approved projects and their progress will appear here.'));
    } catch (error) {
      projectHost.appendChild(el('p', { class: 'form-error', text: 'Project summary could not load. Open Projects to retry.' }));
    }
    right.appendChild(card('Project progress', 'Latest accessible projects', projectHost));
    const funnel = dash.funnel || [];
    right.appendChild(
      card(
        'Pipeline overview',
        'Current lead distribution by stage',
        funnel.length
          ? createSvgFunnel(
              funnel.map((f, i) => ({
                label: f.label || f.stage,
                count: f.count,
                color: ['#4263eb', '#5276ed', '#4688c7', '#219d99', '#16846d'][i % 5],
              })),
            )
          : emptyState('No pipeline yet', 'Add a lead to begin tracking opportunities.'),
      ),
    );
    const team = el('div', { class: 'stack' });
    (dash.departmentQueue || []).forEach((d) =>
      team.appendChild(
        el(
          'div',
          { class: 'crm-action-row' },
          el('strong', { class: 'crm-action-copy', text: d.department || 'Unassigned' }),
          el('span', { text: `${d.count} open` }),
          badge(`${d.submitted || 0} for review`, 'info'),
        ),
      ),
    );
    if (!(dash.departmentQueue || []).length)
      team.appendChild(emptyState('No open team tasks', 'Assigned work will appear here.'));
    right.appendChild(card('Team workload', 'Open tasks and submissions by department', team));
    wrap.appendChild(
      el(
        'div',
        { class: 'crm-overview-grid' },
        card('Needs your attention', 'Prioritise overdue work and pending decisions', actions),
        right,
      ),
    );
    wrap.appendChild(
      card(
        'Recent activity',
        'Latest recorded changes across your workspace',
        (dash.recentActivity || []).length
          ? activityList(dash.recentActivity)
          : emptyState('No activity yet', 'New updates will appear here.'),
      ),
    );
    return wrap;
  }

  async function renderSuperAdminCommandCenter(day) {
    return renderProfessionalOverview(day);
  }

  /* ------------------------------------------- Accounts Financial Command Center */
  async function renderAccountsDashboard(day) {
    const wrap = el('div', { class: 'stack' });
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Accounts').split(' ')[0];

    wrap.appendChild(
      el(
        'div',
        { class: 'telecaller-day-header' },
        el(
          'div',
          {},
          el('h2', { text: `Good day, ${firstName}` }),
          el('p', {
            text: 'Financial Command Center · Real-time Cash Flow, Billing & Milestone Receivables',
          }),
        ),
        el(
          'div',
          { class: 'row gap-sm' },
          el(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => KRY.openGenerateInvoiceModal(),
            },
            icon('plus'),
            'Generate Invoice',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('receivables') },
            icon('rupee'),
            'Receivables (Udhaar)',
          ),
        ),
      ),
    );

    // Top Stat Cards with High-Contrast Numbers
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard(
          'Total Revenue Collected',
          '₹45,00,000',
          'good',
          'Cleared bank receipts for FY 2026-27',
        ),
        statCard(
          'Pending Receivables',
          '₹12,00,000 Overdue',
          'danger',
          '4 client milestones due past grace period',
        ),
        statCard('Active Invoices', '18', 'brand', '6 draft, 8 sent, 4 partially paid'),
        statCard('Vendor Payables', '₹8,40,000', 'warn', 'Approved PO disbursements due this week'),
      ),
    );

    const midRow = el('div', { class: 'chart-card-grid' });

    // Overdue Receivables Action Widget
    const overdueList = el('div', { class: 'stack gap-sm' });
    const overdueClients = [
      {
        client: 'Mr. Rajesh Sharma',
        project: 'DLF Phase 5 Villa',
        overdue: '₹3,50,000',
        days: '8 days overdue',
      },
      {
        client: 'Mr. Ananya Sen',
        project: 'Nirvana Penthouse',
        overdue: '₹4,20,000',
        days: '14 days overdue',
      },
      {
        client: 'Dr. Sameer Kapoor',
        project: 'Clinic Fitout',
        overdue: '₹1,80,000',
        days: '4 days overdue',
      },
    ];
    overdueClients.forEach((item) => {
      overdueList.appendChild(
        el(
          'div',
          { class: 'pm-project-card', style: 'padding:14px;' },
          el(
            'div',
            { class: 'row justify-between align-center' },
            el(
              'div',
              {},
              el('strong', { text: item.client }),
              el('small', { class: 'text-muted block', text: `${item.project} · ${item.days}` }),
            ),
            el('span', {
              class: 'metric-mono',
              style: 'color:#e11d48; font-weight:700;',
              text: item.overdue,
            }),
          ),
          el(
            'div',
            { class: 'row justify-end margin-top-xs' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () =>
                  toast(
                    `Automated payment reminder dispatched via WhatsApp & Email to ${item.client}.`,
                    'success',
                  ),
              },
              'Send Reminder ✉️',
            ),
          ),
        ),
      );
    });
    midRow.appendChild(
      card(
        'Overdue Receivables (Action Required)',
        'Milestone payments awaiting customer settlement',
        overdueList,
      ),
    );

    // Recent Transactions Stream
    const txList = el('div', { class: 'stack gap-sm' });
    const transactions = [
      {
        from: 'Dr. Sameer Kapoor',
        amount: '+ ₹2,50,000',
        mode: 'NEFT Ref #HDFC98214',
        date: 'Today, 10:15 AM',
        milestone: 'Milestone 2 (Screed & Flooring)',
      },
      {
        from: 'Mr. Ananya Sen',
        amount: '+ ₹5,00,000',
        mode: 'ICICI Cheque #004128',
        date: 'Today, 09:30 AM',
        milestone: 'Milestone 1 (Booking Advance)',
      },
      {
        from: 'Mr. Vikram Malhotra',
        amount: '+ ₹3,20,000',
        mode: 'RTGS Ref #AXIS7721',
        date: 'Yesterday, 04:00 PM',
        milestone: 'Milestone 3 (Modular Handover)',
      },
    ];
    transactions.forEach((tx) => {
      txList.appendChild(
        el(
          'div',
          { class: 'pm-project-card', style: 'padding:14px;' },
          el(
            'div',
            { class: 'row justify-between align-center' },
            el(
              'div',
              {},
              el('strong', { text: tx.from }),
              el('small', { class: 'text-muted block', text: `${tx.milestone} · ${tx.mode}` }),
            ),
            el('span', {
              class: 'metric-mono',
              style: 'color:#10b981; font-weight:700;',
              text: tx.amount,
            }),
          ),
          el('small', { class: 'text-muted', text: tx.date }),
        ),
      );
    });
    midRow.appendChild(
      card('Recent Financial Receipts', 'Verified money collected and reconciled today', txList),
    );

    wrap.appendChild(midRow);
    return wrap;
  }

  /* ------------------------------------------- Sales Leadership & Deal Desk */
  async function renderSalesLeadershipDashboard(day) {
    const wrap = el('div', { class: 'stack' });
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Sales Manager').split(' ')[0];

    wrap.appendChild(
      el(
        'div',
        { class: 'telecaller-day-header' },
        el(
          'div',
          {},
          el('h2', { text: `Good day, ${firstName}` }),
          el('p', { text: 'Sales Leadership & Deal Desk · Target Realisation & Team Quota' }),
        ),
        el(
          'div',
          { class: 'row gap-sm' },
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => navigate('quoteapprovals') },
            icon('shield'),
            'Quotation Approvals',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('pipeline') },
            icon('board'),
            'Team Pipeline',
          ),
        ),
      ),
    );

    // Stat Cards
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard(
          'Team Target vs Achieved',
          '76% (₹38.0L / ₹50.0L)',
          'good',
          'On track to hit quarterly quota',
        ),
        statCard(
          'Total Pipeline Value',
          '₹1.5 Cr',
          'brand',
          '18 active opportunities across 4 BDEs',
        ),
        statCard(
          'Deals Closing This Week',
          '4 Deals (₹25L)',
          'warn',
          'High probability closing stage',
        ),
        statCard(
          'Pending Manager Approvals',
          '3 Quotes',
          'info',
          'Awaiting margin and discount sign-off',
        ),
      ),
    );

    const midRow = el('div', { class: 'chart-card-grid' });

    // Target vs Actual Circular Gauge
    const circularGauge = createSvgDonut([
      { label: 'Achieved Revenue', value: 38, color: '#10b981' },
      { label: 'Remaining Target', value: 12, color: '#e2e8f0' },
    ]);
    midRow.appendChild(
      card(
        'Monthly Team Target Realisation',
        '₹38 Lakhs achieved of ₹50 Lakhs target (76%)',
        circularGauge,
      ),
    );

    // Top Performer Leaderboard Widget
    const leaderboard = el('div', { class: 'stack gap-xs' });
    const reps = [
      { name: 'Amit Kumar', won: 4, revenue: '₹32.5L', rank: '1 🏆', badge: 'Top Closer' },
      { name: 'Neha Singh', won: 3, revenue: '₹24.0L', rank: '2', badge: 'High Margin' },
      { name: 'Vikram Sharma', won: 2, revenue: '₹16.0L', rank: '3', badge: 'Consistent' },
    ];
    const table = el(
      'table',
      { class: 'leaderboard-table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { text: 'Rank' }),
          el('th', { text: 'Salesperson' }),
          el('th', { text: 'Deals Won' }),
          el('th', { text: 'Revenue' }),
        ),
      ),
      el(
        'tbody',
        {},
        reps.map((r) =>
          el(
            'tr',
            {},
            el('td', { class: 'metric-mono', text: r.rank }),
            el(
              'td',
              {},
              el('strong', { text: r.name }),
              el('small', { class: 'text-muted block', text: r.badge }),
            ),
            el('td', { class: 'metric-mono', text: String(r.won) }),
            el('td', {
              class: 'metric-mono',
              style: 'color:#2563eb; font-weight:700;',
              text: r.revenue,
            }),
          ),
        ),
      ),
    );
    leaderboard.appendChild(table);
    midRow.appendChild(
      card('BDE Quota Leaderboard', 'Monthly performance ranking across sales team', leaderboard),
    );

    wrap.appendChild(midRow);
    return wrap;
  }
  async function renderPMCommandCenter(day) {
    let projects = [];
    try {
      projects = await api('/projects');
    } catch {
      projects = [];
    }
    const wrap = el('div', { class: 'stack' });

    // Hero Header
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Project Manager').split(' ')[0];
    const header = el(
      'div',
      { class: 'telecaller-day-header' },
      el(
        'div',
        {},
        el('h2', { text: `Good day, ${firstName}` }),
        el('p', {
          text: 'Project Execution Command Center · Procore Grade Field & Milestone Tracking',
        }),
      ),
      el(
        'div',
        { class: 'row gap-sm' },
        el(
          'button',
          { class: 'btn btn-primary', type: 'button', onClick: () => KRY.openQuickPhotoModal() },
          icon('camera'),
          'Quick Site Photo',
        ),
        el(
          'button',
          { class: 'btn', type: 'button', onClick: () => navigate('milestones') },
          icon('board'),
          'Milestones',
        ),
      ),
    );
    wrap.appendChild(header);

    // Stat Cards
    const totalProjects = projects.length || 6;
    const atRiskCount =
      projects.filter((p) => p.status === 'At Risk' || (p.late_milestones && p.late_milestones > 0))
        .length || 2;
    const pendingProcurement = 3;

    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard(
          'Active Projects',
          String(totalProjects),
          'brand',
          'Full turnkey & interior sites',
        ),
        statCard(
          'SLA Delay Risk',
          String(atRiskCount),
          atRiskCount > 0 ? 'danger' : 'good',
          `${atRiskCount} sites flagged for milestone delay`,
        ),
        statCard(
          'Pending Material Approvals',
          String(pendingProcurement),
          'warn',
          'Material requests waiting admin clearance',
        ),
      ),
    );

    // Project Health Donut Chart & Filter
    let selectedHealthFilter = 'ALL';
    const projectListContainer = el('div', { class: 'lane-grid' });

    function renderProjectCards() {
      clear(projectListContainer);
      const filtered = projects.filter((p) => {
        if (selectedHealthFilter === 'ALL') return true;
        if (selectedHealthFilter === 'ON_TRACK')
          return !p.late_milestones && p.status !== 'At Risk';
        if (selectedHealthFilter === 'AT_RISK')
          return p.late_milestones > 0 || p.status === 'At Risk';
        if (selectedHealthFilter === 'DELAYED') return p.status === 'Delayed';
        return true;
      });

      if (!filtered.length) {
        projectListContainer.appendChild(
          emptyState('No projects match filter', 'Click another health slice or show all.'),
        );
        return;
      }

      filtered.forEach((prj) => {
        const progress = Math.min(100, Math.max(0, Number(prj.progress) || 45));
        const isRisk = prj.late_milestones > 0 || prj.status === 'At Risk';
        const isDelayed = prj.status === 'Delayed';
        const healthLabel = isDelayed ? 'DELAYED' : isRisk ? 'AT RISK' : 'ON TRACK';
        const healthClass = isDelayed
          ? 'badge-health-delayed'
          : isRisk
            ? 'badge-health-atrisk'
            : 'badge-health-ontrack';
        const fillClass = isDelayed ? 'delayed' : isRisk ? 'risk' : '';

        const cardEl = el(
          'article',
          { class: 'pm-project-card' },
          el(
            'div',
            { class: 'pm-card-header' },
            el(
              'div',
              {},
              el('h3', {
                class: 'pm-card-title',
                text: prj.name || prj.customer_name || `Project #${prj.id}`,
              }),
              el('p', {
                class: 'pm-card-sub',
                text: `${prj.lead_id || prj.project_code || 'KRY-PRJ'} · ${prj.site_location || prj.location || 'Gurugram'}`,
              }),
            ),
            el('span', { class: `badge ${healthClass}`, text: healthLabel }),
          ),
          el(
            'div',
            { class: 'pm-progress-wrap' },
            el(
              'div',
              { class: 'pm-progress-labels' },
              el('span', { text: `Milestone: ${prj.current_milestone || 'Structure & MEP'}` }),
              el('span', { class: 'metric-mono', text: `${progress}%` }),
            ),
            el(
              'div',
              { class: 'pm-progress-bar' },
              el('div', {
                class: `pm-progress-bar-fill ${fillClass}`,
                style: `width:${progress}%`,
              }),
            ),
          ),
          el(
            'div',
            { class: 'row justify-between align-center' },
            el(
              'div',
              { class: 'avatar-stack' },
              el('span', { class: 'avatar', title: 'Site Engineer' }, 'AK'),
              el('span', { class: 'avatar', title: 'Supervisor' }, 'VS'),
              el('small', {
                class: 'muted text-xs margin-left-sm',
                text: 'Target: ' + (prj.due_date ? fmtDate(prj.due_date) : '15 Dec 2026'),
              }),
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: (e) => {
                  stop(e);
                  KRY.openUpdateProgressModal(prj);
                },
              },
              icon('check'),
              'Update Progress',
            ),
          ),
        );
        projectListContainer.appendChild(cardEl);
      });
    }

    const onTrackCount = Math.max(
      1,
      projects.filter((p) => !p.late_milestones && p.status !== 'At Risk').length,
    );
    const healthDonut = createSvgDonut(
      [
        { label: 'On Track', value: onTrackCount, color: '#10b981' },
        { label: 'At Risk', value: Math.max(1, atRiskCount), color: '#f59e0b' },
        { label: 'Delayed', value: 1, color: '#ef4444' },
      ],
      (label) => {
        if (label === 'On Track') selectedHealthFilter = 'ON_TRACK';
        else if (label === 'At Risk') selectedHealthFilter = 'AT_RISK';
        else if (label === 'Delayed') selectedHealthFilter = 'DELAYED';
        else selectedHealthFilter = 'ALL';
        renderProjectCards();
      },
    );

    wrap.appendChild(
      card(
        'Project Health Portfolio',
        'Interactive distribution by schedule SLA. Click a slice to filter projects.',
        healthDonut,
      ),
    );

    // Projects Grid Section
    const projectsSection = el('section', { class: 'stack' });
    projectsSection.appendChild(
      el(
        'div',
        { class: 'lane-head' },
        el('h3', {}, icon('folder'), 'ACTIVE SITE PROJECTS'),
        el(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            onClick: () => {
              selectedHealthFilter = 'ALL';
              renderProjectCards();
            },
          },
          'Show All',
        ),
      ),
    );
    renderProjectCards();
    projectsSection.appendChild(projectListContainer);
    wrap.appendChild(projectsSection);

    return wrap;
  }

  /* ------------------------------------------- Marketing Dashboard */
  async function renderMarketingDashboard(day) {
    const wrap = el('div', { class: 'stack' });
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Marketer').split(' ')[0];

    wrap.appendChild(
      el(
        'div',
        { class: 'telecaller-day-header' },
        el(
          'div',
          {},
          el('h2', { text: `Good day, ${firstName}` }),
          el('p', { text: 'Marketing Overview · Lead Attribution & Campaign Performance' }),
        ),
        el(
          'div',
          { class: 'row gap-sm' },
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => navigate('campaigns') },
            icon('flag'),
            'Campaigns',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('leadanalytics') },
            icon('board'),
            'Lead Analytics',
          ),
        ),
      ),
    );

    // Stat Cards with Sparklines
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard('Leads Generated', '142', 'good', '+18% vs last month (Meta & Google)'),
        statCard('Cost Per Lead (CPL)', '₹245', 'brand', '₹35 lower than industry average'),
        statCard('Qualified Lead Rate', '42.5%', 'info', '60 qualified for site visits & design'),
        statCard(
          'Active Ad Spend',
          '₹85,000',
          'neutral',
          'Monthly budget ₹1,20,000 (71% utilized)',
        ),
      ),
    );

    // Charts Row: Source Donut & Marketing Funnel
    const chartsRow = el('div', { class: 'chart-card-grid' });
    const sourceDonut = createSvgDonut([
      { label: 'Meta Ads (FB/IG)', value: 64, color: '#3b82f6' },
      { label: 'Google Search Ads', value: 42, color: '#10b981' },
      { label: 'Website SEO & Direct', value: 24, color: '#8b5cf6' },
      { label: 'Referrals & WhatsApp', value: 12, color: '#f59e0b' },
    ]);
    chartsRow.appendChild(
      card(
        'Lead Source Acquisition',
        'Channel breakdown of inquiries captured this month',
        sourceDonut,
      ),
    );

    const marketingFunnel = createSvgFunnel([
      { label: 'Impressions', count: 48200, color: '#2563eb' },
      { label: 'Ad Clicks', count: 3650, color: '#3b82f6' },
      { label: 'Inquiries / Leads Captured', count: 142, color: '#0284c7' },
      { label: 'Telecaller Contacted', count: 98, color: '#0d9488' },
      { label: 'Sales & Design Qualified', count: 60, color: '#10b981' },
    ]);
    chartsRow.appendChild(
      card(
        'Marketing Acquisition Funnel',
        'Stage-by-stage conversion from impressions to qualified leads',
        marketingFunnel,
      ),
    );

    wrap.appendChild(chartsRow);

    // Active Campaign Tasks
    const campaignTasks = day.items || [];
    const campaignList = el('div', { class: 'lane-grid' });
    if (!campaignTasks.length) {
      campaignList.appendChild(
        el(
          'article',
          { class: 'pm-project-card' },
          el('h3', { class: 'pm-card-title', text: 'Meta Ad Campaign: Gurgaon Luxury Villas' }),
          el('p', {
            class: 'pm-card-sub',
            text: 'Platform: Meta Ads (Instagram / Facebook) · Budget: ₹45,000',
          }),
          el('p', {
            class: 'small text-muted',
            text: 'Admin Brief: Target HNIs in DLF Phase 1-5 & Golf Course Road for turnkey interiors.',
          }),
          el(
            'div',
            { class: 'row gap-sm margin-top-sm' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () => KRY.openCampaignReportModal(),
              },
              icon('doc'),
              'Upload Campaign Report',
            ),
            el(
              'button',
              { class: 'btn btn-sm', type: 'button', onClick: () => navigate('leadanalytics') },
              'View Leads',
            ),
          ),
        ),
      );
    } else {
      campaignTasks.forEach((t) => {
        campaignList.appendChild(
          el(
            'article',
            { class: 'pm-project-card' },
            el('h3', {
              class: 'pm-card-title',
              text: t.customer_name || t.brief || 'Marketing Campaign Task',
            }),
            el('p', {
              class: 'pm-card-sub',
              text: `${t.task_type || 'CAMPAIGN'} · Due: ${t.due_date ? fmtDate(t.due_date) : 'Today'}`,
            }),
            el('p', {
              class: 'small text-muted',
              text: t.brief || 'Target audience campaign execution',
            }),
            el(
              'div',
              { class: 'row gap-sm margin-top-sm' },
              el(
                'button',
                {
                  class: 'btn btn-sm btn-primary',
                  type: 'button',
                  onClick: () => KRY.openCampaignReportModal(t),
                },
                icon('doc'),
                'Upload Campaign Report',
              ),
            ),
          ),
        );
      });
    }
    wrap.appendChild(
      card(
        'Active Marketing Tasks & Campaigns',
        'Campaign execution tasks assigned by Admin Desk',
        campaignList,
      ),
    );
    return wrap;
  }

  /* ------------------------------------------- Architect Design Studio */
  async function renderArchitectDashboard(day) {
    const wrap = el('div', { class: 'stack' });
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Architect').split(' ')[0];

    wrap.appendChild(
      el(
        'div',
        { class: 'telecaller-day-header' },
        el(
          'div',
          {},
          el('h2', { text: `Good day, ${firstName}` }),
          el('p', { text: 'Design Studio · Architectural Plans, 3D Renders & Revision Tracking' }),
        ),
        el(
          'div',
          { class: 'row gap-sm' },
          el(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => KRY.openUploadDesignModal(),
            },
            icon('plus'),
            'Upload Drawing',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('designvault') },
            icon('folder'),
            'Design Vault',
          ),
        ),
      ),
    );

    // Stat Cards
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard('Active Designs', '5', 'brand', 'In concept & 3D render phase'),
        statCard('Revisions Requested', '2', 'warn', 'Client feedback notes pending revision'),
        statCard('Approved Designs', '14', 'good', 'Ready for estimation and site execution'),
        statCard('Pending Uploads', '1', 'info', '3D render package due tomorrow'),
      ),
    );

    // Design Pipeline Tracker
    const pipelineWidget = el(
      'div',
      { class: 'stack gap-sm' },
      el(
        'div',
        { class: 'design-pipeline-bar' },
        el('div', { class: 'design-step completed' }, '01 Concept & Moodboard ✓'),
        el('div', { class: 'design-step completed' }, '02 2D CAD Layout ✓'),
        el('div', { class: 'design-step active' }, '03 3D Photorealistic Render 🎨'),
        el('div', { class: 'design-step' }, '04 Client Approval'),
      ),
    );
    wrap.appendChild(
      card(
        'Design Workflow Progression',
        'Standard architecture lifecycle from initial layout to client sign-off',
        pipelineWidget,
      ),
    );

    // Design Tasks Grid
    const designTasks = day.items || [];
    const designGrid = el('div', { class: 'lane-grid' });
    if (!designTasks.length) {
      designGrid.appendChild(
        el(
          'article',
          { class: 'pm-project-card' },
          el(
            'div',
            { class: 'row justify-between align-center' },
            el('h3', { class: 'pm-card-title', text: 'Mr. Rajesh Sharma · 3BHK Turnkey Interior' }),
            el('span', { class: 'badge brand', text: '3D Render' }),
          ),
          el('p', { class: 'pm-card-sub', text: 'KRY-LEAD-0001 · DLF Phase 5, Gurugram' }),
          el('p', {
            class: 'small text-muted',
            text: 'Admin Brief: Living room Italian marble layout + false ceiling lighting design. Due in 2 days.',
          }),
          el(
            'div',
            { class: 'row gap-sm margin-top-sm' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () =>
                  KRY.openUploadDesignModal({
                    customer_name: 'Mr. Rajesh Sharma',
                    lead_id: 'KRY-LEAD-0001',
                  }),
              },
              icon('doc'),
              'Upload Design & Submit',
            ),
            el(
              'button',
              { class: 'btn btn-sm', type: 'button', onClick: () => navigate('designvault') },
              'View Past Revisions',
            ),
          ),
        ),
      );
    } else {
      designTasks.forEach((t) => {
        designGrid.appendChild(
          el(
            'article',
            { class: 'pm-project-card' },
            el(
              'div',
              { class: 'row justify-between align-center' },
              el('h3', { class: 'pm-card-title', text: t.customer_name || 'Design Task' }),
              el('span', { class: 'badge brand', text: t.task_type || 'DRAWING' }),
            ),
            el('p', {
              class: 'pm-card-sub',
              text: `${t.lead_id || ''} · Due: ${t.due_date ? fmtDate(t.due_date) : 'Today'}`,
            }),
            el('p', {
              class: 'small text-muted',
              text: t.brief || 'Prepare architectural layout as per customer requirement',
            }),
            el(
              'div',
              { class: 'row gap-sm margin-top-sm' },
              el(
                'button',
                {
                  class: 'btn btn-sm btn-primary',
                  type: 'button',
                  onClick: () => KRY.openUploadDesignModal(t),
                },
                icon('doc'),
                'Upload Design & Submit',
              ),
            ),
          ),
        );
      });
    }
    wrap.appendChild(
      card(
        'Assigned Architectural & Drawing Tasks',
        'Design deliverables requested by Admin Desk',
        designGrid,
      ),
    );
    return wrap;
  }

  /* ------------------------------------------- Site Engineer Field Dashboard */
  async function renderSiteEngineerDashboard(day) {
    const wrap = el('div', { class: 'stack' });
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Site Engineer').split(' ')[0];

    wrap.appendChild(
      el(
        'div',
        { class: 'telecaller-day-header' },
        el(
          'div',
          {},
          el('h2', { text: `Good day, ${firstName}` }),
          el('p', {
            text: 'Field Operations · Site Inspections, Measurements & Engineering Reports',
          }),
        ),
        el(
          'div',
          { class: 'row gap-sm' },
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => KRY.openQuickPhotoModal() },
            icon('camera'),
            'Quick Site Photo',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('measurements') },
            icon('grid'),
            'Measurements',
          ),
        ),
      ),
    );

    // Stat Cards
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard('Visits Today', '2', 'brand', 'Scheduled field inspections'),
        statCard('Pending Reports', '1', 'warn', 'Measurement sheet awaiting upload'),
        statCard('Measurements Taken', '18', 'good', 'Living, kitchen & terrace surveys'),
        statCard('Active Sites', '4', 'info', 'Turnkey construction projects'),
      ),
    );

    // Site Visit Tasks Grid (Mobile-friendly)
    const siteTasks = day.items || [];
    const visitGrid = el('div', { class: 'lane-grid' });
    if (!siteTasks.length) {
      const gmapsUrl = 'https://www.google.com/maps/search/?api=1&query=DLF+Phase+5+Gurugram';
      visitGrid.appendChild(
        el(
          'article',
          { class: 'pm-project-card' },
          el(
            'div',
            { class: 'row justify-between align-center' },
            el('h3', { class: 'pm-card-title', text: 'Mr. Vikram Malhotra · Villa Inspection' }),
            el('span', { class: 'badge brand', text: 'Visit Scheduled' }),
          ),
          el('p', {
            class: 'pm-card-sub',
            text: 'Site Address: Plot 42, DLF Phase 5, Golf Course Ext Rd, Gurugram',
          }),
          el('p', {
            class: 'small text-muted',
            text: 'Admin Brief: Take structural dimensions of living room and check RCC slab curing.',
          }),
          el(
            'div',
            { class: 'row gap-sm margin-top-sm align-center' },
            el(
              'a',
              { class: 'btn-directions', href: gmapsUrl, target: '_blank', rel: 'noopener' },
              'Get Directions 🗺️',
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () =>
                  KRY.openSiteVisitReportModal({
                    customer_name: 'Mr. Vikram Malhotra',
                    site_location: 'DLF Phase 5',
                  }),
              },
              icon('check'),
              'Start Visit / Upload Report',
            ),
          ),
        ),
      );
    } else {
      siteTasks.forEach((t) => {
        const addr = t.location || t.customer_name || 'Gurugram';
        const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
        visitGrid.appendChild(
          el(
            'article',
            { class: 'pm-project-card' },
            el(
              'div',
              { class: 'row justify-between align-center' },
              el('h3', { class: 'pm-card-title', text: t.customer_name || 'Site Inspection' }),
              el('span', { class: 'badge brand', text: t.task_type || 'SITE_VISIT' }),
            ),
            el('p', { class: 'pm-card-sub', text: `Location: ${addr}` }),
            el('p', {
              class: 'small text-muted',
              text: t.brief || 'Conduct site inspection and verify technical measurements',
            }),
            el(
              'div',
              { class: 'row gap-sm margin-top-sm align-center' },
              el(
                'a',
                { class: 'btn-directions', href: gmapsUrl, target: '_blank', rel: 'noopener' },
                'Get Directions 🗺️',
              ),
              el(
                'button',
                {
                  class: 'btn btn-sm btn-primary',
                  type: 'button',
                  onClick: () => KRY.openSiteVisitReportModal(t),
                },
                icon('check'),
                'Start Visit / Upload Report',
              ),
            ),
          ),
        );
      });
    }
    wrap.appendChild(
      card(
        'Scheduled Site Visits & Field Deliverables',
        'Mobile-optimized site inspection schedule',
        visitGrid,
      ),
    );
    return wrap;
  }

  /* ------------------------------------------- Sales Revenue Command Center */
  async function renderSalesDashboard(day) {
    const wrap = el('div', { class: 'stack' });
    const user = KRY.state.user || {};
    const firstName = String(user.name || 'Sales Executive').split(' ')[0];

    wrap.appendChild(
      el(
        'div',
        { class: 'telecaller-day-header' },
        el(
          'div',
          {},
          el('h2', { text: `Good day, ${firstName}` }),
          el('p', {
            text: 'Sales Revenue Command Center · Quotations, Pipeline & Deal Conversions',
          }),
        ),
        el(
          'div',
          { class: 'row gap-sm' },
          el(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => KRY.openCreateQuotationModal(),
            },
            icon('rupee'),
            'Create Quotation',
          ),
          el(
            'button',
            { class: 'btn', type: 'button', onClick: () => navigate('pipeline') },
            icon('board'),
            'My Pipeline (Kanban)',
          ),
        ),
      ),
    );

    // Stat Cards
    wrap.appendChild(
      el(
        'div',
        { class: 'metrics-row' },
        statCard('Pipeline Value', '₹48.5 Lakhs', 'brand', '14 active deals in negotiation'),
        statCard('Target Achieved', '76%', 'good', '₹38.0L achieved out of ₹50.0L target'),
        statCard('Quotes Pending', '4', 'warn', 'Proposals awaiting customer sign-off'),
        statCard('Hot Deals', '3', 'good', '> 80% closing probability this week'),
      ),
    );

    // Deal Actions & Recent Pipeline Cards
    const salesTasks = day.items || [];
    const dealsList = el('div', { class: 'lane-grid' });
    if (!salesTasks.length) {
      dealsList.appendChild(
        el(
          'article',
          { class: 'pm-project-card' },
          el(
            'div',
            { class: 'row justify-between align-center' },
            el('h3', { class: 'pm-card-title', text: 'Mr. Ananya Sen · Luxury Penthouse' }),
            el('span', { class: 'deal-value-pill', text: '₹22.5L' }),
          ),
          el('p', { class: 'pm-card-sub', text: 'Stage: Quotation Sent · Due Date: Tomorrow' }),
          el('p', {
            class: 'small text-muted',
            text: 'Quotation v1.0 submitted. Customer requested 5% discount on Italian marble package.',
          }),
          el(
            'div',
            { class: 'row gap-sm margin-top-sm' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () =>
                  KRY.openCreateQuotationModal({
                    customer_name: 'Mr. Ananya Sen',
                    lead_id: 'KRY-LEAD-0018',
                    total_amount: 2250000,
                  }),
              },
              icon('rupee'),
              'Revise Quotation',
            ),
            el(
              'button',
              { class: 'btn btn-sm', type: 'button', onClick: () => navigate('pipeline') },
              'Move in Pipeline',
            ),
          ),
        ),
      );
      dealsList.appendChild(
        el(
          'article',
          { class: 'pm-project-card' },
          el(
            'div',
            { class: 'row justify-between align-center' },
            el('h3', {
              class: 'pm-card-title',
              text: 'Dr. Sameer Kapoor · Dental Clinic Interior',
            }),
            el('span', { class: 'deal-value-pill', text: '₹14.0L' }),
          ),
          el('p', { class: 'pm-card-sub', text: 'Stage: Site Visit Done · Follow-up Due: Today' }),
          el('p', {
            class: 'small text-muted',
            text: 'Measurements completed by Site Engineer. Ready for line-item quotation preparation.',
          }),
          el(
            'div',
            { class: 'row gap-sm margin-top-sm' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () =>
                  KRY.openCreateQuotationModal({
                    customer_name: 'Dr. Sameer Kapoor',
                    lead_id: 'KRY-LEAD-0021',
                    total_amount: 1400000,
                  }),
              },
              icon('rupee'),
              'Create Quotation',
            ),
          ),
        ),
      );
    } else {
      salesTasks.forEach((t) => {
        dealsList.appendChild(
          el(
            'article',
            { class: 'pm-project-card' },
            el(
              'div',
              { class: 'row justify-between align-center' },
              el('h3', { class: 'pm-card-title', text: t.customer_name || 'Deal Follow-up' }),
              el('span', { class: 'deal-value-pill', text: t.budget_range || '₹10-15L' }),
            ),
            el('p', {
              class: 'pm-card-sub',
              text: `Stage: ${KRY.stageLabel(t.lead_stage || t.stage)} · Due: ${t.due_date ? fmtDate(t.due_date) : 'Today'}`,
            }),
            el('p', {
              class: 'small text-muted',
              text: t.brief || 'Follow up with customer on pricing proposal',
            }),
            el(
              'div',
              { class: 'row gap-sm margin-top-sm' },
              el(
                'button',
                {
                  class: 'btn btn-sm btn-primary',
                  type: 'button',
                  onClick: () => KRY.openCreateQuotationModal(t),
                },
                icon('rupee'),
                'Create Quotation',
              ),
            ),
          ),
        );
      });
    }
    wrap.appendChild(
      card(
        'Active Deals & Quotation Follow-ups',
        'Commercial deals requiring salesperson action',
        dealsList,
      ),
    );
    return wrap;
  }

  registerPage('overview', async () => {
    const day = await api('/my-day');
    const user = KRY.state.user || {};

    if (user.role === 'SUPER_ADMIN') {
      return renderSuperAdminCommandCenter(day);
    }
    if (
      user.role === 'ADMIN_DESK' ||
      user.role === 'ADMIN' ||
      user.role === 'OPERATIONS_COORDINATOR'
    ) {
      return renderAdminMissionControl(day);
    }
    if (user.role === 'TELECALLER') {
      return renderTelecallerMyDay(day);
    }

    const central = day.scope === 'central';
    const wrap = el('div', { class: 'stack myday' });

    wrap.appendChild(hero(day));
    if (central && day.actionQueue.total) {
      wrap.appendChild(actionQueueCard(day.actionQueue, 3));
    }

    const lateUrgent = day.items.filter((item) => ['late', 'urgent'].includes(item.bucket));
    const dueToday = day.items.filter((item) => item.bucket === 'today');
    const waiting = day.items.filter((item) => item.bucket === 'waiting');
    const upcoming = day.items.filter((item) => item.bucket === 'upcoming');

    const main = el('div', { class: 'stack day-main' });
    main.appendChild(sectionHeader(t('myday.tasksTitle'), t('myday.tasksCopy'), null));

    if (!day.items.length) {
      main.appendChild(allClearCard());
    } else {
      if (lateUrgent.length) {
        main.appendChild(
          dayGroup('late', t('myday.lateTitle'), t('myday.lateCopy'), lateUrgent, 'late'),
        );
      }
      if (dueToday.length) {
        main.appendChild(dayGroup('today', t('myday.todayTitle'), null, dueToday, 'today'));
      }
      if (waiting.length) {
        main.appendChild(
          dayGroup('waiting', t('myday.waitingTitle'), t('myday.waitingCopy'), waiting, 'waiting'),
        );
      }
      if (upcoming.length) {
        main.appendChild(
          dayGroup(
            'upcoming',
            t('myday.upcomingTitle'),
            t('myday.upcomingCopy'),
            upcoming,
            'upcoming',
          ),
        );
      }
    }

    const side = el('aside', { class: 'day-side stack' });
    side.appendChild(activityCard(day));
    side.appendChild(quickLinksCard(central));

    wrap.appendChild(el('div', { class: 'day-layout' }, main, side));
    return wrap;
  });

  /* -------------------------------------------------------- Action Required */

  registerPage('actionqueue', async () => {
    const day = await api('/my-day');
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(
      pageHead(t('page.actionqueue.title'), t('myday.actionCopy'), [
        actionButton(t('nav.taskboard'), 'board', () => navigate('taskboard')),
      ]),
    );

    if (!day.actionQueue.total) {
      wrap.appendChild(
        card(
          null,
          null,
          el(
            'div',
            { class: 'all-clear' },
            el('span', { class: 'all-clear-icon' }, icon('spark')),
            el('h3', { text: t('myday.allClear') }),
            el('p', { text: t('queue.empty') }),
          ),
        ),
      );
      return wrap;
    }

    day.actionQueue.groups.forEach((group) => {
      if (!group.count) return;
      wrap.appendChild(
        card(
          t(`queue.${group.key}`),
          `${group.count}`,
          el(
            'div',
            { class: 'queue-groups single' },
            group.items.map((item) => queueRow(item)),
          ),
          { tight: true },
        ),
      );
    });

    return wrap;
  });

  /* --------------------------------------------------------------- Lead Board */

  registerPage('taskboard', async () => {
    const [board, dueReminders] = await Promise.all([
      api('/taskboard'),
      api('/reminders?status=TRIGGERED').catch(() => []),
    ]);
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(
      pageHead(t('page.taskboard.title'), t('taskboard.desc'), [
        actionButton(t('nav.leads'), 'flag', () => navigate('leads')),
        actionButton(t('myday.newLead'), 'plus', () => KRY.openNewLead(), 'btn-primary'),
      ]),
    );

    if (dueReminders && dueReminders.length) {
      const rows = dueReminders.map((rem) => {
        return el(
          'div',
          { class: 'due-reminder-row' },
          el(
            'div',
            { class: 'stack', style: 'gap: 2px;' },
            el(
              'div',
              { class: 'inline-row', style: 'gap: 8px;' },
              el('strong', { text: KRY.toTitleCase(rem.customer_name || 'Customer') }),
              el('span', { class: 'mono small muted', text: rem.customer_phone || '' }),
              badge('Follow-up Due', 'danger'),
            ),
            el('div', {
              class: 'small muted',
              text: `${rem.lead_id || ''} · Due: ${fmtDateTime(rem.due_at)} · Reason: ${rem.reason || 'Follow-up callback'}`,
            }),
          ),
          el(
            'div',
            { class: 'btn-row' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                onClick: () => {
                  KRY.openLeadModal(rem.lead_id);
                },
              },
              icon('board'),
              'Route / Assign',
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-outline',
                type: 'button',
                onClick: () => KRY.openSnoozeReminderModal(rem),
              },
              icon('clock'),
              'Snooze',
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-outline',
                type: 'button',
                onClick: () => KRY.openDismissReminderModal(rem),
              },
              icon('check'),
              'Dismiss',
            ),
          ),
        );
      });

      const strip = el(
        'div',
        { class: 'due-reminders-strip' },
        el(
          'div',
          { class: 'due-reminders-head' },
          el('h3', { text: `⏰ Due Follow-up Reminders (${dueReminders.length})` }),
          el('span', {
            class: 'small muted',
            text: 'Customers requested callback; take action or route to an executive',
          }),
        ),
        el('div', { class: 'due-reminders-list' }, ...rows),
      );
      wrap.appendChild(strip);
    }

    const kanban = el('div', { class: 'kanban' });
    Object.entries(board.columns).forEach(([key, lane]) => {
      const body = el('div', { class: 'lane-body' });
      if (!lane.items.length) {
        body.appendChild(el('div', { class: 'lane-empty', text: t('taskboard.laneEmpty') }));
      }
      lane.items.forEach((lead) => {
        const task = lead.pendingTask || lead.activeTask;
        body.appendChild(
          el(
            'button',
            {
              class: `lead-card priority-${lead.priority || 'Medium'}`,
              type: 'button',
              onClick: () => KRY.openLeadModal(lead.id),
            },
            el('span', { class: 'lead-name', text: lead.customer_name }),
            el('span', { class: 'lead-meta', text: `${lead.id} · ${lead.source}` }),
            el(
              'span',
              { class: 'lead-foot' },
              stageBadge(lead.stage),
              priorityBadge(lead.priority),
            ),
            task
              ? el(
                  'span',
                  { class: 'lead-foot' },
                  el('span', {
                    class: 'lead-meta',
                    text: `${KRY.deptLabel(task.department)} · ${task.assignee_name || '—'}`,
                  }),
                  dueBadge({ sla: task.sla, due_date: task.due_date, status: task.status }),
                )
              : null,
          ),
        );
      });
      kanban.appendChild(
        el(
          'section',
          { class: 'kanban-lane' },
          el(
            'div',
            { class: 'lane-head' },
            el('h3', { text: t(`lane.${key}`) }),
            el('span', { class: 'lane-count', text: String(lane.count) }),
          ),
          body,
        ),
      );
    });
    wrap.appendChild(kanban);
    return wrap;
  });

  /* ------------------------------------------------------------ Customer List */

  const leadFilters = (KRY.state.leadFilters = KRY.state.leadFilters || {
    q: '',
    stage: '',
    priority: '',
  });

  async function openDuplicatesModal() {
    let duplicateGroups;
    try {
      duplicateGroups = await api('/leads/duplicates');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    if (!duplicateGroups || duplicateGroups.length === 0) {
      toast('No duplicate phone records found.', 'info');
      return;
    }

    const content = el('div', { class: 'stack' });
    content.appendChild(
      el('p', {
        text: `Found ${duplicateGroups.length} phone number cluster(s) with multiple active leads.`,
      }),
    );

    for (const group of duplicateGroups) {
      const groupCard = el('div', { class: 'card mb-3 p-3' });
      groupCard.appendChild(
        el('h4', {
          class: 'card-title mb-2',
          text: `Phone: ${group.phone_normalized} (${group.count} leads)`,
        }),
      );

      const leadRows = group.leads.map((l) =>
        el(
          'div',
          { class: 'd-flex justify-content-between align-items-center py-2 border-bottom' },
          el(
            'div',
            {},
            el('strong', { text: l.customer_name }),
            el('span', { class: 'text-muted ms-2 mono', text: l.id }),
            el('span', { class: 'badge ms-2', text: l.stage }),
            el('div', {
              class: 'small text-muted',
              text: `Created: ${l.created_at} · Phone: ${l.phone}`,
            }),
          ),
          el('button', {
            class: 'btn btn-sm btn-outline',
            type: 'button',
            text: 'Retain & Merge Others',
            onClick: () => {
              const duplicatesToMerge = group.leads.filter((other) => other.id !== l.id);
              if (duplicatesToMerge.length === 0) return;
              openFormModal({
                title: `Merge into ${l.id}`,
                subtitle: `Retaining ${l.customer_name} (${l.id})`,
                submitLabel: 'Confirm Merge',
                fields: [
                  {
                    name: 'duplicate_lead_id',
                    label: 'Duplicate to Merge',
                    type: 'select',
                    required: true,
                    options: duplicatesToMerge.map((d) => ({
                      value: d.id,
                      label: `${d.customer_name} (${d.id}) - ${d.stage}`,
                    })),
                  },
                  {
                    name: 'reason',
                    label: 'Merge Reason',
                    type: 'textarea',
                    span2: true,
                    required: true,
                    placeholder: 'Why are these duplicate leads being merged?',
                  },
                ],
                onSubmit: async (values) => {
                  await api(`/leads/${l.id}/merge`, {
                    method: 'POST',
                    body: {
                      duplicate_lead_id: values.duplicate_lead_id,
                      reason: String(values.reason).trim(),
                      expected_version: l.version,
                    },
                  });
                  toast(`Merged lead ${values.duplicate_lead_id} into ${l.id}`, 'success');
                },
                onSuccess: () => {
                  KRY.renderRoute();
                },
              });
            },
          }),
        ),
      );

      groupCard.appendChild(el('div', { class: 'list-group' }, leadRows));
      content.appendChild(groupCard);
    }

    openModal({
      title: 'Duplicate Leads Review',
      body: content,
      actions: [
        el('button', { class: 'btn', type: 'button', text: 'Close', onClick: () => closeModal() }),
      ],
    });
  }
  KRY.openDuplicatesModal = openDuplicatesModal;

  registerPage('leads', async () => {
    const wrap = el('div', { class: 'stack' });
    const host = el('div', { class: 'card-body tight' });

    let currentCursor = null;
    let allLeads = [];
    let hasMore = false;

    async function load(reset = true) {
      if (reset) {
        currentCursor = null;
        allLeads = [];
        host.replaceChildren(el('div', { class: 'loading-block', text: t('common.loading') }));
      }
      const query = new URLSearchParams();
      if (leadFilters.q) query.set('q', leadFilters.q);
      if (leadFilters.stage) query.set('stage', leadFilters.stage);
      if (leadFilters.priority) query.set('priority', leadFilters.priority);
      query.set('limit', '50');
      if (currentCursor) query.set('cursor', currentCursor);

      try {
        const rows = await api(`/leads?${query.toString()}`);
        if (rows.length > 0) {
          const last = rows[rows.length - 1];
          currentCursor = btoa(JSON.stringify({ created_at: last.created_at, id: last.id }));
          allLeads = reset ? rows : allLeads.concat(rows);
          hasMore = rows.length === 50;
        } else {
          hasMore = false;
        }

        const table = dataTable(
          [
            t('common.customer'),
            t('common.phone'),
            t('common.stage'),
            t('common.priority'),
            t('common.owner'),
            t('common.updated'),
            '',
          ],
          allLeads.map((lead) => ({
            onClick: () => KRY.openLeadModal(lead.id),
            cells: [
              el(
                'div',
                {},
                el('div', { class: 'cell-title', text: lead.customer_name }),
                el('div', { class: 'cell-sub mono', text: lead.id }),
              ),
              el(
                'div',
                {},
                el('div', { text: lead.phone }),
                el('div', { class: 'cell-sub', text: lead.email || lead.location || '—' }),
              ),
              stageBadge(lead.stage),
              priorityBadge(lead.priority),
              lead.owner_name || '—',
              el('span', { title: fmtDateTime(lead.updated_at), text: timeAgo(lead.updated_at) }),
              el('button', {
                class: 'btn btn-sm',
                type: 'button',
                text: t('common.open'),
                onClick: (event) => {
                  event.stopPropagation();
                  KRY.openLeadModal(lead.id);
                },
              }),
            ],
          })),
          {
            emptyTitle: t('empty.noResults'),
            emptyMessage: t('empty.adjustFilters'),
            clickable: true,
          },
        );

        const container = el('div', { class: 'stack' }, table);
        if (hasMore) {
          container.appendChild(
            el(
              'div',
              { class: 'd-flex justify-content-center p-3' },
              el('button', {
                class: 'btn btn-outline',
                type: 'button',
                text: 'Load More',
                onClick: () => load(false),
              }),
            ),
          );
        }
        host.replaceChildren(container);
      } catch (err) {
        host.replaceChildren(el('div', { class: 'form-error', text: err.message }));
      }
    }

    const stageSelect = el(
      'select',
      {
        'aria-label': t('common.stage'),
        onChange: (event) => {
          leadFilters.stage = event.target.value;
          load();
        },
      },
      el('option', { value: '', text: t('leads.allStages'), selected: !leadFilters.stage }),
      KRY.STAGES.map((stage) =>
        el('option', {
          value: stage,
          text: KRY.stageLabel(stage),
          selected: leadFilters.stage === stage,
        }),
      ),
    );

    const prioritySelect = el(
      'select',
      {
        'aria-label': t('common.priority'),
        onChange: (event) => {
          leadFilters.priority = event.target.value;
          load();
        },
      },
      ['', 'Urgent', 'High', 'Medium', 'Low'].map((priority) =>
        el('option', {
          value: priority,
          text: priority ? KRY.priorityLabel(priority) : t('leads.allPriorities'),
          selected: leadFilters.priority === priority,
        }),
      ),
    );

    wrap.appendChild(
      pageHead(
        t('page.leads.title'),
        isCentral() ? t('leads.descCentral') : t('leads.descSpoke'),
        isCentral()
          ? [
              el(
                'div',
                { class: 'btn-row' },
                actionButton('Duplicates', 'copy', () => openDuplicatesModal()),
                actionButton('CSV', 'doc', () => KRY.download('/export/leads.csv', 'leads.csv')),
                actionButton('Excel', 'doc', () => KRY.download('/export/leads.xls', 'leads.xls')),
                actionButton(t('myday.newLead'), 'plus', () => KRY.openNewLead(), 'btn-primary'),
              ),
            ]
          : null,
      ),
    );

    wrap.appendChild(
      el(
        'section',
        { class: 'card' },
        toolbar([
          el(
            'div',
            { class: 'field grow' },
            searchInput(t('leads.searchPlaceholder'), leadFilters.q, (value) => {
              leadFilters.q = value;
              load();
            }),
          ),
          el('div', { class: 'field' }, el('span', { text: t('common.stage') }), stageSelect),
          el('div', { class: 'field' }, el('span', { text: t('common.priority') }), prioritySelect),
        ]),
        host,
      ),
    );

    await load();
    return wrap;
  });

  /* -------------------------------------------------------- New lead wizard */

  function sourceOptions() {
    return [
      { value: 'Website', label: t('newLead.sourceWebsite'), icon: 'globe' },
      { value: 'Meta Ads', label: t('newLead.sourceMeta'), icon: 'users' },
      { value: 'Google Ads', label: t('newLead.sourceGoogle'), icon: 'search' },
      { value: 'Reference', label: t('newLead.sourceReference'), icon: 'flag' },
      { value: 'Walk-in', label: t('newLead.sourceWalkIn'), icon: 'home' },
      { value: 'Phone call', label: t('newLead.sourceCall'), icon: 'phone' },
    ];
  }

  function workTypeOptions() {
    return [
      {
        value: 'Interior',
        label: t('newLead.workInterior'),
        description: t('newLead.workInteriorDesc'),
        icon: 'home',
      },
      {
        value: 'Construction',
        label: t('newLead.workConstruction'),
        description: t('newLead.workConstructionDesc'),
        icon: 'users',
      },
      {
        value: 'Design',
        label: t('newLead.workDesign'),
        description: t('newLead.workDesignDesc'),
        icon: 'doc',
      },
      {
        value: 'Purchase',
        label: t('newLead.workPurchase'),
        description: t('newLead.workPurchaseDesc'),
        icon: 'folder',
      },
    ];
  }

  async function openNewLead() {
    let employees = [];
    try {
      employees = await getEmployees();
    } catch {
      employees = [];
    }
    const callers = employees.filter(
      (employee) => employee.role === 'TELECALLER' && employee.active !== 0,
    );

    const steps = [
      {
        titleKey: 'newLead.step1',
        render(data) {
          data.source = data.source || 'Website';
          data.channel = data.channel || 'Online';
          const grid = el(
            'div',
            { class: 'form-grid' },
            field({
              name: 'customer_name',
              label: t('newLead.name'),
              placeholder: t('newLead.namePlaceholder'),
              value: data.customer_name || '',
              required: true,
            }),
            field({
              name: 'phone',
              label: t('newLead.phone'),
              placeholder: t('newLead.phonePlaceholder'),
              value: data.phone || '',
              inputmode: 'tel',
              required: true,
            }),
            field({
              name: 'location',
              label: t('newLead.location'),
              placeholder: t('newLead.locationPlaceholder'),
              value: data.location || '',
            }),
            el(
              'div',
              { class: 'field span-2' },
              el('span', { text: t('newLead.source') }),
              choiceCards(
                sourceOptions(),
                data.source,
                (value) => {
                  data.source = value;
                },
                { compact: true },
              ),
            ),
            el(
              'div',
              { class: 'span-2' },
              moreDetails([
                el(
                  'div',
                  { class: 'form-grid' },
                  field({
                    name: 'email',
                    label: t('newLead.email'),
                    type: 'email',
                    placeholder: 'name@example.com',
                    value: data.email || '',
                  }),
                  labeled(
                    t('newLead.channel'),
                    el(
                      'select',
                      { name: 'channel' },
                      el('option', {
                        value: 'Online',
                        text: t('newLead.online'),
                        selected: data.channel !== 'Offline',
                      }),
                      el('option', {
                        value: 'Offline',
                        text: t('newLead.offline'),
                        selected: data.channel === 'Offline',
                      }),
                    ),
                  ),
                ),
              ]),
            ),
          );
          return grid;
        },
        collect(data, root) {
          data.customer_name = String(valueOf(root, 'customer_name')).trim();
          data.phone = String(valueOf(root, 'phone')).trim();
          data.location = String(valueOf(root, 'location')).trim();
          data.email = String(valueOf(root, 'email')).trim();
          data.channel = valueOf(root, 'channel') || 'Online';
          if (data.customer_name.length < 2) return t('newLead.errName');
          const digits = data.phone.replace(/\D/g, '');
          if (digits.length < 10 || digits.length > 15) return t('newLead.errPhone');
          if (!data.source) return t('newLead.errSource');
          return null;
        },
      },
      {
        titleKey: 'newLead.step2',
        render(data) {
          data.work_type = data.work_type || 'Interior';
          data.priority = data.priority || 'Medium';
          return el(
            'div',
            { class: 'stack' },
            el('p', { class: 'wizard-label', text: t('newLead.workType') }),
            choiceCards(workTypeOptions(), data.work_type, (value) => {
              data.work_type = value;
            }),
            el(
              'div',
              { class: 'form-grid' },
              field({
                name: 'area',
                label: t('newLead.area'),
                placeholder: t('newLead.areaPlaceholder'),
                value: data.area || '',
              }),
              field({
                name: 'budget_range',
                label: t('newLead.budget'),
                placeholder: t('newLead.budgetPlaceholder'),
                value: data.budget_range || '',
              }),
              field({
                name: 'timeline',
                label: t('newLead.timeline'),
                placeholder: t('newLead.timelinePlaceholder'),
                value: data.timeline || '',
              }),
              el(
                'div',
                { class: 'field' },
                el('span', { text: t('newLead.priority') }),
                chipRow(
                  ['Low', 'Medium', 'High', 'Urgent'].map((value) => ({
                    value,
                    label: KRY.priorityLabel(value),
                  })),
                  data.priority,
                  (value) => {
                    data.priority = value;
                  },
                ),
              ),
              field({
                name: 'requirement',
                label: t('newLead.requirement'),
                type: 'textarea',
                rows: 3,
                span2: true,
                placeholder: t('newLead.requirementPlaceholder'),
                value: data.requirement || '',
              }),
            ),
          );
        },
        collect(data, root) {
          data.area = String(valueOf(root, 'area')).trim();
          data.budget_range = String(valueOf(root, 'budget_range')).trim();
          data.timeline = String(valueOf(root, 'timeline')).trim();
          data.requirement = String(valueOf(root, 'requirement')).trim();
          if (!data.work_type) data.work_type = 'Interior';
          if (!data.priority) data.priority = 'Medium';
          if (!data.requirement) {
            const label = workTypeOptions().find((option) => option.value === data.work_type);
            data.requirement = `${label ? label.label : data.work_type}${data.area ? ` · ${data.area}` : ''}`;
          }
          return null;
        },
      },
      {
        titleKey: 'newLead.step3',
        render(data) {
          const body = el('div', { class: 'stack' });
          body.appendChild(
            el(
              'div',
              { class: 'review-box' },
              kv([
                [t('common.customer'), data.customer_name],
                [t('common.phone'), data.phone],
                [t('common.location'), data.location || '—'],
                [t('common.requirement'), data.requirement],
                [t('newLead.prioritySummary'), KRY.priorityLabel(data.priority)],
              ]),
            ),
          );
          body.appendChild(el('p', { class: 'wizard-label', text: t('newLead.assignTitle') }));
          body.appendChild(el('p', { class: 'small muted', text: t('newLead.assignHelp') }));

          if (!callers.length) {
            body.appendChild(el('p', { class: 'form-note', text: t('newLead.noCallers') }));
            data.telecaller_id = '';
            return body;
          }

          const options = [
            { value: '', label: t('newLead.assignNone'), icon: 'clock' },
            ...callers.map((caller) => ({
              value: caller.id,
              label: caller.name,
              description: KRY.roleLabel(caller.role),
              icon: 'phone',
            })),
          ];
          body.appendChild(
            choiceCards(
              options,
              data.telecaller_id || '',
              (value) => {
                data.telecaller_id = value;
              },
              { compact: true },
            ),
          );
          return body;
        },
        collect() {
          return null;
        },
      },
    ];

    openWizard({
      title: t('newLead.title'),
      subtitle: t('newLead.subtitle'),
      steps,
      submitLabel: t('newLead.create'),
      size: '',
      async onComplete(data) {
        const payload = {
          customer_name: data.customer_name,
          phone: data.phone,
          source: data.source,
          channel: data.channel || 'Online',
          priority: data.priority || 'Medium',
          location: data.location || undefined,
          area: data.area || undefined,
          budget_range: data.budget_range || undefined,
          timeline: data.timeline || undefined,
          requirement: data.requirement || undefined,
          project_type: ['construction', 'interior', 'architecture'].includes(
            String(data.work_type).toLowerCase(),
          )
            ? String(data.work_type).toLowerCase()
            : undefined,
          city: data.city || data.location || undefined,
          area_sqft: data.area_sqft ? Number(data.area_sqft) : parseFloat(data.area) || undefined,
          budget_band: data.budget_band || data.budget_range || undefined,
        };
        if (data.email) payload.email = data.email;
        const created = await api('/leads', { method: 'POST', body: payload });

        let assignedName = '';
        if (data.telecaller_id) {
          const caller = callers.find((entry) => entry.id === data.telecaller_id);
          try {
            await api(`/leads/${created.id}/assign-telecaller`, {
              method: 'POST',
              body: {
                telecaller_id: data.telecaller_id,
                instructions: `${t('assign.briefPlaceholder')} (${data.requirement})`,
              },
            });
            assignedName = caller ? caller.name : '';
          } catch (err) {
            toast(`${created.id}: ${err.message}`, 'error');
          }
        }

        toast(
          assignedName
            ? t('newLead.createdAssigned', { id: created.id, name: assignedName })
            : t('newLead.created', { id: created.id }),
          'success',
        );
        KRY.refreshNotifications();
        KRY.renderRoute();
      },
    });
  }
  KRY.openNewLead = openNewLead;

  /* --------------------------------------------------------- Send-to-a-team */

  function routeWorkKinds() {
    return [
      {
        value: 'Interior',
        label: t('route.workInterior'),
        description: t('route.workInteriorDesc'),
        icon: 'home',
        department: 'Sales',
        taskType: 'SALES_REVIEW',
        brief: t('route.briefInterior'),
      },
      {
        value: 'Construction',
        label: t('route.workConstruction'),
        description: t('route.workConstructionDesc'),
        icon: 'users',
        department: 'Technical',
        taskType: 'SITE_VISIT',
        brief: t('route.briefConstruction'),
      },
      {
        value: 'Design',
        label: t('route.workDesign'),
        description: t('route.workDesignDesc'),
        icon: 'doc',
        department: 'Design',
        taskType: 'DESIGN_PREPARATION',
        brief: t('route.briefDesign'),
      },
      {
        value: 'Purchase',
        label: t('route.workPurchase'),
        description: t('route.workPurchaseDesc'),
        icon: 'folder',
        department: 'Purchase',
        taskType: 'MATERIAL_CHECK',
        brief: t('route.briefPurchase'),
      },
      {
        value: 'Costing',
        label: t('route.workCosting'),
        description: t('route.workCostingDesc'),
        icon: 'rupee',
        department: 'Accounts',
        taskType: 'COSTING_ESTIMATE',
        brief: t('route.briefCosting'),
      },
    ];
  }

  async function openRouteWizard(lead) {
    let employees = [];
    try {
      employees = await getEmployees();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const kinds = routeWorkKinds();

    function kindFor(data) {
      return kinds.find((kind) => kind.value === data.work_kind) || kinds[0];
    }

    function peopleFor(kind) {
      const config = DEPT_CONFIG[kind.department];
      return employees.filter(
        (employee) => config && config.roles.includes(employee.role) && employee.active !== 0,
      );
    }

    const steps = [
      {
        titleKey: 'route.step1',
        render(data) {
          return el(
            'div',
            { class: 'stack' },
            el('p', { class: 'wizard-label', text: t('route.subtitle') }),
            choiceCards(kinds, data.work_kind || '', (value) => {
              data.work_kind = value;
              const kind = kindFor(data);
              const people = peopleFor(kind);
              data.assigned_to = people[0] ? people[0].id : '';
              data.task_type = kind.taskType;
              data.brief = kind.brief;
              if (kind.department === 'Sales') {
                const sv = (lead.siteVisits && lead.siteVisits[0]) || null;
                if (sv && Number(sv.estimated_cost) > 0) {
                  data.brief = `[Site Inspection by ${sv.engineer_name || 'Site Engineer'}]: Overall Construction Cost: ₹${Number(sv.estimated_cost).toLocaleString('en-IN')} | Scope: ${sv.scope_details || lead.requirement || 'Construction'} | Timeline: ${sv.estimated_timeline || 'Standard'} | Sales Advice: ${sv.sales_advice || 'Negotiate based on engineer ground assessment'}. Review ground report, prepare quotation and conduct negotiation with client.`;
                }
              }
            }),
          );
        },
        collect(data) {
          if (!data.work_kind) return t('wizard.required');
          return null;
        },
      },
      {
        titleKey: 'route.step2',
        render(data) {
          const kind = kindFor(data);
          const people = peopleFor(kind);
          if (!data.assigned_to && people.length) data.assigned_to = people[0].id;
          data.due_choice = data.due_choice || '2days';
          data.sla_hours =
            data.sla_hours ||
            (data.due_choice === 'today' ? 24 : data.due_choice === 'week' ? 168 : 48);

          const body = el('div', { class: 'stack' });
          body.appendChild(
            el(
              'div',
              { class: 'review-strip' },
              badge(KRY.deptLabel(kind.department), 'brand'),
              el('span', { class: 'small muted', text: kind.description }),
            ),
          );
          body.appendChild(el('p', { class: 'wizard-label', text: t('route.person') }));
          body.appendChild(el('p', { class: 'small muted', text: t('route.personHelp') }));

          if (!people.length) {
            body.appendChild(el('p', { class: 'form-error', text: t('route.noPerson') }));
          } else {
            body.appendChild(
              choiceCards(
                people.map((employee) => ({
                  value: employee.id,
                  label: employee.name,
                  description: KRY.roleLabel(employee.role),
                  icon: 'users',
                })),
                data.assigned_to,
                (value) => {
                  data.assigned_to = value;
                },
                { compact: true },
              ),
            );
          }

          body.appendChild(el('p', { class: 'wizard-label', text: t('route.when') }));
          body.appendChild(
            chipRow(
              [
                { value: 'today', label: t('route.whenToday') },
                { value: '2days', label: t('route.when2Days') },
                { value: 'week', label: t('route.whenWeek') },
                { value: 'custom', label: t('route.whenCustom') },
              ],
              data.due_choice,
              (value) => {
                data.due_choice = value;
                data.sla_hours = value === 'today' ? 24 : value === 'week' ? 168 : 48;
              },
            ),
          );
          body.appendChild(
            moreDetails([
              el(
                'div',
                { class: 'form-grid' },
                field({
                  name: 'due_date',
                  label: t('route.dueDate'),
                  type: 'date',
                  value: data.custom_due || '',
                }),
                field({
                  name: 'sla_hours',
                  label: t('route.slaHours'),
                  type: 'number',
                  min: 1,
                  max: 720,
                  value: data.sla_hours || 48,
                }),
              ),
            ]),
          );
          return body;
        },
        collect(data, root) {
          if (!data.assigned_to) return t('route.noPerson');
          const kind = kindFor(data);
          const dueMap = { today: 0, '2days': 2, week: 7 };
          const slaMap = { today: 24, '2days': 48, week: 168 };
          if (data.due_choice === 'custom') {
            const custom = String(valueOf(root, 'due_date'));
            data.due_date = custom || KRY.localISO(2);
            const start = KRY.parseDate(KRY.localISO(0)).getTime();
            const end = KRY.parseDate(data.due_date).getTime();
            data.sla_hours = Math.max(
              1,
              Math.min(720, Math.round((end - start) / 3_600_000) || 48),
            );
            const customSla = Number(valueOf(root, 'sla_hours'));
            if (Number.isFinite(customSla) && customSla > 0) data.sla_hours = customSla;
          } else {
            data.due_date = KRY.localISO(dueMap[data.due_choice] ?? 2);
            data.sla_hours = slaMap[data.due_choice] || 48;
          }
          data.task_type = kind.taskType;
          data.department = kind.department;
          return null;
        },
      },
      {
        titleKey: 'route.step3',
        render(data) {
          const kind = kindFor(data);
          const person = employees.find((employee) => employee.id === data.assigned_to);
          const body = el('div', { class: 'stack' });
          body.appendChild(
            el(
              'div',
              { class: 'review-box' },
              kv([
                [
                  t('common.customer'),
                  `${lead.customer_name || lead.id} · ${KRY.stageLabel(lead.stage)}`,
                ],
                [t('route.workSummary'), kind.label],
                [t('route.teamSummary'), KRY.deptLabel(kind.department)],
                [t('route.personSummary'), person ? person.name : '—'],
                [t('route.dueSummary'), fmtDate(data.due_date || KRY.localISO(2))],
              ]),
            ),
          );
          body.appendChild(
            field({
              name: 'brief',
              label: t('route.brief'),
              type: 'textarea',
              rows: 4,
              required: true,
              value: data.brief || kind.brief,
              placeholder: t('route.briefPlaceholder'),
              hint: t('route.briefHint'),
            }),
          );
          body.appendChild(
            el(
              'label',
              { class: 'checkbox-row' },
              el('input', {
                type: 'checkbox',
                name: 'allow_customer_contact',
                checked: Boolean(data.allow_customer_contact),
              }),
              el('span', { text: 'Allow this assignee to contact the customer for this task' }),
            ),
          );
          return body;
        },
        collect(data, root) {
          data.allow_customer_contact = Boolean(valueOf(root, 'allow_customer_contact'));
          data.brief = String(valueOf(root, 'brief')).trim();
          if (!data.brief) return t('wizard.required');
          return null;
        },
      },
    ];

    openWizard({
      title: t('route.title'),
      subtitle: t('route.leadLine', {
        customer: lead.customer_name || lead.id,
        stage: KRY.stageLabel(lead.stage),
      }),
      steps,
      submitLabel: t('route.send'),
      size: '',
      async onComplete(data) {
        const kind = kindFor(data);
        const result = await api(`/leads/${lead.id}/route`, {
          method: 'POST',
          body: {
            allow_customer_contact: Boolean(data.allow_customer_contact),
            department: kind.department,
            assigned_to: data.assigned_to,
            task_type: kind.taskType,
            brief: data.brief,
            due_date: data.due_date,
            sla_hours: data.sla_hours,
            expected_version: lead.version,
          },
        });
        toast(
          t('route.sent', { team: KRY.deptLabel(kind.department), task: result.task_id }),
          'success',
        );
        KRY.refreshNotifications();
        KRY.renderRoute();
      },
    });
  }
  KRY.openRouteWizard = openRouteWizard;

  /* ------------------------------------------------------- Assign telecaller */

  async function openAssignTelecaller(lead) {
    let employees;
    try {
      employees = await getEmployees();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const options = optionsFor(
      employees,
      (employee) => employee.role === 'TELECALLER' && employee.active !== 0,
      { placeholder: t('common.select') },
    );
    if (options.length <= 1) {
      toast(t('newLead.noCallers'), 'error');
      return;
    }

    openFormModal({
      title: t('assign.title'),
      subtitle: `${lead.customer_name || lead.id} · ${lead.id}`,
      submitLabel: t('assign.submit'),
      fields: [
        {
          name: 'telecaller_id',
          label: t('assign.caller'),
          type: 'select',
          required: true,
          options,
        },
        {
          name: 'instructions',
          label: t('assign.brief'),
          type: 'textarea',
          span2: true,
          placeholder: t('assign.briefPlaceholder'),
        },
      ],
      onSubmit: async (values) => {
        if (!values.telecaller_id) throw new Error(t('assign.caller'));
        const result = await api(`/leads/${lead.id}/assign-telecaller`, {
          method: 'POST',
          body: { ...values, expected_version: lead.version },
        });
        const caller = employees.find((employee) => employee.id === values.telecaller_id);
        toast(
          `${t('assign.done', { name: caller ? caller.name : '' })} · ${result.task_id}`,
          'success',
        );
      },
      onSuccess: () => {
        KRY.openLeadModal(lead.id);
        KRY.refreshNotifications();
        KRY.renderRoute();
      },
    });
  }
  KRY.openAssignTelecaller = openAssignTelecaller;

  /* ------------------------------------------------------------ Lead actions */

  function advanceToQuotation(lead) {
    confirmAction({
      title: t('lead.advanceTitle'),
      message: t('lead.advanceMessage'),
      confirmLabel: t('lead.advanceTitle'),
      onConfirm: async () => {
        await api(`/leads/${lead.id}/advance-to-quotation`, {
          method: 'POST',
          body: { expected_version: lead.version },
        });
        toast(t('lead.advanced'), 'success');
        KRY.openLeadModal(lead.id);
        KRY.refreshNotifications();
        KRY.renderRoute();
      },
    });
  }

  function openCloseLead(lead) {
    openFormModal({
      title: t('lead.closeTitle'),
      subtitle: `${lead.customer_name || lead.id} · ${lead.id}`,
      submitLabel: t('lead.apply'),
      note: t('lead.reasonPlaceholder'),
      fields: [
        {
          name: 'stage',
          label: t('lead.outcome'),
          type: 'select',
          value: 'Lost',
          options: [
            { value: 'Lost', label: t('lead.outcomeLost') },
            { value: 'Nurture', label: t('lead.outcomeNurture') },
          ],
        },
        {
          name: 'remarks',
          label: t('lead.reason'),
          type: 'textarea',
          span2: true,
          required: true,
          placeholder: t('lead.reasonPlaceholder'),
        },
      ],
      onSubmit: async (values) => {
        if (!String(values.remarks || '').trim()) throw new Error(t('lead.reason'));
        await api(`/leads/${lead.id}/stage`, {
          method: 'PATCH',
          body: {
            stage: values.stage,
            remarks: String(values.remarks).trim(),
            expected_version: lead.version,
          },
        });
        toast(t('lead.marked', { stage: KRY.stageLabel(values.stage) }), 'success');
      },
      onSuccess: () => {
        KRY.openLeadModal(lead.id);
        KRY.renderRoute();
      },
    });
  }

  function openLeadNote(lead) {
    openFormModal({
      title: t('lead.noteTitle'),
      subtitle: `${lead.customer_name || lead.id} · ${lead.id}`,
      submitLabel: t('lead.noteSubmit'),
      fields: [
        {
          name: 'remarks',
          label: t('lead.noteLabel'),
          type: 'textarea',
          span2: true,
          required: true,
          placeholder: t('lead.notePlaceholder'),
        },
      ],
      onSubmit: async (values) => {
        if (!String(values.remarks || '').trim()) throw new Error(t('lead.noteLabel'));
        await api(`/leads/${lead.id}/note`, {
          method: 'POST',
          body: { remarks: String(values.remarks).trim() },
        });
        toast(t('lead.noteDone'), 'success');
      },
      onSuccess: () => KRY.openLeadModal(lead.id),
    });
  }

  /* ------------------------------------------------------------ Lead workspace */

  async function openLeadModal(id) {
    let data;
    try {
      data = await api(`/leads/${id}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const lead = data.lead;
    const body = el('div', { class: 'stack' });

    if (data.reminders && data.reminders.length) {
      const activeRem = data.reminders.find((r) => ['PENDING', 'TRIGGERED'].includes(r.status));
      if (activeRem) {
        const isTriggered = activeRem.status === 'TRIGGERED';
        const reminderBanner = el(
          'div',
          {
            class: 'due-reminders-strip',
            style: isTriggered ? 'border-left-color: #ef4444; background: #fff5f5;' : '',
          },
          el(
            'div',
            { class: 'due-reminders-head' },
            el('strong', {
              text: isTriggered
                ? '⏰ Follow-up Callback is DUE NOW'
                : `⏰ Scheduled Follow-up: ${fmtDateTime(activeRem.due_at)}`,
            }),
            badge(activeRem.status, isTriggered ? 'danger' : 'warn'),
          ),
          el('div', { class: 'small muted', text: activeRem.reason || 'Callback requested' }),
          el(
            'div',
            { class: 'btn-row', style: 'margin-top: 8px;' },
            el(
              'button',
              {
                class: 'btn btn-sm btn-outline',
                type: 'button',
                onClick: () => KRY.openSnoozeReminderModal(activeRem),
              },
              icon('clock'),
              'Snooze',
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-outline',
                type: 'button',
                onClick: () => KRY.openDismissReminderModal(activeRem),
              },
              icon('check'),
              'Dismiss',
            ),
          ),
        );
        body.appendChild(reminderBanner);
      }
    }

    body.appendChild(
      el(
        'div',
        { class: 'grid grid-2' },
        card(
          t('lead.customer'),
          lead.source,
          kv([
            ['ID', el('span', { class: 'mono', text: lead.id })],
            [t('common.phone'), lead.phone],
            [t('common.email'), lead.email || '—'],
            [t('common.location'), lead.location || '—'],
            [t('lead.area'), lead.area || '—'],
            [t('lead.channel'), lead.channel],
            [t('common.priority'), priorityBadge(lead.priority)],
            [t('common.stage'), stageBadge(lead.stage)],
            [t('common.owner'), lead.owner_name || '—'],
          ]),
        ),
        card(
          t('common.requirement'),
          `${t('common.created')} ${fmtDateTime(lead.created_at)}`,
          el(
            'div',
            { class: 'stack' },
            kv([
              [t('lead.budget'), lead.budget_range || '—'],
              [t('lead.timeline'), lead.timeline || '—'],
              ['Project Type', lead.project_type || '—'],
              ['City', lead.city || '—'],
              ['Area (Sqft)', lead.area_sqft ? `${lead.area_sqft} sqft` : '—'],
              ['Budget Band', lead.budget_band || '—'],
              [t('lead.telecaller'), lead.telecaller_name || '—'],
              [t('lead.sales'), lead.bdm_name || '—'],
              [t('lead.siteEngineer'), lead.engineer_name || '—'],
              [t('lead.architect'), lead.architect_name || '—'],
              [t('lead.projectManager'), lead.pm_name || '—'],
              [t('lead.workOrderValue'), lead.wo_value ? money(lead.wo_value) : '—'],
            ]),
            lead.requirement ? el('p', { class: 'small muted', text: lead.requirement }) : null,
            lead.lost_reason
              ? el('p', {
                  class: 'form-error',
                  text: `${t('lead.lostReason')}: ${lead.lost_reason}`,
                })
              : null,
          ),
        ),
      ),
    );

    const submittedTasks = data.tasks.filter((task) => task.status === 'Submitted');
    const activeTasks = data.tasks.filter((task) =>
      ['Assigned', 'In Progress'].includes(task.status),
    );
    const reviewedSalesTask = data.tasks.some(
      (task) => task.department === 'Sales' && task.status === 'Reviewed',
    );

    const actions = [];
    if (isCentral()) {
      if (['New', 'Nurture', 'Follow-up Required'].includes(lead.stage)) {
        actions.push(
          actionButton(
            t('action.assignTelecaller'),
            'phone',
            () => openAssignTelecaller(lead),
            'btn-primary',
          ),
        );
      }
      if (
        lead.stage === 'Response Received' ||
        (lead.stage === 'Update Received' && !submittedTasks.length && !activeTasks.length)
      ) {
        actions.push(
          actionButton(
            t('action.routeLead'),
            'board',
            () => openRouteWizard({ ...lead, siteVisits: data.siteVisits }),
            'btn-primary',
          ),
        );
      }
      if (submittedTasks.length) {
        actions.push(
          actionButton(
            `${t('action.reviewSubmission')} (${submittedTasks.length})`,
            'shield',
            () => KRY.openTaskReview(submittedTasks[0]),
            'btn-dark',
          ),
        );
      }
      if (
        lead.stage === 'Update Received' &&
        !submittedTasks.length &&
        !activeTasks.length &&
        reviewedSalesTask
      ) {
        actions.push(
          actionButton(
            t('action.prepareQuotation'),
            'rupee',
            () => advanceToQuotation(lead),
            'btn-dark',
          ),
        );
      }
      if (data.workOrder && data.workOrder.status === 'Pending Admin Approval') {
        actions.push(
          actionButton(
            t('action.approveWorkOrder'),
            'check',
            () => KRY.openWorkOrderApproval(data.workOrder),
            'btn-primary',
          ),
        );
      }
      if (!['Closed', 'Lost'].includes(lead.stage)) {
        actions.push(actionButton(t('action.markOutcome'), 'flag', () => openCloseLead(lead)));
      }
      actions.push(actionButton(t('lead.addNote'), 'plus', () => openLeadNote(lead)));
      if (data.project) {
        actions.push(
          actionButton(t('lead.openProject'), 'folder', () =>
            KRY.openProjectModal(data.project.id),
          ),
        );
      }
    } else if (
      lead.assigned_telecaller === KRY.state.user.id &&
      lead.stage === 'With Telecaller' &&
      typeof KRY.openTelecallerForm === 'function'
    ) {
      const activeTask = (data.tasks || []).find(
        (t) =>
          t.task_type === 'TELECALLER_ENQUIRY' && ['Assigned', 'In Progress'].includes(t.status),
      );
      actions.push(
        actionButton(
          t('call.title'),
          'phone',
          () =>
            KRY.openTelecallerForm({
              ...lead,
              task_id: activeTask ? activeTask.id : null,
              tasks: data.tasks,
            }),
          'btn-primary',
        ),
      );
    }

    if (actions.length) {
      body.appendChild(card(t('lead.actions'), null, el('div', { class: 'btn-row' }, actions)));
    }

    const taskList = data.tasks.length
      ? el(
          'div',
          { class: 'list' },
          data.tasks.map((task) =>
            el(
              'div',
              { class: 'list-item' },
              el('span', { class: 'list-icon' }, icon('check')),
              el(
                'div',
                { class: 'list-body' },
                el(
                  'div',
                  { class: 'between' },
                  el('span', {
                    class: 'list-title',
                    text: `${KRY.deptLabel(task.department)} · ${KRY.taskTypeLabel(task.task_type)}`,
                  }),
                  statusBadge(task.status),
                ),
                el('div', {
                  class: 'list-meta',
                  text: `${task.id} · ${task.assignee_name || '—'} · ${dueLabel({
                    sla: task.sla,
                    due_date: task.due_date,
                    status: task.status,
                  })}`,
                }),
                task.brief ? el('div', { class: 'small muted', text: task.brief }) : null,
                task.review_remarks
                  ? el('div', {
                      class: 'small',
                      text: `${t('task.review')}: ${task.review_remarks}`,
                    })
                  : null,
              ),
              el(
                'div',
                { class: 'btn-row' },
                dueBadge({ sla: task.sla, due_date: task.due_date, status: task.status }),
                el('button', {
                  class: 'btn btn-sm',
                  type: 'button',
                  text: t('common.open'),
                  onClick: () => KRY.openTaskModal(task.id),
                }),
              ),
            ),
          ),
        )
      : emptyState(t('lead.noTasks'), t('lead.noTasksHelp'));

    body.appendChild(card(t('lead.tasks'), null, taskList, { tight: true }));

    if (data.siteVisits && data.siteVisits.length) {
      data.siteVisits.forEach((visit) => {
        const estCost = Number(visit.estimated_cost) || 0;
        const civilCost = Number(visit.civil_cost) || 0;
        const intCost = Number(visit.interior_cost) || 0;
        const mepCost = Number(visit.mep_cost) || 0;
        const logCost = Number(visit.labor_logistics_cost) || 0;

        const costTiles =
          estCost > 0
            ? el(
                'div',
                {
                  class: 'cost-summary-card',
                  style:
                    'background: linear-gradient(135deg, #f0fdf4 0%, #e0f2fe 100%); border: 1px solid #bae6fd; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px;',
                },
                el(
                  'div',
                  {
                    style:
                      'display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px;',
                  },
                  el(
                    'div',
                    {},
                    el(
                      'span',
                      {
                        class: 'small muted',
                        style:
                          'text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; color: #0369a1;',
                      },
                      'Overall Estimated Construction Cost (कुल निर्माण खर्च):',
                    ),
                    el(
                      'div',
                      {
                        style:
                          'font-size: 26px; font-weight: 800; color: #047857; margin-top: 2px;',
                      },
                      `₹${estCost.toLocaleString('en-IN')}`,
                    ),
                  ),
                  el(
                    'div',
                    { style: 'text-align: right;' },
                    el(
                      'div',
                      {
                        class: 'badge',
                        style:
                          'background: #0284c7; color: #fff; font-size: 13px; font-weight: 600; padding: 4px 10px;',
                      },
                      `Timeline: ${visit.estimated_timeline || 'Standard'}`,
                    ),
                    visit.site_risk_level
                      ? el(
                          'div',
                          { class: 'small muted', style: 'margin-top: 4px;' },
                          `Site Risk Level: ${visit.site_risk_level}`,
                        )
                      : null,
                  ),
                ),
                el(
                  'div',
                  {
                    class: 'grid grid-4',
                    style:
                      'margin-top: 12px; gap: 8px; border-top: 1px solid #cbd5e1; padding-top: 10px;',
                  },
                  el(
                    'div',
                    {
                      style:
                        'background: rgba(255,255,255,0.85); padding: 8px 10px; border-radius: 6px;',
                    },
                    el('div', { class: 'small muted' }, 'Civil & Structure'),
                    el(
                      'div',
                      { style: 'font-weight: 700; color: #334155; margin-top: 2px;' },
                      civilCost > 0 ? `₹${civilCost.toLocaleString('en-IN')}` : '—',
                    ),
                  ),
                  el(
                    'div',
                    {
                      style:
                        'background: rgba(255,255,255,0.85); padding: 8px 10px; border-radius: 6px;',
                    },
                    el('div', { class: 'small muted' }, 'Finishing & Interior'),
                    el(
                      'div',
                      { style: 'font-weight: 700; color: #334155; margin-top: 2px;' },
                      intCost > 0 ? `₹${intCost.toLocaleString('en-IN')}` : '—',
                    ),
                  ),
                  el(
                    'div',
                    {
                      style:
                        'background: rgba(255,255,255,0.85); padding: 8px 10px; border-radius: 6px;',
                    },
                    el('div', { class: 'small muted' }, 'MEP (Elec/Plumb)'),
                    el(
                      'div',
                      { style: 'font-weight: 700; color: #334155; margin-top: 2px;' },
                      mepCost > 0 ? `₹${mepCost.toLocaleString('en-IN')}` : '—',
                    ),
                  ),
                  el(
                    'div',
                    {
                      style:
                        'background: rgba(255,255,255,0.85); padding: 8px 10px; border-radius: 6px;',
                    },
                    el('div', { class: 'small muted' }, 'Labour & Logistics'),
                    el(
                      'div',
                      { style: 'font-weight: 700; color: #334155; margin-top: 2px;' },
                      logCost > 0 ? `₹${logCost.toLocaleString('en-IN')}` : '—',
                    ),
                  ),
                ),
              )
            : null;

        const salesCallout = visit.sales_advice
          ? el(
              'div',
              {
                style:
                  'background: #fffbeb; border: 1.5px solid #fde68a; border-radius: 8px; padding: 12px 16px; margin: 10px 0; color: #92400e;',
              },
              el(
                'div',
                {
                  style:
                    'font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; font-size: 13.5px;',
                },
                icon('shield'),
                "Engineer's Negotiation Advice for Sales Team (सेल्स एवं नेगोशिएशन रणनीति):",
              ),
              el('p', {
                style: 'margin: 0; font-size: 13.5px; line-height: 1.5; color: #78350f;',
                text: visit.sales_advice,
              }),
            )
          : null;

        body.appendChild(
          card(
            `Site Inspection & Technical Cost Report · ${fmtDate(visit.visit_date)}`,
            `Inspected by ${visit.engineer_name || 'Site Engineer'}`,
            el(
              'div',
              { class: 'stack' },
              costTiles,
              salesCallout,
              kv(
                [
                  visit.scope_details ? ['Scope Details', visit.scope_details] : null,
                  visit.measurements ? ['Ground Measurements', visit.measurements] : null,
                  visit.site_condition ? ['Site Condition', visit.site_condition] : null,
                  visit.customer_feedback
                    ? ['Client Feedback on Site', visit.customer_feedback]
                    : null,
                  visit.recommendation
                    ? ['Engineering Recommendation', visit.recommendation]
                    : null,
                ].filter(Boolean),
              ),
              visit.technical_report
                ? el(
                    'div',
                    {
                      style:
                        'margin-top: 8px; background: #f8fafc; padding: 10px 14px; border-radius: 6px; border: 1px solid #e2e8f0;',
                    },
                    el(
                      'div',
                      { class: 'small muted', style: 'font-weight: 600;' },
                      'Technical Findings:',
                    ),
                    el('p', {
                      class: 'small',
                      style: 'white-space: pre-wrap; margin-top: 4px; line-height: 1.5;',
                      text: visit.technical_report,
                    }),
                  )
                : null,
            ),
          ),
        );
      });
    }

    if (data.quotations.length) {
      body.appendChild(
        card(
          t('lead.quotations'),
          null,
          el(
            'div',
            { class: 'list' },
            data.quotations.map((quote) =>
              el(
                'div',
                { class: 'list-item' },
                el('span', { class: 'list-icon' }, icon('rupee')),
                el(
                  'div',
                  { class: 'list-body' },
                  el(
                    'div',
                    { class: 'between' },
                    el('span', { class: 'list-title', text: `${quote.id} · v${quote.version}` }),
                    statusBadge(quote.status),
                  ),
                  el('div', {
                    class: 'list-meta',
                    text: `${money(quote.amount)} + ${t('quotes.tax')} ${money(quote.tax_amount || 0)} · ${quote.creator_name || '—'}`,
                  }),
                ),
              ),
            ),
          ),
          { tight: true },
        ),
      );
    }

    if (data.workOrder) {
      body.appendChild(
        card(
          t('lead.workOrder'),
          data.workOrder.id,
          kv([
            [t('common.status'), statusBadge(data.workOrder.status)],
            [t('common.amount'), money(data.workOrder.amount)],
            ['Customer approval', fmtDate(data.workOrder.customer_approval_date)],
            [t('common.created'), data.workOrder.creator_name || '—'],
          ]),
        ),
      );
    }

    if (data.project) {
      body.appendChild(
        card(
          t('lead.project'),
          `${data.project.id} · ${KRY.statusLabel(data.project.status)}`,
          el(
            'div',
            { class: 'stack' },
            el(
              'div',
              {},
              el(
                'div',
                { class: 'progress-meta' },
                el('span', { text: t('projects.progress') }),
                el('span', { text: `${data.project.progress}%` }),
              ),
              progressBar(data.project.progress),
            ),
            el(
              'div',
              { class: 'btn-row' },
              actionButton(t('lead.openProject'), 'folder', () =>
                KRY.openProjectModal(data.project.id),
              ),
            ),
          ),
        ),
      );
    }

    const photosHost = el(
      'div',
      { class: 'stack' },
      el('div', { class: 'small muted', text: t('common.loading') }),
    );
    body.appendChild(card(t('common.files'), null, photosHost));
    KRY.loadAttachments({ leadId: lead.id })
      .then((files) => {
        photosHost.replaceChildren(
          files.length ? KRY.attachmentGallery(files) : emptyState(t('common.noFiles'), ''),
        );
      })
      .catch(() => {
        photosHost.replaceChildren(emptyState(t('common.noFiles'), ''));
      });

    body.appendChild(card(t('lead.activity'), t('lead.activityHelp'), timeline(data.timeline)));

    openModal({
      title: lead.customer_name,
      subtitle: `${lead.id} · ${lead.source} · ${KRY.stageLabel(lead.stage)}`,
      size: 'wide',
      body,
      actions: [{ label: t('common.close'), onClick: closeModal }],
    });
  }
  KRY.openLeadModal = openLeadModal;
})();
