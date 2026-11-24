/**
 * Spoke work screens: the call list, My Work, site inspections (checklist,
 * photos and voice note) and drawing submissions.
 */
'use strict';

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
    toolbar,
    statusBadge,
    priorityBadge,
    badge,
    dueBadge,
    dueLabel,
    money,
    fmtDate,
    fmtDateTime,
    timeAgo,
    toast,
    openModal,
    openFormModal,
    openWizard,
    confirmAction,
    closeModal,
    getEmployees,
    field,
    moreDetails,
    choiceCards,
    isCentral,
    registerPage,
    navigate,
  } = KRY;
  const t = (key, vars) => KRY.t(key, vars);

  const CALL_OUTCOMES = ['Connected', 'No Answer', 'Busy', 'Callback Requested', 'Invalid Number'];
  const CALL_INTENTS = ['Hot', 'Warm', 'Cold', 'Not Interested'];
  const OUTCOME_KEYS = {
    Connected: 'call.outcomeConnected',
    'No Answer': 'call.outcomeNoAnswer',
    Busy: 'call.outcomeBusy',
    'Callback Requested': 'call.outcomeCallback',
    'Invalid Number': 'call.outcomeInvalid',
  };
  const INTENT_KEYS = {
    Hot: 'call.intentHot',
    Warm: 'call.intentWarm',
    Cold: 'call.intentCold',
    'Not Interested': 'call.intentNotInterested',
  };

  function valueOf(root, name) {
    const node = root.querySelector(`[name="${name}"]`);
    if (!node) return '';
    return node.type === 'checkbox' ? Boolean(node.checked) : (node.value ?? '');
  }

  function dueOf(task) {
    return { sla: task.sla, due_date: task.due_date, status: task.status };
  }

  /* -------------------------------------------------------------- Helpers & Modals */

  function copyText(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(str)
        .then(() => {
          toast(`Copied: ${str}`, 'info');
        })
        .catch(() => {
          toast(`Copied: ${str}`, 'info');
        });
    } else {
      toast(`Copied: ${str}`, 'info');
    }
  }

  function isValidMobile(phone) {
    if (!phone) return false;
    const digits = String(phone).replace(/\D/g, '');
    const ten =
      digits.length === 12 && digits.startsWith('91')
        ? digits.slice(2)
        : digits.length === 11 && digits.startsWith('0')
          ? digits.slice(1)
          : digits;
    return /^[6-9]\d{9}$/.test(ten);
  }

  function addDays(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function submitTaskFlow(task) {
    if (task.department === 'Technical') {
      openSiteInspection(task);
    } else if (task.department === 'Design') {
      openDesignSubmission(task);
    } else {
      openTaskSubmission(task);
    }
  }

  /* -------------------------------------------------------------- Calling Queue */

  registerPage('telecaller', async () => {
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(
      pageHead(
        t('nav.callingQueue'),
        t('telecaller.desc'),
        isCentral()
          ? [
              el(
                'button',
                { class: 'btn', type: 'button', onClick: () => navigate('taskboard') },
                icon('board'),
                t('nav.taskboard'),
              ),
            ]
          : null,
      ),
    );

    const host = el('div', { class: 'stack' });
    host.replaceChildren(el('div', { class: 'loading-block', text: t('common.loading') }));
    wrap.appendChild(host);

    try {
      const [queueData, historyData] = await Promise.all([
        api('/queues/calling'),
        api('/queues/calling/history').catch(() => ({ history: [], stats: {} })),
      ]);
      const allQueue = Array.isArray(queueData) ? queueData : queueData.queue || [];
      const history = historyData.history || [];
      const stats = historyData.stats || {};

      const totalInQueue = allQueue.length;
      const connectedCount = stats.connected_calls || 0;
      const urgentHighCount = allQueue.filter((t) =>
        ['Urgent', 'High'].includes(t.priority),
      ).length;
      const totalCallsMade = stats.total_calls || history.length;

      // Stat tiles
      const statTiles = el(
        'div',
        { class: 'stat-tiles' },
        el(
          'div',
          { class: 'stat-tile' },
          el('div', { class: 'stat-val', text: String(totalInQueue) }),
          el('div', { class: 'stat-lbl', text: 'Total in Queue' }),
        ),
        el(
          'div',
          { class: 'stat-tile' },
          el('div', { class: 'stat-val', style: 'color: #10b981;', text: String(connectedCount) }),
          el('div', { class: 'stat-lbl', text: 'Calls Spoken / Connected (बात हुई)' }),
        ),
        el(
          'div',
          { class: 'stat-tile' },
          el('div', { class: 'stat-val', text: String(urgentHighCount) }),
          el('div', { class: 'stat-lbl', text: 'Urgent / High Priority' }),
        ),
        el(
          'div',
          { class: 'stat-tile' },
          el('div', { class: 'stat-val', text: String(totalCallsMade) }),
          el('div', { class: 'stat-lbl', text: 'Total Calls Logged' }),
        ),
      );

      // Automatic Priority Sorting: Urgent > High > Medium > Low, then by Due Date (oldest first)
      const PRIORITY_WEIGHT = { Urgent: 1, High: 2, Medium: 3, Low: 4 };
      allQueue.sort((a, b) => {
        const pA = PRIORITY_WEIGHT[a.priority] || 5;
        const pB = PRIORITY_WEIGHT[b.priority] || 5;
        if (pA !== pB) return pA - pB;
        const dateA = a.due_date || a.created_at || '9999-99-99';
        const dateB = b.due_date || b.created_at || '9999-99-99';
        return dateA.localeCompare(dateB);
      });

      let currentTab = 'pending';
      let searchFilter = '';
      let priorityFilter = '';
      let outcomeFilter = '';

      const contentHost = el('div', { class: 'stack' });

      const pendingTabBtn = el(
        'button',
        {
          class: 'tab-link active',
          type: 'button',
          onClick: () => switchTab('pending'),
        },
        icon('phone'),
        `Pending Calls (${totalInQueue})`,
      );

      const historyTabBtn = el(
        'button',
        {
          class: 'tab-link',
          type: 'button',
          onClick: () => switchTab('history'),
        },
        icon('clock'),
        `Call History / Spoken (${history.length})`,
      );

      const tabBar = el('div', { class: 'tabs' }, pendingTabBtn, historyTabBtn);

      function switchTab(tab) {
        currentTab = tab;
        searchFilter = '';
        if (tab === 'pending') {
          pendingTabBtn.classList.add('active');
          historyTabBtn.classList.remove('active');
          renderPendingList();
        } else {
          historyTabBtn.classList.add('active');
          pendingTabBtn.classList.remove('active');
          renderHistoryList();
        }
      }

      function renderPendingList() {
        const searchInput = el('input', {
          type: 'search',
          placeholder: 'Search customer name, phone, city...',
          value: searchFilter,
          onInput: (e) => {
            searchFilter = e.target.value.trim();
            updatePendingCards();
          },
        });

        const prioritySelect = el(
          'select',
          {
            value: priorityFilter,
            onChange: (e) => {
              priorityFilter = e.target.value;
              updatePendingCards();
            },
          },
          el('option', { value: '', text: 'All Priorities' }),
          ['Urgent', 'High', 'Medium', 'Low'].map((p) => el('option', { value: p, text: p })),
        );

        const filterBar = toolbar([
          el('div', { class: 'field' }, searchInput),
          el('div', { class: 'field' }, prioritySelect),
          el('span', { class: 'spacer' }),
        ]);

        const cardsContainer = el('div', { class: 'grid grid-2' });

        function updatePendingCards() {
          cardsContainer.replaceChildren();
          const filtered = allQueue.filter((task) => {
            if (priorityFilter && task.priority !== priorityFilter) return false;
            if (searchFilter) {
              const q = searchFilter.toLowerCase();
              const matchName = (task.customer_name || '').toLowerCase().includes(q);
              const matchPhone = (task.customer_phone || task.phone || '').includes(q);
              const matchLocation = (task.location || '').toLowerCase().includes(q);
              const matchBrief = (task.brief || '').toLowerCase().includes(q);
              const matchSource = (task.lead_source || task.source || '').toLowerCase().includes(q);
              if (!matchName && !matchPhone && !matchLocation && !matchBrief && !matchSource)
                return false;
            }
            return true;
          });

          if (!filtered.length) {
            cardsContainer.replaceChildren(
              card(
                null,
                null,
                emptyState(
                  'All caught up! Great job, Telecaller.',
                  'Your calling queue has zero pending calls.',
                  'phone',
                ),
              ),
            );
            return;
          }

          filtered.forEach((task) => {
            const phone = task.customer_phone || task.phone || '';
            const valid = isValidMobile(phone);
            const attempts = task.call_attempts || task.contact_attempts || 0;
            const attemptTone = attempts >= 3 ? 'danger' : attempts > 0 ? 'warn' : 'neutral';
            const tel = KRY.telHref(phone);
            const priorityLower = (task.priority || 'medium').toLowerCase();
            const intent = task.customer_intent || null;

            const copyBtn = el(
              'button',
              {
                class: 'btn btn-sm btn-outline',
                type: 'button',
                title: 'Copy phone number',
                onClick: () => copyText(phone),
              },
              icon('doc'),
              'Copy',
            );

            let intentBadge = null;
            if (intent) {
              const intentClass = `badge-intent-${intent.toLowerCase().replace(/\s+/g, '-')}`;
              intentBadge = el('span', { class: `badge ${intentClass}`, text: intent });
            }

            const actions = el(
              'div',
              { class: 'calling-card-actions' },
              el(
                'button',
                {
                  class: 'btn btn-primary',
                  type: 'button',
                  onClick: () => openLogCallModal(task),
                },
                icon('check'),
                '✓ Called & Reported to Admin',
              ),
              tel
                ? el('a', { class: 'btn btn-outline', href: tel }, icon('phone'), 'Call Now')
                : null,
              el(
                'button',
                {
                  class: 'btn btn-outline',
                  type: 'button',
                  title: 'Snooze call to tomorrow or later',
                  onClick: () => openSnoozeTaskModal(task),
                },
                icon('clock'),
                '⏰ Snooze',
              ),
              el(
                'button',
                {
                  class: 'btn btn-sm',
                  type: 'button',
                  onClick: () => openTaskModal(task.id),
                },
                t('common.open'),
              ),
            );

            const phoneElement = tel
              ? el(
                  'span',
                  { class: 'inline-row' },
                  el('a', { class: 'phone-link', href: tel }, icon('phone'), phone),
                  copyBtn,
                )
              : el('span', { class: 'inline-row' }, el('strong', { text: phone || '—' }), copyBtn);

            cardsContainer.appendChild(
              el(
                'section',
                { class: `card calling-card priority-${priorityLower}` },
                el(
                  'div',
                  { class: 'calling-card-head' },
                  el(
                    'div',
                    {},
                    el('h2', { text: KRY.toTitleCase(task.customer_name || 'Customer') }),
                    el('p', {
                      class: 'mono small muted',
                      text: `${task.lead_id || ''} · ${task.id}`,
                    }),
                  ),
                  el(
                    'div',
                    { class: 'btn-row' },
                    intentBadge,
                    priorityBadge(task.priority),
                    badge(attempts === 0 ? '0 Attempts' : `${attempts} Attempts`, attemptTone),
                    !valid ? badge('Invalid Mobile', 'danger') : null,
                  ),
                ),
                el(
                  'div',
                  { class: 'card-body' },
                  el(
                    'div',
                    { class: 'stack' },
                    kv([
                      [t('common.phone'), phoneElement],
                      [
                        'Lead Source',
                        el('span', {
                          class: 'badge neutral',
                          text: task.lead_source || task.source || 'Direct',
                        }),
                      ],
                      [t('common.location'), task.location || task.area || '—'],
                      [t('common.requirement'), task.requirement || '—'],
                      [t('task.assignedBy'), task.creator_name || 'Admin Desk'],
                      [
                        'Status / SLA',
                        el(
                          'span',
                          { class: 'btn-row' },
                          dueBadge(dueOf(task)),
                          el('span', {
                            class: 'small muted',
                            text: KRY.formatRelativeTime(task.created_at),
                          }),
                        ),
                      ],
                    ]),
                    task.brief
                      ? el(
                          'div',
                          { class: 'form-note', style: 'margin-top: 8px;' },
                          el('strong', { text: "Admin's Brief: " }),
                          task.brief,
                        )
                      : null,
                    actions,
                  ),
                ),
              ),
            );
          });
        }

        updatePendingCards();
        contentHost.replaceChildren(filterBar, cardsContainer);
      }

      function renderHistoryList() {
        const historySearchInput = el('input', {
          type: 'search',
          placeholder: 'Search customer name, phone, notes...',
          value: searchFilter,
          onInput: (e) => {
            searchFilter = e.target.value.trim();
            updateHistoryCards();
          },
        });

        const outcomeSelect = el(
          'select',
          {
            value: outcomeFilter,
            onChange: (e) => {
              outcomeFilter = e.target.value;
              updateHistoryCards();
            },
          },
          el('option', { value: '', text: 'All Outcomes' }),
          el('option', { value: 'CONNECTED', text: 'Connected (बात हुई)' }),
          el('option', { value: 'CALLBACK_REQUESTED', text: 'Callback Requested' }),
          el('option', { value: 'NO_ANSWER', text: 'No Answer' }),
          el('option', { value: 'BUSY', text: 'Busy' }),
          el('option', { value: 'WRONG_NUMBER', text: 'Wrong Number' }),
        );

        const historyToolbar = toolbar([
          el('div', { class: 'field' }, historySearchInput),
          el('div', { class: 'field' }, outcomeSelect),
          el('span', { class: 'spacer' }),
        ]);

        const historyContainer = el('div', { class: 'stack' });

        function updateHistoryCards() {
          historyContainer.replaceChildren();
          const filteredHistory = history.filter((item) => {
            if (outcomeFilter && item.outcome !== outcomeFilter) return false;
            if (searchFilter) {
              const q = searchFilter.toLowerCase();
              const matchName = (item.customer_name || '').toLowerCase().includes(q);
              const matchPhone = (item.phone || '').includes(q);
              const matchNotes = (item.notes || '').toLowerCase().includes(q);
              const matchReq = (item.requirement_type || item.requirement || '')
                .toLowerCase()
                .includes(q);
              const matchLoc = (item.location_area || item.location || '')
                .toLowerCase()
                .includes(q);
              if (!matchName && !matchPhone && !matchNotes && !matchReq && !matchLoc) return false;
            }
            return true;
          });

          if (!filteredHistory.length) {
            historyContainer.replaceChildren(
              card(
                null,
                null,
                emptyState(
                  'No Call History Found',
                  'Logged call conversations and customer notes will appear here.',
                  'phone',
                ),
              ),
            );
            return;
          }

          filteredHistory.forEach((h) => {
            const isConnected = h.outcome === 'CONNECTED';
            const isCallback = h.outcome === 'CALLBACK_REQUESTED';
            const outcomeTone = isConnected ? 'success' : isCallback ? 'warn' : 'neutral';
            const outcomeLabel = isConnected
              ? '✓ Connected (बात हुई)'
              : isCallback
                ? `Callback (${h.next_action_date || 'Scheduled'})`
                : h.outcome
                  ? h.outcome.replace(/_/g, ' ')
                  : 'Call Logged';

            const phone = h.phone || '';
            const tel = KRY.telHref(phone);

            historyContainer.appendChild(
              el(
                'div',
                {
                  class: 'card',
                  style:
                    'border-left: 4px solid ' +
                    (isConnected ? '#10b981' : isCallback ? '#f59e0b' : 'var(--line)'),
                },
                el(
                  'div',
                  { class: 'card-body' },
                  el(
                    'div',
                    { class: 'stack', style: 'gap: 8px;' },
                    el(
                      'div',
                      {
                        style:
                          'display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px;',
                      },
                      el(
                        'div',
                        {},
                        el('h3', {
                          style: 'margin: 0;',
                          text: KRY.toTitleCase(h.customer_name || 'Customer'),
                        }),
                        el(
                          'div',
                          { class: 'small muted mono' },
                          `${h.lead_id || ''} · ${h.task_id || ''}`,
                        ),
                      ),
                      el(
                        'div',
                        { class: 'btn-row' },
                        badge(outcomeLabel, outcomeTone),
                        h.call_purpose
                          ? el('span', { class: 'badge neutral', text: h.call_purpose })
                          : null,
                        el('span', {
                          class: 'small muted',
                          text: h.created_at_ist || h.created_at,
                        }),
                      ),
                    ),
                    kv([
                      [
                        t('common.phone'),
                        phone
                          ? el(
                              'span',
                              { class: 'inline-row' },
                              tel
                                ? el('a', { class: 'phone-link', href: tel }, icon('phone'), phone)
                                : el('strong', { text: phone }),
                              el(
                                'button',
                                {
                                  class: 'btn btn-xs btn-outline',
                                  type: 'button',
                                  onClick: () => copyText(phone),
                                },
                                'Copy',
                              ),
                            )
                          : '—',
                      ],
                      ['Requirement / Type', h.requirement_type || h.requirement || '—'],
                      ['Budget', h.customer_budget || '—'],
                      ['Location', h.location_area || h.location || '—'],
                      [
                        'Discussion / Notes',
                        el(
                          'div',
                          {
                            class: 'form-note',
                            style:
                              'background: var(--surface-alt); padding: 8px; border-radius: 4px; font-size: 13px;',
                          },
                          h.notes || 'No notes entered',
                        ),
                      ],
                    ]),
                    el(
                      'div',
                      { class: 'btn-row', style: 'margin-top: 4px;' },
                      h.lead_id
                        ? el(
                            'button',
                            {
                              class: 'btn btn-sm btn-outline',
                              type: 'button',
                              onClick: () => KRY.openLeadModal(h.lead_id),
                            },
                            icon('doc'),
                            'View Customer Lead',
                          )
                        : null,
                      tel
                        ? el(
                            'a',
                            { class: 'btn btn-sm btn-primary', href: tel },
                            icon('phone'),
                            'Call Again',
                          )
                        : null,
                    ),
                  ),
                ),
              ),
            );
          });
        }

        updateHistoryCards();
        contentHost.replaceChildren(historyToolbar, historyContainer);
      }

      host.replaceChildren(statTiles, tabBar, contentHost);
      switchTab('pending');
    } catch (err) {
      host.replaceChildren(el('div', { class: 'form-error', text: err.message }));
    }

    return wrap;
  });

  /* -------------------------------------------------------------- Call Outcome Modal */

  function openLogCallModal(task) {
    let outcomeVal = 'CONNECTED';
    let purposeVal = 'Initial Enquiry';
    let requirementVal = 'Construction';
    let budgetVal = '15L-50L';
    let locationVal = task.customer_location || task.location || '';
    let notesVal = '';
    let durationMin = '2';
    let callbackDateVal = addDays(1);

    const dateField = el('input', {
      type: 'date',
      value: callbackDateVal,
      onChange: (e) => {
        callbackDateVal = e.target.value;
      },
    });

    const chipRow = el(
      'div',
      { class: 'quick-chips' },
      [
        { label: 'Tomorrow (+1d)', days: 1 },
        { label: 'In 3 Days (+3d)', days: 3 },
        { label: 'In 7 Days (+7d)', days: 7 },
        { label: 'In 14 Days (+14d)', days: 14 },
      ].map((chip) =>
        el(
          'button',
          {
            class: 'chip-btn',
            type: 'button',
            onClick: () => {
              callbackDateVal = addDays(chip.days);
              dateField.value = callbackDateVal;
            },
          },
          chip.label,
        ),
      ),
    );

    const callbackBlock = el(
      'div',
      { class: 'stack full-span', style: 'display: none; padding-top: 8px;' },
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Next Action Date / Callback Date' }),
        dateField,
      ),
      chipRow,
    );

    function updateOutcome(val) {
      outcomeVal = val;
      if (val === 'CALLBACK_REQUESTED') {
        callbackBlock.style.display = 'block';
      } else {
        callbackBlock.style.display = 'none';
      }
    }

    // 1. Call Outcome: Connected, Not Picked, Busy, Wrong Number
    const outcomeSelect = el(
      'select',
      {
        required: true,
        onChange: (e) => updateOutcome(e.target.value),
      },
      el('option', { value: 'CONNECTED', text: 'Connected (Spoke with customer)' }),
      el('option', { value: 'NO_ANSWER', text: 'Not Picked / No Answer' }),
      el('option', { value: 'BUSY', text: 'Busy / Waiting' }),
      el('option', { value: 'CALLBACK_REQUESTED', text: 'Callback Requested' }),
      el('option', { value: 'WRONG_NUMBER', text: 'Wrong Number / Invalid' }),
    );

    // 2. Call Purpose: Initial Enquiry, Requirement Gathering, Follow-up, Site Visit Request
    const purposeSelect = el(
      'select',
      {
        required: true,
        onChange: (e) => {
          purposeVal = e.target.value;
        },
      },
      el('option', { value: 'Initial Enquiry', text: 'Initial Enquiry' }),
      el('option', { value: 'Requirement Gathering', text: 'Requirement Gathering' }),
      el('option', { value: 'Follow-up', text: 'Follow-up' }),
      el('option', { value: 'Site Visit Request', text: 'Site Visit Request' }),
    );

    // 3. Requirement Type: Construction, Interior, Architect, Renovation
    const reqSelect = el(
      'select',
      {
        required: true,
        onChange: (e) => {
          requirementVal = e.target.value;
        },
      },
      el('option', { value: 'Construction', text: 'Construction' }),
      el('option', { value: 'Interior', text: 'Interior Design' }),
      el('option', { value: 'Architect', text: 'Architect Only' }),
      el('option', { value: 'Renovation', text: 'Renovation' }),
    );

    // 4. Budget Range: <5L, 5L-15L, 15L-50L, 50L+
    const budgetSelect = el(
      'select',
      {
        required: true,
        onChange: (e) => {
          budgetVal = e.target.value;
        },
      },
      el('option', { value: '<5L', text: 'Less than ₹5 Lakhs (<5L)' }),
      el('option', { value: '5L-15L', text: '₹5L - ₹15 Lakhs' }),
      el('option', { value: '15L-50L', text: '₹15L - ₹50 Lakhs', selected: true }),
      el('option', { value: '50L+', text: '₹50 Lakhs+ (50L+)' }),
    );

    // 5. Site Location: Text Input (Optional)
    const locationInput = el('input', {
      type: 'text',
      placeholder: 'e.g. Sector 62, Noida / DLF Phase 5, Gurgaon',
      value: locationVal,
      onInput: (e) => {
        locationVal = e.target.value;
      },
    });

    // 6. Call Notes/Remarks: Text Area (Required)
    const notesInput = el('textarea', {
      rows: '3',
      required: true,
      placeholder: 'What exactly did the customer say? Specify scope, expectations, or concerns...',
      onInput: (e) => {
        notesVal = e.target.value;
      },
    });

    // 7. Next Action Date: Datepicker (Optional)
    const nextActionDateInput = el('input', {
      type: 'date',
      onChange: (e) => {
        callbackDateVal = e.target.value;
      },
    });

    const body = el(
      'form',
      { class: 'stack' },
      el(
        'div',
        { class: 'call-customer-summary card-stat' },
        el('strong', { text: KRY.toTitleCase(task.customer_name || 'Customer') }),
        el('span', { class: 'mono', text: task.customer_phone || task.phone || '' }),
        KRY.telHref(task.customer_phone || task.phone)
          ? el(
              'a',
              {
                class: 'btn btn-sm btn-primary',
                href: KRY.telHref(task.customer_phone || task.phone),
              },
              icon('phone'),
              'Call Now',
            )
          : null,
      ),
      el(
        'div',
        { class: 'log-call-modal-grid' },
        // Field 1: Call Outcome
        el('label', { class: 'field' }, el('span', { text: 'Call Outcome *' }), outcomeSelect),
        // Field 2: Call Purpose
        el('label', { class: 'field' }, el('span', { text: 'Call Purpose *' }), purposeSelect),
        // Field 3: Requirement Type
        el('label', { class: 'field' }, el('span', { text: 'Requirement Type *' }), reqSelect),
        // Field 4: Budget Range
        el(
          'label',
          { class: 'field' },
          el('span', { text: 'Budget Range *' }),
          budgetSelect,
          el('span', { class: 'log-call-helper-text', text: "Customer's approximate budget" }),
        ),
        // Field 5: Site Location
        el(
          'label',
          { class: 'field' },
          el('span', { text: 'Site Location (Area)' }),
          locationInput,
        ),
        // Field 7: Next Action Date (Optional)
        el(
          'label',
          { class: 'field' },
          el('span', { text: 'Next Action Date (Optional)' }),
          nextActionDateInput,
        ),
        // Callback date block if outcome = CALLBACK_REQUESTED
        callbackBlock,
        // Field 6: Notes (Full Span)
        el(
          'label',
          { class: 'field full-span' },
          el('span', { text: 'Call Notes & Remarks *' }),
          notesInput,
        ),
      ),
    );

    openModal({
      title: 'Log Call (Customer Qualification)',
      subtitle: `${task.id} · ${KRY.toTitleCase(task.customer_name || '')}`,
      size: 'wide',
      body,
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: 'Submit & Send to Admin',
          isPrimary: true,
          onClick: async () => {
            if (!notesVal.trim()) {
              toast('Call notes/remarks are required.', 'error');
              return;
            }
            if (outcomeVal === 'CALLBACK_REQUESTED' && !callbackDateVal) {
              toast('Next action date is required when callback is requested.', 'error');
              return;
            }

            try {
              let targetTaskId = task.id;
              if (targetTaskId && String(targetTaskId).startsWith('KRY-LEAD-')) {
                try {
                  const leadDetails = await api(`/leads/${encodeURIComponent(targetTaskId)}`);
                  const active = (leadDetails.tasks || []).find(
                    (t) =>
                      ['Assigned', 'In Progress'].includes(t.status) &&
                      (t.assigned_to === KRY.state.user?.id ||
                        ['ADMIN_DESK', 'SUPER_ADMIN'].includes(KRY.state.user?.role)),
                  );
                  if (active) targetTaskId = active.id;
                } catch (_) {}
              }

              // Submit to enhanced call-log endpoint
              await api(`/tasks/${targetTaskId}/call-log`, {
                method: 'POST',
                body: {
                  outcome: outcomeVal,
                  call_purpose: purposeVal,
                  requirement_type: requirementVal,
                  customer_budget: budgetVal,
                  location_area: locationVal.trim() || undefined,
                  notes: notesVal.trim(),
                  next_action_date: callbackDateVal || undefined,
                },
              });

              // Mark task submitted if it's a Telecaller Enquiry task so it moves to Finished/Sent to Admin
              let targetLeadId = task.lead_id;
              if (!targetLeadId) {
                if (String(task.id).startsWith('KRY-LEAD-')) {
                  targetLeadId = task.id;
                } else if (targetTaskId) {
                  try {
                    const tData = await api(`/tasks/${targetTaskId}`);
                    if (tData?.task?.lead_id) targetLeadId = tData.task.lead_id;
                  } catch (_) {}
                }
              }

              try {
                if (
                  task.task_type === 'TELECALLER_ENQUIRY' ||
                  KRY.state.user?.role === 'TELECALLER'
                ) {
                  const outcomeTitleMap = {
                    CONNECTED: 'Connected',
                    CALLBACK_REQUESTED: 'Callback Requested',
                    NO_ANSWER: 'No Answer',
                    BUSY: 'Busy',
                    SWITCHED_OFF: 'No Answer',
                    WRONG_NUMBER: 'Invalid Number',
                    INVALID_NUMBER: 'Invalid Number',
                  };
                  await api('/telecaller/respond', {
                    method: 'POST',
                    body: {
                      lead_id: targetLeadId,
                      task_id: targetTaskId,
                      call_outcome: outcomeTitleMap[outcomeVal] || 'Connected',
                      customer_intent: 'Warm',
                      notes: notesVal.trim(),
                      next_followup: callbackDateVal || undefined,
                      budget_range: budgetVal || undefined,
                      area: locationVal.trim() || undefined,
                      requirement_detail: requirementVal
                        ? `Requirement: ${requirementVal}`
                        : undefined,
                    },
                  });
                } else {
                  await api(`/tasks/${targetTaskId}/response`, {
                    method: 'POST',
                    body: {
                      findings: `Call Logged: [${outcomeVal}] [${purposeVal}]. Requirement: ${requirementVal} (Budget: ${budgetVal}). Notes: ${notesVal.trim()}`,
                    },
                  });
                }
              } catch (subErr) {
                // If already submitted or handled via telecaller respond, silently ignore
              }

              toast('Call log submitted and sent to Admin Desk', 'success');
              closeModal();
              KRY.renderRoute();
              KRY.refreshBadges();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.openLogCallModal = openLogCallModal;
  KRY.openTelecallerForm = (lead) => {
    let taskId = lead.task_id || null;
    if (!taskId && lead.id && !String(lead.id).startsWith('KRY-LEAD-')) {
      taskId = lead.id;
    }
    if (!taskId && Array.isArray(lead.tasks)) {
      const activeTask = lead.tasks.find(
        (t) =>
          t.task_type === 'TELECALLER_ENQUIRY' && ['Assigned', 'In Progress'].includes(t.status),
      );
      if (activeTask) taskId = activeTask.id;
    }
    openLogCallModal({
      id: taskId || lead.id,
      lead_id: lead.lead_id || (String(lead.id).startsWith('KRY-LEAD-') ? lead.id : null),
      customer_name: lead.customer_name,
      customer_phone: lead.customer_phone || lead.phone,
      task_type: lead.task_type || 'TELECALLER_ENQUIRY',
    });
  };

  /* -------------------------------------------------------------- Work Note Modal */

  function openWorkNoteModal(task) {
    let noteVal = '';
    let hoursVal = '';

    const noteInput = el('textarea', {
      rows: '4',
      required: true,
      placeholder:
        'Describe your progress, site measurements, calculations, vendor inquiries, or updates...',
      onInput: (e) => {
        noteVal = e.target.value;
      },
    });

    const hoursInput = el('input', {
      type: 'number',
      min: '0',
      step: '0.25',
      placeholder: 'e.g. 1.5',
      onInput: (e) => {
        hoursVal = e.target.value;
      },
    });

    const body = el(
      'form',
      { class: 'stack' },
      el('label', { class: 'field' }, el('span', { text: 'Work Note Details *' }), noteInput),
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Time Spent (hours, optional)' }),
        hoursInput,
      ),
    );

    openModal({
      title: 'Add Work Note',
      subtitle: `${KRY.taskTypeLabel(task.task_type)} · ${task.id}`,
      body,
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: 'Save Work Note',
          isPrimary: true,
          onClick: async () => {
            if (!noteVal.trim()) {
              toast('Please enter work note details.', 'error');
              return;
            }
            try {
              await api(`/tasks/${task.id}/work-note`, {
                method: 'POST',
                body: {
                  note: noteVal.trim(),
                  hours_spent: hoursVal ? Number(hoursVal) : undefined,
                },
              });
              toast('Work note saved', 'success');
              closeModal();
              KRY.renderRoute();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.openWorkNoteModal = openWorkNoteModal;

  /* -------------------------------------------------------------- Reminder Modals */

  function openSnoozeReminderModal(reminder) {
    let snoozeDate = addDays(7);
    let reasonVal = '';

    const dateField = el('input', {
      type: 'date',
      value: snoozeDate,
      onChange: (e) => {
        snoozeDate = e.target.value;
      },
    });

    const chipRow = el(
      'div',
      { class: 'quick-chips' },
      [
        { label: 'Tomorrow (+1d)', days: 1 },
        { label: 'In 3 Days (+3d)', days: 3 },
        { label: 'In 7 Days (+7d)', days: 7 },
        { label: 'In 14 Days (+14d)', days: 14 },
      ].map((chip) =>
        el(
          'button',
          {
            class: 'chip-btn',
            type: 'button',
            onClick: () => {
              snoozeDate = addDays(chip.days);
              dateField.value = snoozeDate;
            },
          },
          chip.label,
        ),
      ),
    );

    const reasonInput = el('input', {
      type: 'text',
      placeholder: 'Customer requested follow-up next week...',
      onInput: (e) => {
        reasonVal = e.target.value;
      },
    });

    const body = el(
      'form',
      { class: 'stack' },
      el('label', { class: 'field' }, el('span', { text: 'Snooze Until Date *' }), dateField),
      chipRow,
      el('label', { class: 'field' }, el('span', { text: 'Reason (optional)' }), reasonInput),
    );

    openModal({
      title: 'Snooze Reminder',
      subtitle: `Reminder for ${reminder.customer_name || reminder.lead_id || reminder.id}`,
      body,
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: 'Snooze Reminder',
          isPrimary: true,
          onClick: async () => {
            if (!snoozeDate) {
              toast('Please choose a date to snooze until.', 'error');
              return;
            }
            try {
              await api(`/reminders/${reminder.id}/snooze`, {
                method: 'POST',
                body: {
                  snooze_until: snoozeDate,
                  reason: reasonVal.trim() || undefined,
                },
              });
              toast('Reminder snoozed', 'success');
              closeModal();
              KRY.renderRoute();
              KRY.refreshBadges();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.openSnoozeReminderModal = openSnoozeReminderModal;

  function openDismissReminderModal(reminder) {
    let reasonVal = '';

    const reasonInput = el('textarea', {
      rows: '3',
      required: true,
      placeholder:
        'Provide reason for dismissing this reminder (e.g. Lead was already handled, customer not reachable)...',
      onInput: (e) => {
        reasonVal = e.target.value;
      },
    });

    const body = el(
      'form',
      { class: 'stack' },
      el('label', { class: 'field' }, el('span', { text: 'Reason for Dismissing *' }), reasonInput),
    );

    openModal({
      title: 'Dismiss Reminder',
      subtitle: `Reminder for ${reminder.customer_name || reminder.lead_id || reminder.id}`,
      body,
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: 'Dismiss Reminder',
          isPrimary: true,
          onClick: async () => {
            if (!reasonVal.trim()) {
              toast('Please enter a reason to dismiss the reminder.', 'error');
              return;
            }
            try {
              await api(`/reminders/${reminder.id}/dismiss`, {
                method: 'POST',
                body: { reason: reasonVal.trim() },
              });
              toast('Reminder dismissed', 'success');
              closeModal();
              KRY.renderRoute();
              KRY.refreshBadges();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.openDismissReminderModal = openDismissReminderModal;

  function openSnoozeTaskModal(task) {
    let snoozeDate = addDays(1);
    let reasonVal = '';

    const dateField = el('input', {
      type: 'date',
      value: snoozeDate,
      onChange: (e) => {
        snoozeDate = e.target.value;
      },
    });

    const chipRow = el(
      'div',
      { class: 'quick-chips' },
      [
        { label: 'Tomorrow (+1d)', days: 1 },
        { label: 'In 3 Days (+3d)', days: 3 },
        { label: 'In 7 Days (+7d)', days: 7 },
        { label: 'In 14 Days (+14d)', days: 14 },
      ].map((chip) =>
        el(
          'button',
          {
            class: 'chip-btn',
            type: 'button',
            onClick: () => {
              snoozeDate = addDays(chip.days);
              dateField.value = snoozeDate;
            },
          },
          chip.label,
        ),
      ),
    );

    const reasonInput = el('input', {
      type: 'text',
      placeholder: 'Customer busy, requested callback tomorrow...',
      onInput: (e) => {
        reasonVal = e.target.value;
      },
    });

    const body = el(
      'form',
      { class: 'stack' },
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Snooze / Reschedule Until Date *' }),
        dateField,
      ),
      chipRow,
      el(
        'label',
        { class: 'field' },
        el('span', { text: 'Reason / Note (optional)' }),
        reasonInput,
      ),
    );

    openModal({
      title: 'Snooze / Reschedule Task',
      subtitle: `${task.id} · ${KRY.toTitleCase(task.customer_name || 'Customer')}`,
      body,
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: 'Snooze Task',
          isPrimary: true,
          onClick: async () => {
            if (!snoozeDate) {
              toast('Please choose a date to snooze until.', 'error');
              return;
            }
            try {
              await api(`/tasks/${task.id}/snooze`, {
                method: 'POST',
                body: {
                  snooze_until: snoozeDate,
                  reason: reasonVal.trim() || undefined,
                },
              });
              toast('Task snoozed successfully', 'success');
              closeModal();
              KRY.renderRoute();
              KRY.refreshBadges();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.openSnoozeTaskModal = openSnoozeTaskModal;

  function ref(initial) {
    return { value: initial };
  }

  /* ----------------------------------------------------------------- My Work */

  registerPage('tasks', async () => {
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(
      pageHead(t('page.tasks.title'), isCentral() ? t('tasks.descCentral') : t('tasks.descSpoke')),
    );

    let activeTab = 'active';
    let scope = isCentral() ? 'all' : 'mine';
    let searchQuery = '';
    let priorityQuery = '';
    let doneTimeframe = 'all'; // 'all' for All-Time history, or '30d'

    const statsHost = el('div');
    const tabsBar = el('div', { class: 'tabs-bar' });
    const contentHost = el('div', { class: 'stack' });

    async function reload() {
      contentHost.replaceChildren(el('div', { class: 'loading-block', text: t('common.loading') }));
      const params = new URLSearchParams({ tab: activeTab, scope });
      if (searchQuery) params.set('search', searchQuery);
      if (priorityQuery) params.set('priority', priorityQuery);
      if (activeTab === 'done' && doneTimeframe === 'all') params.set('all_time', '1');

      try {
        const data = await api(`/queues/my-work?${params.toString()}`);
        const tasks = Array.isArray(data) ? data : data.tasks || [];
        const counts = data.counts || { active: 0, waiting: 0, review: 0, done: 0 };

        // Telecaller calling quick stats
        if (
          KRY.state.user &&
          (KRY.state.user.role === 'TELECALLER' || KRY.state.user.department === 'Marketing')
        ) {
          try {
            const histData = await api('/queues/calling/history').catch(() => ({ stats: {} }));
            const cStats = histData.stats || {};
            const totalCalls = cStats.total_calls || 0;
            const connectedCalls = cStats.connected_calls || 0;
            statsHost.replaceChildren(
              el(
                'div',
                { class: 'stat-tiles', style: 'margin-bottom: 12px;' },
                el(
                  'div',
                  { class: 'stat-tile' },
                  el('div', { class: 'stat-val', text: String(totalCalls) }),
                  el('div', { class: 'stat-lbl', text: 'Total Calls Logged' }),
                ),
                el(
                  'div',
                  { class: 'stat-tile' },
                  el('div', {
                    class: 'stat-val',
                    style: 'color: #10b981;',
                    text: String(connectedCalls),
                  }),
                  el('div', { class: 'stat-lbl', text: 'Calls Connected / बात हुई' }),
                ),
                el(
                  'div',
                  { class: 'stat-tile' },
                  el('div', {
                    class: 'stat-val',
                    style: 'color: #3b82f6;',
                    text: String(counts.review || 0),
                  }),
                  el('div', { class: 'stat-lbl', text: 'Submitted to Admin (Sent for Review)' }),
                ),
                el(
                  'div',
                  {
                    class: 'stat-tile',
                    style: 'cursor: pointer; border-left: 3px solid #6366f1;',
                    onClick: () => navigate('telecaller'),
                  },
                  el(
                    'div',
                    {
                      class: 'stat-val',
                      style: 'font-size: 15px; margin-top: 4px; color: #4f46e5;',
                    },
                    'Calling Queue →',
                  ),
                  el('div', { class: 'stat-lbl', text: 'Pending Calls & Spoken History' }),
                ),
              ),
            );
          } catch {
            statsHost.replaceChildren();
          }
        } else {
          statsHost.replaceChildren();
        }

        // Render Tabs: Active, Waiting, Sent for Review, and Done / History
        tabsBar.replaceChildren(
          ...[
            { key: 'active', label: t('queue.active') || 'Active', count: counts.active },
            { key: 'waiting', label: t('queue.waiting') || 'Waiting', count: counts.waiting },
            { key: 'review', label: t('queue.sent') || 'Sent for Review', count: counts.review },
            { key: 'done', label: t('queue.done') || 'Done / History', count: counts.done },
          ].map((item) =>
            el(
              'button',
              {
                class: `tab-btn ${activeTab === item.key ? 'active' : ''}`.trim(),
                type: 'button',
                onClick: () => {
                  activeTab = item.key;
                  reload();
                },
              },
              el('span', { text: item.label }),
              el('span', { class: 'tab-badge', text: String(item.count || 0) }),
            ),
          ),
        );

        // Render Task Cards Grid
        if (!tasks.length) {
          if (activeTab === 'done' && counts.review > 0) {
            contentHost.replaceChildren(
              card(
                'Work Status',
                null,
                el(
                  'div',
                  {
                    class: 'stack',
                    style: 'align-items: center; text-align: center; padding: 28px;',
                  },
                  el('div', { style: 'font-size: 32px;' }, '⏳'),
                  el('h3', { text: 'Submitted Work Awaiting Admin Review' }),
                  el(
                    'p',
                    { class: 'muted', style: 'max-width: 480px; margin: 8px 0;' },
                    `Aapka ${counts.review} task submit ho chuka hai aur Admin Desk ke review / approval ke liye pending hai.`,
                  ),
                  el(
                    'button',
                    {
                      class: 'btn btn-primary',
                      type: 'button',
                      style: 'margin-top: 8px;',
                      onClick: () => {
                        activeTab = 'review';
                        reload();
                      },
                    },
                    icon('check'),
                    `Sent for Review (${counts.review}) mein dekhein`,
                  ),
                ),
              ),
            );
            return;
          }

          contentHost.replaceChildren(
            card(
              t('common.nothingHere'),
              null,
              emptyState(
                t('myday.allClear'),
                activeTab === 'active'
                  ? 'No active tasks pending your attention.'
                  : activeTab === 'waiting'
                    ? 'No tasks in waiting or callback requested status.'
                    : activeTab === 'review'
                      ? 'No tasks submitted for review.'
                      : 'No completed tasks found in history.',
                'check',
              ),
            ),
          );
          return;
        }

        const grid = el('div', { class: 'grid grid-2' });
        tasks.forEach((task) => {
          // If task belongs to Purchase Department or is a procurement task, render the specialized Procurement Task Card
          const isPurchaseTask =
            task.department === 'Purchase' ||
            ['MATERIAL_CHECK', 'MATERIAL_PROCUREMENT', 'VENDOR_COSTING'].includes(task.task_type) ||
            (KRY.state.user && KRY.state.user.role === 'PURCHASE');

          if (isPurchaseTask && KRY.state.user && KRY.state.user.role === 'PURCHASE') {
            grid.appendChild(createProcurementCard(task));
            return;
          }

          const mine = task.assigned_to === KRY.state.user.id;
          const contactAccess =
            task.customer_contact_allowed ||
            (isCentral() &&
              task.requires_contact &&
              task.contact_authorized_to === task.assigned_to &&
              Date.parse(task.contact_expires_at) > Date.now());
          const priorityLower = (task.priority || 'medium').toLowerCase();
          const actions = [];

          // Note & Call buttons
          actions.push(
            el(
              'button',
              {
                class: 'btn btn-outline',
                type: 'button',
                onClick: (e) => {
                  e.stopPropagation();
                  openWorkNoteModal(task);
                },
              },
              icon('doc'),
              'Add Note',
            ),
          );

          if (task.requires_contact) {
            actions.push(
              el(
                'button',
                {
                  class: 'btn btn-outline',
                  type: 'button',
                  onClick: (e) => {
                    e.stopPropagation();
                    openLogCallModal(task);
                  },
                },
                icon('phone'),
                'Log Call',
              ),
            );
          }

          // Submit button for active tasks
          if (activeTab === 'active' && mine) {
            actions.push(
              el(
                'button',
                {
                  class: 'btn btn-primary',
                  type: 'button',
                  onClick: (e) => {
                    e.stopPropagation();
                    submitTaskFlow(task);
                  },
                },
                icon('check'),
                'Submit to Admin Desk',
              ),
            );
          }

          if (task.lead_id) {
            actions.push(
              el(
                'button',
                {
                  class: 'btn btn-outline',
                  type: 'button',
                  onClick: (e) => {
                    e.stopPropagation();
                    KRY.openLeadModal(task.lead_id);
                  },
                },
                icon('flag'),
                t('action.openLead'),
              ),
            );
          }

          actions.push(
            el(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                onClick: (e) => {
                  e.stopPropagation();
                  openTaskModal(task.id);
                },
              },
              t('common.open'),
            ),
          );

          const phone = task.customer_phone || task.phone || '';
          const tel = KRY.telHref(phone);
          const phoneElement = tel
            ? el(
                'a',
                { class: 'phone-link', href: tel, onClick: (e) => e.stopPropagation() },
                icon('phone'),
                phone,
              )
            : el('span', { text: phone || '—' });

          const cardNode = el(
            'section',
            {
              class: `card calling-card priority-${priorityLower}`,
              style: 'cursor: pointer;',
              onClick: (e) => {
                if (e.target.closest('button, a, input')) return;
                openTaskModal(task.id);
              },
            },
            el(
              'div',
              { class: 'calling-card-head' },
              el(
                'div',
                {},
                el('h2', { text: KRY.taskTypeLabel(task.task_type) }),
                el(
                  'p',
                  { class: 'mono small muted' },
                  `${task.id} · ${KRY.deptLabel(task.department)} · ${task.assignee_name || '—'}`,
                ),
              ),
              el(
                'div',
                { class: 'btn-row' },
                statusBadge(task.status),
                priorityBadge(task.priority),
                task.contact_status ? badge(task.contact_status, 'neutral') : null,
              ),
            ),
            el(
              'div',
              { class: 'card-body' },
              el(
                'div',
                { class: 'stack' },
                kv(
                  [
                    [
                      t('common.customer'),
                      task.lead_id
                        ? el(
                            'a',
                            {
                              href: '#',
                              onClick: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                KRY.openLeadModal(task.lead_id);
                              },
                            },
                            KRY.toTitleCase(task.customer_name || 'Customer'),
                          )
                        : KRY.toTitleCase(task.customer_name || '—'),
                    ],
                    [t('common.phone'), phoneElement],
                    [t('common.due'), dueBadge(dueOf(task))],
                    [
                      'Timeline',
                      el('span', {
                        class: 'small muted',
                        text: KRY.formatRelativeTime(task.created_at),
                      }),
                    ],
                    task.location ? [t('common.location'), task.location] : null,
                  ].filter(Boolean),
                ),
                task.brief ? el('p', { class: 'form-note', text: task.brief }) : null,
                task.response
                  ? el(
                      'div',
                      {
                        style:
                          'margin-top: 10px; padding: 10px 14px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; font-size: 13px; color: #166534;',
                      },
                      el(
                        'div',
                        {
                          style:
                            'font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;',
                        },
                        icon('check'),
                        'Submitted Work & Call Summary:',
                      ),
                      el('div', { text: task.response }),
                      task.latest_call_purpose
                        ? el('div', {
                            class: 'small muted',
                            style: 'margin-top: 4px;',
                            text: `Purpose: ${task.latest_call_purpose}`,
                          })
                        : null,
                    )
                  : null,
                el('div', { class: 'calling-card-actions' }, actions),
              ),
            ),
          );

          grid.appendChild(cardNode);
        });

        contentHost.replaceChildren(grid);
      } catch (err) {
        contentHost.replaceChildren(el('div', { class: 'form-error', text: err.message }));
      }
    }

    // Controls: Admin scope toggle + Search + Priority
    const controls = [];
    if (isCentral()) {
      controls.push(
        el(
          'div',
          { class: 'btn-row' },
          el(
            'button',
            {
              class: `btn ${scope === 'all' ? 'btn-primary' : 'btn-outline'}`,
              type: 'button',
              onClick: () => {
                scope = 'all';
                reload();
              },
            },
            'All Tasks',
          ),
          el(
            'button',
            {
              class: `btn ${scope === 'mine' ? 'btn-primary' : 'btn-outline'}`,
              type: 'button',
              onClick: () => {
                scope = 'mine';
                reload();
              },
            },
            'My Work Only',
          ),
        ),
      );
    }

    const searchInput = el('input', {
      type: 'search',
      placeholder: 'Search task, customer, or ID...',
      onInput: (e) => {
        searchQuery = e.target.value.trim();
        reload();
      },
    });

    const prioritySelect = el(
      'select',
      {
        onChange: (e) => {
          priorityQuery = e.target.value;
          reload();
        },
      },
      el('option', { value: '', text: 'All Priorities' }),
      ['Urgent', 'High', 'Medium', 'Low'].map((p) => el('option', { value: p, text: p })),
    );

    controls.push(
      toolbar([
        el('div', { class: 'field' }, searchInput),
        el('div', { class: 'field' }, prioritySelect),
        el('span', { class: 'spacer' }),
        isCentral()
          ? el(
              'button',
              {
                class: 'btn',
                type: 'button',
                onClick: () => KRY.download('/export/tasks.xls', 'tasks.xls'),
              },
              icon('doc'),
              t('tasks.export'),
            )
          : null,
      ]),
    );

    wrap.appendChild(el('div', { class: 'stack' }, statsHost, ...controls, tabsBar, contentHost));
    await reload();
    return wrap;
  });

  async function openTaskModal(id) {
    let data;
    try {
      data = await api(`/tasks/${id}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const task = data.task;
    const mine = task.assigned_to === KRY.state.user.id;
    const contactAccess =
      Boolean(task.customer_contact_allowed) ||
      (isCentral() &&
        task.requires_contact &&
        task.contact_authorized_to === task.assigned_to &&
        Date.parse(task.contact_expires_at) > Date.now());
    const body = el('div', { class: 'stack' });

    // Lead Context (Read-Only) for all roles; phone/call strictly suppressed for Purchase
    const phone = task.customer_phone || task.phone || '';
    const isPurchaseOfficer = Boolean(KRY.state.user && KRY.state.user.role === 'PURCHASE');
    const tel = !isPurchaseOfficer ? KRY.telHref(phone) : null;
    const phoneElement = tel
      ? el('a', { class: 'phone-link', href: tel }, icon('phone'), phone)
      : el('span', {
          class: isPurchaseOfficer ? 'muted' : '',
          text: isPurchaseOfficer
            ? phone
              ? `${phone.slice(0, 3)}****${phone.slice(-3)} (Read-only)`
              : '—'
            : phone || '—',
        });

    body.appendChild(
      el(
        'div',
        { class: 'grid grid-2' },
        card(
          t('task.details'),
          task.id,
          kv([
            [t('common.status'), statusBadge(task.status)],
            [t('common.priority'), priorityBadge(task.priority)],
            [t('common.team'), KRY.deptLabel(task.department)],
            [t('common.task'), KRY.taskTypeLabel(task.task_type)],
            [t('common.assignedTo'), task.assignee_name || '—'],
            [t('task.assignedBy'), task.creator_name || '—'],
            [t('common.due'), fmtDate(task.due_date)],
            ['SLA', dueBadge(dueOf(task))],
            [t('common.lead'), task.lead_id || '—'],
            [t('common.customer'), task.customer_name || '—'],
            [t('common.phone'), phoneElement],
          ]),
        ),
        card(
          t('task.instruction'),
          null,
          el(
            'div',
            { class: 'stack' },
            el('p', { text: task.brief }),
            task.location
              ? el('p', { class: 'small muted', text: `${t('common.location')}: ${task.location}` })
              : null,
            task.requirement
              ? el('p', {
                  class: 'small muted',
                  text: `${t('common.requirement')}: ${task.requirement}`,
                })
              : null,
            task.budget_range
              ? el('p', { class: 'small muted', text: `Budget: ${task.budget_range}` })
              : null,
          ),
        ),
      ),
    );

    // Section 2: What the Telecaller / Employee Submitted (Budget, Requirement, Notes)
    const latestResponse = (data.telecallerResponses && data.telecallerResponses[0]) || null;
    const latestActivity = (data.activity && data.activity[0]) || null;

    if (task.response || latestResponse || (latestActivity && latestActivity.notes)) {
      const budgetDisplay =
        (latestResponse && latestResponse.budget_range) ||
        (latestActivity && latestActivity.customer_budget) ||
        task.budget_range ||
        '—';
      const reqDisplay =
        (latestResponse &&
          (latestResponse.requirement_type || latestResponse.requirement_detail)) ||
        (latestActivity && latestActivity.requirement_type) ||
        task.requirement ||
        '—';
      const purposeDisplay =
        (latestResponse && latestResponse.call_purpose) ||
        (latestActivity && latestActivity.call_purpose) ||
        '—';
      const notesDisplay =
        task.response ||
        (latestResponse && latestResponse.notes) ||
        (latestActivity && latestActivity.notes) ||
        '—';

      body.appendChild(
        card(
          'Submitted Findings & Qualification',
          task.submitted_at ? `Submitted on ${fmtDateTime(task.submitted_at)}` : 'Logged Outcome',
          el(
            'div',
            { class: 'stack' },
            kv([
              ['Call Purpose', el('span', { class: 'badge neutral', text: purposeDisplay })],
              ['Customer Budget', el('strong', { text: budgetDisplay })],
              ['Requirement Type', reqDisplay],
              ['Latest Notes & Remarks', el('p', { class: 'timeline-text', text: notesDisplay })],
            ]),
          ),
        ),
      );
    }

    if (task.review_remarks) {
      body.appendChild(
        card(
          t('task.review'),
          `${task.reviewer_name || 'Admin Desk'} · ${task.reviewed_at ? fmtDateTime(task.reviewed_at) : ''}`,
          el('p', { class: 'timeline-text', text: task.review_remarks }),
        ),
      );
    }

    const actions = [];
    body.appendChild(
      el('div', {
        class: 'form-note',
        text: contactAccess
          ? `Customer contact authorised · ${task.contact_purpose || 'Assigned task'} · until ${fmtDateTime(task.contact_expires_at)}`
          : 'Customer contact requires Admin Desk permission.',
      }),
    );
    if (isCentral() && ['Assigned', 'In Progress'].includes(task.status)) {
      actions.push(
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () => {
              openFormModal({
                title: 'Customer contact permission',
                submitLabel: 'Save decision',
                fields: [
                  {
                    name: 'allowed',
                    type: 'checkbox',
                    label: 'Allow assigned employee to contact customer',
                    value: Boolean(contactAccess),
                  },
                  {
                    name: 'purpose',
                    label: 'Purpose and boundaries',
                    type: 'textarea',
                    required: true,
                    value: task.contact_purpose || '',
                  },
                  {
                    name: 'allow_call',
                    type: 'checkbox',
                    label: 'Allow phone calls',
                    value: (task.contact_channels || '').includes('Call'),
                  },
                  {
                    name: 'allow_whatsapp',
                    type: 'checkbox',
                    label: 'Allow WhatsApp',
                    value: (task.contact_channels || '').includes('WhatsApp'),
                  },
                  {
                    name: 'allow_email',
                    type: 'checkbox',
                    label: 'Allow email',
                    value: (task.contact_channels || '').includes('Email'),
                  },
                  {
                    name: 'allow_site_visit',
                    type: 'checkbox',
                    label: 'Allow site visit coordination',
                    value: (task.contact_channels || '').includes('Site Visit'),
                  },
                  {
                    name: 'expires_at',
                    label: 'Expiry (IST)',
                    type: 'datetime-local',
                    required: true,
                  },
                ],
                onSubmit: async (values) => {
                  const channels = [
                    values.allow_call && 'Call',
                    values.allow_whatsapp && 'WhatsApp',
                    values.allow_email && 'Email',
                    values.allow_site_visit && 'Site Visit',
                  ].filter(Boolean);
                  if (values.allowed && !channels.length)
                    throw new Error('Select at least one contact channel.');
                  await api(`/tasks/${task.id}/contact-permission`, {
                    method: 'POST',
                    body: {
                      allowed: Boolean(values.allowed),
                      purpose: values.purpose,
                      channels,
                      expires_at: new Date(`${values.expires_at}:00+05:30`).toISOString(),
                      expected_version: task.version,
                    },
                  });
                },
                onSuccess: () => openTaskModal(task.id),
              });
            },
          },
          icon('shield'),
          'Contact permission',
        ),
      );
    }
    if (mine && !isCentral())
      actions.push(
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () => {
              openFormModal({
                title: 'Ask Admin Desk',
                submitLabel: 'Send request',
                fields: [
                  {
                    name: 'message',
                    label: 'Clarification or department assistance needed',
                    type: 'textarea',
                    required: true,
                  },
                  {
                    name: 'target_department',
                    label: 'Department assistance requested',
                    type: 'select',
                    options: [
                      { value: '', label: 'Admin decision only' },
                      ...[
                        'Sales',
                        'Technical',
                        'Design',
                        'Purchase',
                        'Accounts',
                        'Projects',
                        'Marketing',
                      ].map((value) => ({ value, label: value })),
                    ],
                  },
                  { name: 'due_at', label: 'Needed by (IST)', type: 'datetime-local' },
                ],
                onSubmit: (values) =>
                  api(`/tasks/${task.id}/admin-request`, {
                    method: 'POST',
                    body: {
                      message: values.message,
                      target_department: values.target_department || null,
                      due_at: values.due_at
                        ? new Date(`${values.due_at}:00+05:30`).toISOString()
                        : null,
                    },
                  }),
                onSuccess: () => openTaskModal(task.id),
              });
            },
          },
          'Ask Admin Desk',
        ),
      );
    const requests = await api('/api/admin-requests'.replace('/api', ''));
    const taskRequests = requests.filter((request) => request.task_id === task.id);
    if (taskRequests.length)
      body.appendChild(
        card(
          'Admin requests',
          'Clarifications and decisions for this assignment',
          el(
            'div',
            { class: 'stack' },
            ...taskRequests.map((request) =>
              el(
                'div',
                { class: 'card-body' },
                el('strong', { text: request.status }),
                el('p', { text: request.message }),
                request.target_department
                  ? el('p', {
                      class: 'muted',
                      text: `Requested from: ${request.target_department}`,
                    })
                  : null,
                request.response ? el('p', { text: `Admin response: ${request.response}` }) : null,
                !isCentral() && request.status === 'Resolved' && !request.acknowledged_at
                  ? el('button', {
                      class: 'btn btn-sm',
                      onClick: async () => {
                        await api(`/admin-requests/${request.id}/acknowledge`, { method: 'POST' });
                        toast('Admin response acknowledged.', 'success');
                        openTaskModal(task.id);
                      },
                      text: 'Acknowledge response',
                    })
                  : null,
                isCentral() && request.status === 'Open'
                  ? el(
                      'button',
                      {
                        class: 'btn',
                        onClick: () => {
                          openFormModal({
                            title: 'Resolve request',
                            fields: [
                              {
                                name: 'response',
                                label: 'Decision or clarification',
                                type: 'textarea',
                                required: true,
                              },
                            ],
                            onSubmit: (values) =>
                              api(`/admin-requests/${request.id}/resolve`, {
                                method: 'POST',
                                body: values,
                              }),
                            onSuccess: () => openTaskModal(task.id),
                          });
                        },
                      },
                      'Respond',
                    )
                  : null,
              ),
            ),
          ),
        ),
      );

    if (isPurchaseOfficer && ['Assigned', 'In Progress'].includes(task.status)) {
      actions.push(
        el(
          'button',
          {
            class: 'btn btn-outline',
            type: 'button',
            onClick: () => openVendorQuotationModal(task),
          },
          icon('doc'),
          'Upload Vendor Quotes',
        ),
        el(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onClick: () => openVendorQuotationModal(task),
          },
          icon('check'),
          'Submit Costing to Admin',
        ),
      );
    } else {
      if (mine && ['Assigned', 'In Progress'].includes(task.status)) {
        actions.push(
          el(
            'button',
            {
              class: 'btn btn-outline',
              type: 'button',
              onClick: () => openWorkNoteModal(task),
            },
            icon('doc'),
            'Add Work Note',
          ),
        );
        if (task.requires_contact) {
          actions.push(
            el(
              'button',
              {
                class: 'btn btn-outline',
                type: 'button',
                onClick: () => openLogCallModal(task),
              },
              icon('phone'),
              'Log Call',
            ),
          );
        }
      }
    }
    if (mine && task.status === 'Assigned') {
      actions.push(
        el(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onClick: async () => {
              try {
                await api(`/tasks/${task.id}/status`, {
                  method: 'PATCH',
                  body: { status: 'In Progress', expected_version: task.version },
                });
                toast(t('task.started'), 'success');
                openTaskModal(task.id);
                KRY.refreshBadges();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          icon('clock'),
          t('task.start'),
        ),
      );
    }
    if (mine && ['Assigned', 'In Progress'].includes(task.status)) {
      if (task.department === 'Technical') {
        actions.push(
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => openSiteInspection(task) },
            icon('home'),
            t('action.submitSiteReport'),
          ),
        );
      } else if (task.department === 'Design') {
        actions.push(
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => openDesignSubmission(task) },
            icon('doc'),
            t('action.submitDrawing'),
          ),
        );
      } else {
        actions.push(
          el(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => openTaskSubmission(task) },
            icon('check'),
            t('action.submitReport'),
          ),
        );
      }
    }
    if (isCentral() && task.status === 'Submitted') {
      actions.push(
        el(
          'button',
          { class: 'btn btn-dark', type: 'button', onClick: () => openTaskReview(task) },
          icon('shield'),
          t('action.reviewSubmission'),
        ),
        el(
          'button',
          { class: 'btn btn-outline', type: 'button', onClick: () => openTaskRework(task) },
          icon('clock'),
          'Request Rework',
        ),
      );
    }
    if (isCentral() && ['Assigned', 'In Progress'].includes(task.status)) {
      actions.push(
        el(
          'button',
          { class: 'btn btn-outline', type: 'button', onClick: () => openTaskReassign(task) },
          icon('users'),
          'Reassign',
        ),
      );
    }
    if (isCentral() && ['Reviewed', 'Closed'].includes(task.status)) {
      actions.push(
        el(
          'button',
          { class: 'btn btn-outline', type: 'button', onClick: () => openTaskReopen(task) },
          icon('clock'),
          'Reopen Task',
        ),
      );
    }
    if (actions.length) {
      body.appendChild(card(t('task.actions'), null, el('div', { class: 'btn-row' }, actions)));
    }

    const evidence = [];
    if (data.siteVisits && data.siteVisits.length) {
      evidence.push(
        card(
          t('task.inspections'),
          null,
          el(
            'div',
            { class: 'list' },
            data.siteVisits.map((visit) => {
              const photoHost = el('div', { class: 'stack' });
              KRY.loadAttachments({ entityType: 'site_visit', entityId: visit.id })
                .then((files) => {
                  if (files.length)
                    photoHost.appendChild(KRY.attachmentGallery(files, { compact: true }));
                })
                .catch(() => {});
              return el(
                'div',
                { class: 'list-item' },
                el('span', { class: 'list-icon' }, icon('home')),
                el(
                  'div',
                  { class: 'list-body' },
                  el('div', {
                    class: 'list-title',
                    text: `${t('site.register')} · ${fmtDate(visit.visit_date)}`,
                  }),
                  el('div', { class: 'list-meta', text: visit.engineer_name || '' }),
                  (Number(visit.estimated_cost) || 0) > 0
                    ? el(
                        'div',
                        {
                          style:
                            'background: linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%); border: 1px solid #a7f3d0; border-radius: 6px; padding: 10px 12px; margin: 8px 0;',
                        },
                        el(
                          'div',
                          {
                            style:
                              'display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 6px;',
                          },
                          el(
                            'strong',
                            { style: 'color: #065f46; font-size: 15px;' },
                            `Overall Estimated Cost: ₹${Number(visit.estimated_cost).toLocaleString('en-IN')}`,
                          ),
                          el('span', {
                            class: 'badge',
                            text: `Timeline: ${visit.estimated_timeline || 'Standard'}`,
                          }),
                        ),
                        el(
                          'div',
                          { class: 'small muted', style: 'margin-top: 4px;' },
                          `Civil: ₹${(Number(visit.civil_cost) || 0).toLocaleString('en-IN')} | Finishing: ₹${(Number(visit.interior_cost) || 0).toLocaleString('en-IN')} | MEP: ₹${(Number(visit.mep_cost) || 0).toLocaleString('en-IN')} | Logistics: ₹${(Number(visit.labor_logistics_cost) || 0).toLocaleString('en-IN')}`,
                        ),
                        visit.sales_advice
                          ? el(
                              'div',
                              {
                                style:
                                  'color: #92400e; background: #fffbeb; padding: 6px 8px; border-radius: 4px; margin-top: 6px; font-size: 12.5px; font-weight: 500;',
                              },
                              `💼 Sales Negotiation Advice: ${visit.sales_advice}`,
                            )
                          : null,
                      )
                    : null,
                  el('div', { class: 'small muted', text: visit.technical_report }),
                  photoHost,
                ),
              );
            }),
          ),
          { tight: true },
        ),
      );
    }
    if (data.designs && data.designs.length) {
      evidence.push(
        card(
          t('task.designs'),
          null,
          el(
            'div',
            { class: 'list' },
            data.designs.map((design) =>
              el(
                'div',
                { class: 'list-item' },
                el('span', { class: 'list-icon' }, icon('doc')),
                el(
                  'div',
                  { class: 'list-body' },
                  el('div', {
                    class: 'list-title',
                    text: `v${design.version} · ${design.design_type || t('design.version')}`,
                  }),
                  el('div', { class: 'list-meta', text: design.architect_name || '' }),
                  el('div', { class: 'small muted', text: design.description }),
                ),
                statusBadge(design.status),
              ),
            ),
          ),
          { tight: true },
        ),
      );
    }
    if (evidence.length) body.appendChild(el('div', { class: 'grid grid-2' }, evidence));

    // Section 3: Vertical Activity Timeline with exact timestamps
    const combinedTimeline =
      data.timeline && data.timeline.length
        ? data.timeline
        : (data.activity || []).map((act) => ({
            action_type: act.kind === 'CALL' ? 'CALL_OUTCOME' : 'NOTE',
            created_at: act.created_at,
            from_employee_name: act.employee_name,
            remarks: act.notes,
          }));

    body.appendChild(
      card('Task & Activity Timeline', 'Complete step-by-step history', timeline(combinedTimeline)),
    );

    openModal({
      title: KRY.taskTypeLabel(task.task_type),
      subtitle: `${task.id} · ${KRY.deptLabel(task.department)} · ${task.customer_name || task.lead_id || ''}`,
      size: 'wide',
      body,
      actions: [
        task.lead_id
          ? { label: t('action.openLead'), onClick: () => KRY.openLeadModal(task.lead_id) }
          : null,
        { label: t('common.close'), onClick: closeModal },
      ].filter(Boolean),
    });
  }
  KRY.openTaskModal = openTaskModal;

  /* --------------------------------------------------- Procurement Task & Vendor Modal */

  function createProcurementCard(task) {
    const priorityLower = (task.priority || 'medium').toLowerCase();
    const customerLead = `${task.customer_name || 'Customer'} (${task.lead_id || task.id})`;

    const actions = el(
      'div',
      { class: 'calling-card-actions' },
      el(
        'button',
        {
          class: 'btn btn-outline',
          type: 'button',
          onClick: (e) => {
            e.stopPropagation();
            openVendorQuotationModal(task);
          },
        },
        icon('doc'),
        'Upload Vendor Quotes',
      ),
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onClick: (e) => {
            e.stopPropagation();
            openVendorQuotationModal(task);
          },
        },
        icon('check'),
        'Submit Costing to Admin',
      ),
      el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onClick: (e) => {
            e.stopPropagation();
            openTaskModal(task.id);
          },
        },
        'Details',
      ),
    );

    return el(
      'section',
      {
        class: `card calling-card priority-${priorityLower}`,
        style: 'cursor: pointer;',
        onClick: () => openTaskModal(task.id),
      },
      el(
        'div',
        { class: 'calling-card-head' },
        el(
          'div',
          {},
          el('span', { class: 'badge neutral small', text: 'Material Request' }),
          el('h3', { style: 'margin: 4px 0 2px 0;', text: task.brief || 'Procure Materials' }),
          el('p', {
            class: 'mono small muted',
            text: `${task.id} · Due: ${fmtDate(task.due_date)}`,
          }),
        ),
        el('div', { class: 'btn-row' }, priorityBadge(task.priority), statusBadge(task.status)),
      ),
      el(
        'div',
        { class: 'card-body' },
        el(
          'div',
          { class: 'stack' },
          kv([
            ['Project / Lead', el('strong', { text: customerLead })],
            ['Site Location', task.location || task.area || '— (Read-Only)'],
            ['Assigned By', task.creator_name || 'Admin Desk'],
            ['SLA Remaining', dueBadge(dueOf(task))],
          ]),
          task.brief
            ? el(
                'div',
                { class: 'form-note', style: 'margin-top: 8px;' },
                el('strong', { text: 'Admin Instructions: ' }),
                task.brief,
              )
            : null,
          actions,
        ),
      ),
    );
  }
  KRY.createProcurementCard = createProcurementCard;

  function openVendorQuotationModal(task) {
    let vendorName = '';
    let quotedAmount = '';
    let deliveryTimeline = '3-5 Business Days';
    let materialRemarks = '';
    let uploadedFile = '';

    const vendorInput = el('input', {
      type: 'text',
      placeholder: 'e.g. A-One Marbles & Granites / Jindal Steel',
      required: true,
      onInput: (e) => {
        vendorName = e.target.value;
      },
    });

    const amountInput = el('input', {
      type: 'text',
      placeholder: 'e.g. ₹ 1,75,000 (Incl. GST & Transport)',
      required: true,
      onInput: (e) => {
        quotedAmount = e.target.value;
      },
    });

    const deliveryInput = el('input', {
      type: 'text',
      placeholder: 'e.g. Next Tuesday / 3 Days',
      value: deliveryTimeline,
      required: true,
      onInput: (e) => {
        deliveryTimeline = e.target.value;
      },
    });

    const fileInput = el('input', {
      type: 'file',
      accept: '.pdf,.png,.jpg,.jpeg,.xlsx',
      onChange: (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) uploadedFile = file.name;
      },
    });

    const remarksText = el('textarea', {
      rows: '3',
      required: true,
      placeholder: 'Vendor payment terms, freight charges, sample approved, or warranty details...',
      onInput: (e) => {
        materialRemarks = e.target.value;
      },
    });

    const form = el(
      'form',
      { class: 'stack' },
      el(
        'div',
        { class: 'card-stat' },
        el('strong', { text: `Procurement Task: ${task.brief}` }),
        el('p', {
          class: 'small muted',
          text: `Lead: ${task.customer_name || 'Customer'} (${task.lead_id || task.id}) · Site: ${task.location || 'Site Location'}`,
        }),
      ),
      el(
        'div',
        { class: 'log-call-modal-grid' },
        el(
          'label',
          { class: 'field' },
          el('span', { text: 'Vendor / Supplier Name *' }),
          vendorInput,
        ),
        el(
          'label',
          { class: 'field' },
          el('span', { text: 'Quoted Amount (with Taxes) *' }),
          amountInput,
        ),
        el('label', { class: 'field' }, el('span', { text: 'Delivery Timeline *' }), deliveryInput),
        el(
          'label',
          { class: 'field' },
          el('span', { text: 'Upload Vendor Quotation (PDF/Image)' }),
          fileInput,
          uploadedFile ? el('small', { class: 'muted', text: `Selected: ${uploadedFile}` }) : null,
        ),
        el(
          'label',
          { class: 'field full-span' },
          el('span', { text: 'Procurement Remarks & Costing Details *' }),
          remarksText,
        ),
      ),
    );

    openModal({
      title: 'Submit Vendor Quotation & Costing',
      subtitle: `${task.id} · Purchase Department Loop`,
      size: 'wide',
      body: form,
      actions: [
        { label: t('common.cancel'), onClick: closeModal },
        {
          label: 'Submit to Admin Desk',
          isPrimary: true,
          onClick: async () => {
            if (!vendorName.trim() || !quotedAmount.trim() || !remarksText.value.trim()) {
              toast('Vendor name, quoted amount, and costing remarks are required.', 'error');
              return;
            }

            const formattedFindings = [
              `[Procurement Costing] Vendor: ${vendorName.trim()}`,
              `Quoted Amount: ${quotedAmount.trim()}`,
              `Delivery Timeline: ${deliveryTimeline.trim()}`,
              uploadedFile ? `Quote Document: ${uploadedFile}` : null,
              `Notes: ${materialRemarks.trim()}`,
            ]
              .filter(Boolean)
              .join(' | ');

            try {
              await api(`/tasks/${task.id}/response`, {
                method: 'POST',
                body: {
                  findings: formattedFindings,
                  recommendation: `Recommended supplier: ${vendorName.trim()} with delivery in ${deliveryTimeline.trim()}`,
                  attachments: uploadedFile || undefined,
                  expected_version: task.version,
                },
              });

              toast('Vendor quotes and procurement costing submitted to Admin Desk', 'success');
              closeModal();
              KRY.renderRoute();
              KRY.refreshBadges();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
  KRY.openVendorQuotationModal = openVendorQuotationModal;

  /* ------------------------------------------------------- Generic submission */

  function openTaskSubmission(task) {
    const steps = [
      {
        titleKey: 'submit.findings',
        render(data) {
          return el(
            'div',
            { class: 'stack' },
            field({
              name: 'findings',
              label: t('submit.findings'),
              type: 'textarea',
              rows: 5,
              required: true,
              value: data.findings || '',
              placeholder: t('submit.findingsPlaceholder'),
            }),
            moreDetails([
              field({
                name: 'attachments',
                label: t('submit.attachments'),
                value: data.attachments || '',
              }),
            ]),
          );
        },
        collect(data, root) {
          data.findings = String(valueOf(root, 'findings')).trim();
          data.attachments = String(valueOf(root, 'attachments')).trim();
          if (!data.findings) return t('wizard.required');
          return null;
        },
      },
      {
        titleKey: 'submit.recommendation',
        render(data) {
          return el(
            'div',
            { class: 'stack' },
            el('div', { class: 'review-box' }, el('p', { text: data.findings })),
            field({
              name: 'recommendation',
              label: t('submit.recommendation'),
              type: 'textarea',
              rows: 4,
              value: data.recommendation || '',
            }),
          );
        },
        collect(data, root) {
          data.recommendation = String(valueOf(root, 'recommendation')).trim();
          return null;
        },
      },
    ];

    openWizard({
      title: t('submit.title'),
      subtitle: `${task.id} · ${task.customer_name || task.lead_id || ''}`,
      steps,
      submitLabel: t('submit.button'),
      size: '',
      async onComplete(data) {
        await api(`/tasks/${task.id}/response`, {
          method: 'POST',
          body: {
            findings: data.findings,
            recommendation: data.recommendation || undefined,
            attachments: data.attachments || undefined,
            expected_version: task.version,
          },
        });
        toast(t('submit.done'), 'success');
        KRY.refreshNotifications();
        KRY.renderRoute();
        KRY.openTaskModal(task.id);
      },
    });
  }
  KRY.openTaskSubmission = openTaskSubmission;

  function openTaskReview(task) {
    openFormModal({
      title: t('task.reviewTitle'),
      subtitle: `${task.id} · ${KRY.deptLabel(task.department)} · ${task.customer_name || task.lead_id || ''}`,
      submitLabel: t('task.reviewSubmit'),
      fields: [
        {
          name: 'review_remarks',
          label: t('task.reviewLabel'),
          type: 'textarea',
          span2: true,
          required: true,
        },
        { name: 'next_action', label: t('task.nextLabel'), type: 'textarea', span2: true },
      ],
      onSubmit: async (values) => {
        if (!String(values.review_remarks || '').trim()) throw new Error(t('task.reviewLabel'));
        await api(`/tasks/${task.id}/review`, {
          method: 'POST',
          body: { ...values, expected_version: task.version },
        });
        toast(t('task.reviewDone'), 'success');
      },
      onSuccess: () => {
        KRY.refreshNotifications();
        KRY.renderRoute();
        openTaskModal(task.id);
      },
    });
  }
  KRY.openTaskReview = openTaskReview;

  function openTaskRework(task) {
    openFormModal({
      title: 'Request Task Rework',
      subtitle: `${task.id} · ${KRY.deptLabel(task.department)} · ${task.customer_name || task.lead_id || ''}`,
      submitLabel: 'Send Back for Rework',
      fields: [
        {
          name: 'rework_notes',
          label: 'Rework Instructions',
          type: 'textarea',
          span2: true,
          required: true,
          placeholder:
            'Explain what changes or additional information the department must provide...',
        },
      ],
      onSubmit: async (values) => {
        if (!String(values.rework_notes || '').trim())
          throw new Error('Rework instructions are required');
        await api(`/tasks/${task.id}/rework`, {
          method: 'POST',
          body: {
            rework_notes: String(values.rework_notes).trim(),
            expected_version: task.version,
          },
        });
        toast('Task sent back for rework', 'success');
      },
      onSuccess: () => {
        KRY.refreshNotifications();
        KRY.renderRoute();
        openTaskModal(task.id);
      },
    });
  }
  KRY.openTaskRework = openTaskRework;

  function openTaskReassign(task) {
    getEmployees().then((employees) => {
      const allowedRoles =
        {
          Sales: ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'],
          Technical: ['SITE_ENGINEER'],
          Design: ['ARCHITECT'],
          Purchase: ['PURCHASE'],
          Accounts: ['ACCOUNTS'],
          Projects: ['PROJECT_MANAGER'],
          Marketing: ['TELECALLER'],
        }[task.department] || [];

      const options = employees
        .filter((e) => e.active !== 0 && allowedRoles.includes(e.role) && e.id !== task.assigned_to)
        .map((e) => ({ value: e.id, label: `${e.name} (${e.role})` }));

      openFormModal({
        title: 'Reassign Task',
        subtitle: `${task.id} · ${KRY.deptLabel(task.department)} (Current: ${task.assignee_name || task.assigned_to})`,
        submitLabel: 'Reassign Task',
        fields: [
          {
            name: 'new_assigned_to',
            label: 'New Assignee (Same Department)',
            type: 'select',
            required: true,
            options: [{ value: '', label: '-- Select Employee --' }, ...options],
          },
          {
            name: 'reason',
            label: 'Reassignment Reason',
            type: 'textarea',
            span2: true,
            required: true,
            placeholder: 'Reason for reassignment...',
          },
        ],
        onSubmit: async (values) => {
          if (!values.new_assigned_to) throw new Error('Choose an active employee');
          if (!String(values.reason || '').trim())
            throw new Error('Reassignment reason is required');
          await api(`/tasks/${task.id}/reassign`, {
            method: 'POST',
            body: {
              new_assigned_to: values.new_assigned_to,
              reason: String(values.reason).trim(),
              expected_version: task.version,
            },
          });
          toast('Task successfully reassigned', 'success');
        },
        onSuccess: () => {
          KRY.refreshNotifications();
          KRY.renderRoute();
          openTaskModal(task.id);
        },
      });
    });
  }
  KRY.openTaskReassign = openTaskReassign;

  function openTaskReopen(task) {
    confirmAction({
      title: 'Reopen Task',
      message: `Are you sure you want to reopen task ${task.id}? It will be moved back to Assigned status.`,
      confirmLabel: 'Reopen Task',
      onConfirm: async () => {
        await api(`/tasks/${task.id}/reopen`, {
          method: 'POST',
          body: { reopen_reason: 'Reopened by Admin Desk', expected_version: task.version },
        });
        toast('Task reopened', 'success');
        KRY.refreshNotifications();
        KRY.renderRoute();
        openTaskModal(task.id);
      },
    });
  }
  KRY.openTaskReopen = openTaskReopen;

  /* ---------------------------------------------------------- Site inspection */

  const CHECKLIST = [
    {
      key: 'structure',
      labelKey: 'sv.group.structure',
      items: [
        { key: 'walls', labelKey: 'sv.item.walls' },
        { key: 'cracks', labelKey: 'sv.item.cracks' },
        { key: 'roof', labelKey: 'sv.item.roof' },
      ],
    },
    {
      key: 'electrical',
      labelKey: 'sv.group.electrical',
      items: [
        { key: 'wiring', labelKey: 'sv.item.wiring' },
        { key: 'lighting', labelKey: 'sv.item.lighting' },
      ],
    },
    {
      key: 'plumbing',
      labelKey: 'sv.group.plumbing',
      items: [
        { key: 'waterlines', labelKey: 'sv.item.waterlines' },
        { key: 'bathrooms', labelKey: 'sv.item.bathrooms' },
      ],
    },
    {
      key: 'flooring',
      labelKey: 'sv.group.flooring',
      items: [
        { key: 'flooring', labelKey: 'sv.item.flooring' },
        { key: 'ceiling', labelKey: 'sv.item.ceiling' },
      ],
    },
    {
      key: 'access',
      labelKey: 'sv.group.access',
      items: [
        { key: 'access', labelKey: 'sv.item.access' },
        { key: 'safety', labelKey: 'sv.item.safety' },
      ],
    },
  ];

  let activeRecorder = null;
  let recordingTimer = null;

  KRY.onBeforeModalClose = () => {
    if (activeRecorder && activeRecorder.state !== 'inactive') {
      try {
        activeRecorder.stop();
      } catch {
        /* ignore */
      }
    }
  };

  function formatClock(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function stopRecording() {
    if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop();
  }

  async function startRecording(data, rerender) {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof window.MediaRecorder === 'undefined'
    ) {
      toast(t('sv.micDenied'), 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const mime =
        preferred.find((type) => window.MediaRecorder.isTypeSupported(type)) || 'audio/webm';
      const recorder = new window.MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 32_000,
      });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        if (recordingTimer) {
          clearInterval(recordingTimer);
          recordingTimer = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        activeRecorder = null;
        data.recording = false;
        const blob = new Blob(chunks, { type: mime.split(';')[0] });
        try {
          const dataUrl = await KRY.fileToDataUrl(blob);
          data.voice = {
            dataUrl,
            name: 'site-voice.webm',
            mime: mime.split(';')[0],
            bytes: blob.size,
          };
        } catch {
          toast(t('sv.micDenied'), 'error');
        }
        rerender();
      };
      activeRecorder = recorder;
      data.recording = true;
      data.recordSeconds = 0;
      recorder.start();
      recordingTimer = setInterval(() => {
        data.recordSeconds += 1;
        const clock = document.querySelector('[data-recording-clock]');
        if (clock) clock.textContent = formatClock(data.recordSeconds);
        if (data.recordSeconds >= 90) stopRecording();
      }, 1000);
      rerender();
    } catch {
      toast(t('sv.micDenied'), 'error');
    }
  }

  function checklistReport(data) {
    const issues = [];
    let ok = 0;
    let na = 0;
    CHECKLIST.forEach((group) => {
      group.items.forEach((item) => {
        const state = data.checklist[item.key] || 'ok';
        const note = (data.checkNotes[item.key] || '').trim();
        if (state === 'ok') ok += 1;
        else if (state === 'na') na += 1;
        else {
          issues.push(`• ${t(group.labelKey)} / ${t(item.labelKey)}${note ? ` — ${note}` : ''}`);
        }
      });
    });
    const text = `${t('sv.autoReport')}:\n${
      issues.length ? issues.join('\n') : t('sv.autoAllOk')
    }\n${t('sv.okCount', { ok, na })}`;
    return { text, issues: issues.length, ok, na };
  }

  function openSiteInspection(task, preferredMode = null) {
    if (!task.lead_id) {
      toast(t('error.loadScreen'), 'error');
      return;
    }

    const isExecutionLead =
      ['Work Order Finalized', 'Project Handoff', 'In Progress', 'Completed', 'Approved'].includes(
        task.lead_stage,
      ) ||
      Boolean(task.project_id) ||
      Boolean(task.work_order_id) ||
      task.task_type === 'SITE_INSPECTION_EXECUTION';

    const mode = preferredMode || (isExecutionLead ? 'inspection' : 'cost_estimation');
    const isCostMode = mode === 'cost_estimation';

    const data = {
      mode,
      visit_date: KRY.localISO(0),
      visit_time: '',
      customer_present: true,
      checklist: {},
      checkNotes: {},
      photos: [],
      voice: null,
      scope_details: '',
      civil_cost: 0,
      interior_cost: 0,
      mep_cost: 0,
      labor_logistics_cost: 0,
      estimated_cost: 0,
      estimated_timeline: '',
      site_risk_level: 'Low',
      sales_advice: '',
      measurements: '',
      site_condition: '',
      customer_feedback: '',
      recommendation: '',
      report: '',
      construction_stage: 'RCC Columns & Slab Casting',
      progress_pct: '25%',
      snag_notes: '',
    };

    CHECKLIST.forEach((group) => {
      group.items.forEach((item) => {
        data.checklist[item.key] = 'ok';
      });
    });

    function checkRow(item, rerender) {
      const row = el('div', { class: 'check-row' });
      const note = el('input', {
        type: 'text',
        name: `note_${item.key}`,
        class: 'check-note',
        placeholder: t('sv.notePlaceholder'),
        value: data.checkNotes[item.key] || '',
      });
      const states = el('div', { class: 'check-states' });
      ['ok', 'issue', 'na'].forEach((state) => {
        const button = el(
          'button',
          {
            class: `check-state state-${state}${(data.checklist[item.key] || 'ok') === state ? ' selected' : ''}`,
            type: 'button',
            onClick: () => {
              data.checklist[item.key] = state;
              states
                .querySelectorAll('.check-state')
                .forEach((node) => node.classList.remove('selected'));
              button.classList.add('selected');
              note.hidden = state !== 'issue';
              if (state === 'issue') note.focus();
              const counter = document.querySelector('[data-issue-count]');
              if (counter) {
                const count = Object.values(data.checklist).filter(
                  (value) => value === 'issue',
                ).length;
                counter.textContent = String(count);
              }
            },
          },
          t(`sv.state.${state}`),
        );
        states.appendChild(button);
      });
      note.hidden = (data.checklist[item.key] || 'ok') !== 'issue';
      row.appendChild(
        el(
          'div',
          { class: 'check-head' },
          el('span', { class: 'check-label', text: t(item.labelKey) }),
          states,
        ),
      );
      row.appendChild(note);
      return row;
    }

    function modeSwitcherBar(activeMode) {
      const isCost = activeMode === 'cost_estimation';
      const switchWrap = el('div', {
        class: 'mode-switcher-wrap',
        style:
          'margin-bottom: 16px; background: var(--surface-alt); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px;',
      });

      const headerRow = el('div', {
        style:
          'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;',
      });

      const badgeNode = isCost
        ? el('span', {
            class: 'badge warn',
            style: 'font-weight: 600; padding: 6px 12px; font-size: 12px;',
            text:
              t('sv.badgePreOrder') ||
              'Phase 1: Pre-Order Feasibility & Cost Assessment — Initial report for Admin & Sales Quotation',
          })
        : el('span', {
            class: 'badge success',
            style: 'font-weight: 600; padding: 6px 12px; font-size: 12px;',
            text:
              t('sv.badgeApproved') ||
              'Phase 2: Work Order Approved — Active Construction Quality Inspection',
          });

      headerRow.appendChild(
        el('strong', {
          style: 'font-size: 13px; color: var(--text-muted);',
          text: 'Select Report Workflow:',
        }),
      );
      headerRow.appendChild(badgeNode);
      switchWrap.appendChild(headerRow);

      const btnGroup = el('div', {
        class: 'btn-row',
        style: 'display: flex; gap: 8px; flex-wrap: wrap;',
      });

      const costBtn = el(
        'button',
        {
          class: `btn ${isCost ? 'btn-primary' : 'btn-outline'} btn-sm`,
          type: 'button',
          style: 'flex: 1; min-width: 220px; justify-content: center;',
          onClick: () => {
            if (!isCost) {
              closeModal();
              openSiteInspection(task, 'cost_estimation');
            }
          },
        },
        icon('rupee'),
        t('sv.modeCost') || '1. Pre-Construction Cost Estimation (लागत व एस्टीमेशन)',
      );

      const inspBtn = el(
        'button',
        {
          class: `btn ${!isCost ? 'btn-primary' : 'btn-outline'} btn-sm`,
          type: 'button',
          style: 'flex: 1; min-width: 220px; justify-content: center;',
          onClick: () => {
            if (isCost) {
              closeModal();
              openSiteInspection(task, 'inspection');
            }
          },
        },
        icon('check'),
        t('sv.modeInsp') || '2. Active Construction Quality Inspection (तकनीकी गुणवत्ता निरीक्षण)',
      );

      btnGroup.appendChild(costBtn);
      btnGroup.appendChild(inspBtn);
      switchWrap.appendChild(btnGroup);

      return switchWrap;
    }

    function renderPreConstructionUploadStep(current, ctx) {
      current.photos = Array.isArray(current.photos) ? current.photos : [];
      const body = el('div', { class: 'stack' });

      // Optional Banner
      body.appendChild(
        el(
          'div',
          {
            style:
              'background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; display: flex; align-items: flex-start; gap: 10px; color: #166534;',
          },
          icon('check'),
          el(
            'div',
            {},
            el(
              'strong',
              { style: 'display: block; margin-bottom: 2px; font-size: 13px;' },
              'Optional Step (ऐच्छिक — फ़ोटो/ऑडियो छोड़ सकते हैं)',
            ),
            el(
              'p',
              { class: 'small', style: 'margin: 0; color: #15803d; line-height: 1.4;' },
              'फ़ोटो और ऑडियो अपलोड करना पूरी तरह Optional है। अगर अभी फ़ोटो नहीं हैं, तो बिना कुछ अपलोड किए सीधा नीचे "Next" दबाकर आगे बढ़ें और रिपोर्ट सबमिट करें।',
            ),
          ),
        ),
      );

      // Photo Upload Block (Sirf Upload File Option)
      const photoInput = el('input', {
        type: 'file',
        accept: 'image/*',
        multiple: true,
        class: 'file-input',
      });
      photoInput.addEventListener('change', async () => {
        const files = Array.from(photoInput.files || []);
        for (const file of files) {
          const attachment = await KRY.fileToAttachment(file);
          if (attachment) current.photos.push(attachment);
        }
        photoInput.value = '';
        ctx.rerender();
      });

      body.appendChild(
        el(
          'div',
          { class: 'upload-block' },
          el(
            'div',
            { class: 'upload-head' },
            icon('camera'),
            el('strong', { text: 'Upload Plot & Site Photos (फ़ोटो फ़ाइल चुनें - Optional)' }),
          ),
          el(
            'p',
            { class: 'small muted', text: 'Select photos of the plot, approach road, or boundary from your device (optional).' },
          ),
          el(
            'label',
            { class: 'btn btn-primary file-button' },
            icon('plus'),
            t('sv.addPhoto') || 'Choose Photo Files',
            photoInput,
          ),
        ),
      );

      if (current.photos.length) {
        const grid = el('div', { class: 'photo-grid' });
        current.photos.forEach((photo, index) => {
          grid.appendChild(
            el(
              'figure',
              { class: 'photo-tile' },
              el('img', { src: photo.dataUrl, alt: photo.name }),
              el(
                'button',
                {
                  class: 'photo-remove',
                  type: 'button',
                  'aria-label': t('sv.remove'),
                  onClick: () => {
                    current.photos.splice(index, 1);
                    ctx.rerender();
                  },
                },
                icon('close'),
              ),
              el('figcaption', { text: photo.name }),
            ),
          );
        });
        body.appendChild(grid);
      }

      // Audio File Upload Block (Sirf Audio File Upload)
      const audioInput = el('input', { type: 'file', accept: 'audio/*', class: 'file-input' });
      audioInput.addEventListener('change', async () => {
        const file = (audioInput.files || [])[0];
        if (!file) return;
        const dataUrl = await KRY.fileToDataUrl(file);
        current.voice = {
          dataUrl,
          name: file.name || 'site-notes.mp3',
          mime: file.type || 'audio/webm',
          bytes: file.size,
        };
        ctx.rerender();
      });

      const audioBlock = el(
        'div',
        { class: 'upload-block', style: 'margin-top: 10px;' },
        el(
          'div',
          { class: 'upload-head' },
          icon('mic'),
          el('strong', { text: 'Upload Audio Notes / Voice File (ऑडियो फ़ाइल चुनें - Optional)' }),
        ),
        el(
          'p',
          { class: 'small muted', text: 'If you have an audio recording or voice memo from the site, select the file here (optional).' },
        ),
      );

      if (current.voice) {
        audioBlock.appendChild(
          el(
            'div',
            { class: 'voice-preview', style: 'margin-top: 10px;' },
            el('audio', { src: current.voice.dataUrl, controls: true }),
            el(
              'button',
              {
                class: 'link-button',
                type: 'button',
                onClick: () => {
                  current.voice = null;
                  ctx.rerender();
                },
              },
              t('sv.remove') || 'Remove',
            ),
          ),
        );
      } else {
        audioBlock.appendChild(
          el(
            'label',
            { class: 'btn btn-outline file-button' },
            icon('plus'),
            'Choose Audio File',
            audioInput,
          ),
        );
      }

      body.appendChild(audioBlock);
      return body;
    }

    function renderPhotoVoiceStep(current, ctx, photoHelpText) {
      current.photos = Array.isArray(current.photos) ? current.photos : [];
      const body = el('div', { class: 'stack' });

      const photoInput = el('input', {
        type: 'file',
        accept: 'image/*',
        multiple: true,
        class: 'file-input',
        disabled: Boolean(current.recording),
      });
      photoInput.addEventListener('change', async () => {
        if (current.recording) {
          toast(t('sv.stopFirst'), 'error');
          return;
        }
        const files = Array.from(photoInput.files || []);
        for (const file of files) {
          const attachment = await KRY.fileToAttachment(file);
          if (attachment) current.photos.push(attachment);
        }
        photoInput.value = '';
        ctx.rerender();
      });

      body.appendChild(
        el(
          'div',
          { class: 'upload-block' },
          el('div', { class: 'upload-head' }, icon('camera'), el('strong', { text: t('sv.photos') })),
          el('p', { class: 'small muted', text: photoHelpText || t('sv.photosHelp') }),
          el('label', { class: 'btn btn-primary file-button' }, icon('plus'), t('sv.addPhoto'), photoInput),
        ),
      );

      if (current.photos.length) {
        const grid = el('div', { class: 'photo-grid' });
        current.photos.forEach((photo, index) => {
          grid.appendChild(
            el(
              'figure',
              { class: 'photo-tile' },
              el('img', { src: photo.dataUrl, alt: photo.name }),
              el(
                'button',
                {
                  class: 'photo-remove',
                  type: 'button',
                  'aria-label': t('sv.remove'),
                  onClick: () => {
                    current.photos.splice(index, 1);
                    ctx.rerender();
                  },
                },
                icon('close'),
              ),
              el('figcaption', { text: photo.name }),
            ),
          );
        });
        body.appendChild(grid);
      }

      const voiceBlock = el(
        'div',
        { class: 'voice-block' },
        el('div', { class: 'upload-head' }, icon('mic'), el('strong', { text: t('sv.voice') })),
        el('p', { class: 'small muted', text: t('sv.voiceHelp') }),
      );

      if (current.recording) {
        voiceBlock.appendChild(
          el(
            'div',
            { class: 'recording-row' },
            el('span', { class: 'recording-dot' }),
            el('strong', { text: t('sv.recording') }),
            el(
              'span',
              { class: 'mono', dataset: { recordingClock: '' } },
              formatClock(current.recordSeconds || 0),
            ),
            el(
              'button',
              { class: 'btn btn-danger', type: 'button', onClick: stopRecording },
              icon('mic'),
              t('sv.stop'),
            ),
          ),
        );
      } else if (current.voice) {
        voiceBlock.appendChild(
          el(
            'div',
            { class: 'voice-preview' },
            el('audio', { src: current.voice.dataUrl, controls: true }),
            el(
              'button',
              {
                class: 'link-button',
                type: 'button',
                onClick: () => {
                  current.voice = null;
                  ctx.rerender();
                },
              },
              t('sv.remove'),
            ),
          ),
        );
      } else {
        const audioInput = el('input', { type: 'file', accept: 'audio/*', class: 'file-input' });
        audioInput.addEventListener('change', async () => {
          const file = (audioInput.files || [])[0];
          if (!file) return;
          const dataUrl = await KRY.fileToDataUrl(file);
          current.voice = {
            dataUrl,
            name: file.name || 'voice-note.webm',
            mime: file.type || 'audio/webm',
            bytes: file.size,
          };
          ctx.rerender();
        });
        voiceBlock.appendChild(
          el(
            'div',
            { class: 'btn-row' },
            el(
              'button',
              {
                class: 'btn',
                type: 'button',
                onClick: () => startRecording(current, ctx.rerender),
              },
              icon('mic'),
              t('sv.record'),
            ),
            el('label', { class: 'btn file-button' }, icon('plus'), t('sv.attachAudio'), audioInput),
          ),
        );
        voiceBlock.appendChild(el('p', { class: 'small muted', text: t('sv.micWait') }));
      }

      body.appendChild(voiceBlock);
      return body;
    }

    let steps = [];

    if (isCostMode) {
      /* =========================================================================
       * MODE 1: Pre-Construction Feasibility & Cost Estimation
       * (Pre-Order / Initial Report for Admin & Sales Quotation)
       * ========================================================================= */
      steps = [
        {
          titleKey: 'sv.costStep1',
          render(current) {
            const body = el('div', { class: 'stack' });
            body.appendChild(modeSwitcherBar('cost_estimation'));

            // Scope of Construction
            body.appendChild(
              field({
                name: 'scope_details',
                label: t('sv.scopeDetails') || 'Detailed Scope of Construction Work',
                type: 'textarea',
                rows: 2,
                value: current.scope_details || '',
                placeholder:
                  'e.g. Turnkey construction of G+1 residential building (approx. 2400 sq ft). Includes foundation, brick masonry, slab casting, vitrified tiles, concealed electrical & CPVC plumbing.',
              }),
            );

            // Auto-calculated Total Hero Banner
            function computeTotal() {
              const c = Number(current.civil_cost) || 0;
              const i = Number(current.interior_cost) || 0;
              const m = Number(current.mep_cost) || 0;
              const l = Number(current.labor_logistics_cost) || 0;
              return c + i + m + l;
            }

            const currentTotal = computeTotal();
            if (!current.estimated_cost && currentTotal > 0) current.estimated_cost = currentTotal;

            const totalDisplay = el(
              'div',
              { style: 'font-size: 28px; font-weight: 800; color: #047857; margin-top: 4px;' },
              `₹${Number(current.estimated_cost || computeTotal()).toLocaleString('en-IN')}`,
            );

            function updateDisplay() {
              const sum = computeTotal();
              current.estimated_cost = sum;
              totalDisplay.textContent = `₹${sum.toLocaleString('en-IN')}`;
            }

            const heroBanner = el(
              'div',
              {
                style:
                  'background: linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%); border: 2px solid #a7f3d0; border-radius: 10px; padding: 16px 20px; margin: 12px 0;',
              },
              el(
                'div',
                {
                  class: 'small muted',
                  style:
                    'font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #065f46;',
                },
                t('sv.overallCost') || 'Overall Estimated Construction Cost (कुल निर्माण खर्च)',
              ),
              totalDisplay,
              el(
                'div',
                { class: 'small muted', style: 'margin-top: 4px; color: #047857;' },
                'Auto-calculated sum of Civil + Finishing + MEP + Labour/Logistics',
              ),
            );
            body.appendChild(heroBanner);

            // 4-Pillar Cost Inputs
            body.appendChild(
              el(
                'div',
                { class: 'form-grid' },
                field({
                  name: 'civil_cost',
                  label: t('sv.civilCost') || 'Civil & Structural Cost (₹)',
                  type: 'number',
                  value: current.civil_cost || '',
                  placeholder: 'e.g. 1500000',
                  onChange: (e) => {
                    current.civil_cost = Number(e.target.value) || 0;
                    updateDisplay();
                  },
                }),
                field({
                  name: 'interior_cost',
                  label: t('sv.interiorCost') || 'Finishing & Interior Cost (₹)',
                  type: 'number',
                  value: current.interior_cost || '',
                  placeholder: 'e.g. 600000',
                  onChange: (e) => {
                    current.interior_cost = Number(e.target.value) || 0;
                    updateDisplay();
                  },
                }),
                field({
                  name: 'mep_cost',
                  label: t('sv.mepCost') || 'MEP - Electrical & Plumbing (₹)',
                  type: 'number',
                  value: current.mep_cost || '',
                  placeholder: 'e.g. 350000',
                  onChange: (e) => {
                    current.mep_cost = Number(e.target.value) || 0;
                    updateDisplay();
                  },
                }),
                field({
                  name: 'labor_logistics_cost',
                  label: t('sv.logisticsCost') || 'Labour, Logistics & Scaffolding (₹)',
                  type: 'number',
                  value: current.labor_logistics_cost || '',
                  placeholder: 'e.g. 200000',
                  onChange: (e) => {
                    current.labor_logistics_cost = Number(e.target.value) || 0;
                    updateDisplay();
                  },
                }),
              ),
            );

            // Timeline and Risk
            body.appendChild(
              el(
                'div',
                { class: 'form-grid' },
                field({
                  name: 'estimated_timeline',
                  label: t('sv.timeline') || 'Estimated Construction Timeline',
                  type: 'text',
                  value: current.estimated_timeline || '',
                  placeholder: 'e.g. 4 to 6 Months',
                }),
                field({
                  name: 'site_risk_level',
                  label: t('sv.riskLevel') || 'Site Risk & Complexity Level',
                  type: 'select',
                  value: current.site_risk_level || 'Low',
                  options: [
                    { value: 'Low', label: 'Low Risk (Normal Soil & Easy Vehicle Access)' },
                    { value: 'Medium', label: 'Medium Risk (Moderate Access / Water Table Issues)' },
                    {
                      value: 'High',
                      label: 'High Risk (Weak Soil / Narrow Road / Demolition Required)',
                    },
                  ],
                }),
              ),
            );

            return body;
          },
          collect(current, root) {
            current.scope_details = String(valueOf(root, 'scope_details')).trim();
            current.civil_cost = Number(valueOf(root, 'civil_cost')) || 0;
            current.interior_cost = Number(valueOf(root, 'interior_cost')) || 0;
            current.mep_cost = Number(valueOf(root, 'mep_cost')) || 0;
            current.labor_logistics_cost = Number(valueOf(root, 'labor_logistics_cost')) || 0;
            current.estimated_cost =
              current.civil_cost +
              current.interior_cost +
              current.mep_cost +
              current.labor_logistics_cost;
            current.estimated_timeline = String(valueOf(root, 'estimated_timeline')).trim();
            current.site_risk_level = String(valueOf(root, 'site_risk_level') || 'Low').trim();
            return null;
          },
        },
        {
          titleKey: 'sv.costStep2',
          render(current) {
            const body = el('div', { class: 'stack' });

            body.appendChild(
              el(
                'div',
                { class: 'form-grid' },
                field({
                  name: 'visit_date',
                  label: t('sv.visitDate'),
                  type: 'date',
                  value: current.visit_date || KRY.localISO(0),
                  required: true,
                }),
                field({
                  name: 'visit_time',
                  label: t('sv.visitTime'),
                  placeholder: '11:30 AM',
                  value: current.visit_time || '',
                }),
              ),
            );

            body.appendChild(
              el(
                'label',
                { class: 'checkbox-row', style: 'margin-bottom: 10px;' },
                el('input', {
                  type: 'checkbox',
                  name: 'customer_present',
                  checked: current.customer_present !== false,
                }),
                el('span', { text: t('sv.customerPresent') || 'Customer was present on site' }),
              ),
            );

            // Ground & Plot Measurements
            body.appendChild(
              field({
                name: 'measurements',
                label:
                  t('sv.measurements') || 'Plot Measurements & Built-Up Area (ज़मीनी माप व आकार)',
                type: 'textarea',
                rows: 2,
                value: current.measurements || '',
                placeholder:
                  'e.g. Plot size 30x60 ft (1800 sq ft), Road width 25 ft, Front setback 5 ft, Boundary clear.',
                hint: 'Record length, breadth, road access width and setback boundaries.',
              }),
            );

            // Ground Feasibility & Infrastructure Conditions
            body.appendChild(
              field({
                name: 'site_condition',
                label: 'Site Access & Ground Feasibility (रास्ता, पानी, बिजली व ज़मीन की स्थिति)',
                type: 'textarea',
                rows: 2,
                value: current.site_condition || '',
                placeholder:
                  'e.g. Road is 25 ft wide and transit mixer accessible. Ground is plain with 2 ft filling needed. Borewell water available. Temporary electricity connection required.',
              }),
            );

            // Customer Intent & Feedback
            body.appendChild(
              field({
                name: 'customer_feedback',
                label: t('sv.customerFeedback') || 'Customer Feedback & Expectations on Site',
                type: 'textarea',
                rows: 2,
                value: current.customer_feedback || '',
                placeholder:
                  'e.g. Customer wants quick completion within 5 months. Emphasized quality of cement and concealed fittings.',
              }),
            );

            return body;
          },
          collect(current, root) {
            current.visit_date = String(valueOf(root, 'visit_date')) || KRY.localISO(0);
            current.visit_time = String(valueOf(root, 'visit_time')).trim();
            current.customer_present = Boolean(valueOf(root, 'customer_present'));
            current.measurements = String(valueOf(root, 'measurements')).trim();
            current.site_condition = String(valueOf(root, 'site_condition')).trim();
            current.customer_feedback = String(valueOf(root, 'customer_feedback')).trim();
            return null;
          },
        },
        {
          titleKey: 'sv.costStep3',
          render(current, ctx) {
            return renderPreConstructionUploadStep(current, ctx);
          },
          collect(current) {
            // Optional - never blocks progression!
            return null;
          },
        },
        {
          titleKey: 'sv.costStep4',
          render(current) {
            current.photos = Array.isArray(current.photos) ? current.photos : [];
            const body = el('div', { class: 'stack' });

            const estCost =
              Number(current.estimated_cost) ||
              ((Number(current.civil_cost) || 0) +
                (Number(current.interior_cost) || 0) +
                (Number(current.mep_cost) || 0) +
                (Number(current.labor_logistics_cost) || 0));
            current.estimated_cost = estCost;

            body.appendChild(
              el(
                'div',
                {
                  class: 'review-box summary-row',
                  style:
                    'display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 16px; background: var(--surface-alt); border: 1px solid var(--line); border-radius: var(--radius-sm); margin-bottom: 12px;',
                },
                el(
                  'span',
                  { style: 'display: flex; align-items: center; gap: 6px; font-weight: 600;' },
                  icon('check'),
                  t('sv.photoCount', { count: current.photos.length }),
                ),
                el(
                  'span',
                  {
                    style:
                      'display: flex; align-items: center; gap: 6px; font-weight: 700; color: #047857;',
                  },
                  icon('rupee'),
                  estCost > 0
                    ? `Est. Cost: ₹${estCost.toLocaleString('en-IN')}`
                    : 'Cost: Pending calculation',
                ),
                el(
                  'span',
                  { style: 'display: flex; align-items: center; gap: 6px; color: var(--muted);' },
                  icon('clock'),
                  `Timeline: ${current.estimated_timeline || 'Standard'}`,
                ),
                el(
                  'span',
                  { style: 'display: flex; align-items: center; gap: 6px;' },
                  icon('mic'),
                  current.voice ? t('sv.voiceReady') : t('common.none'),
                ),
              ),
            );

            // Highlighted Sales Negotiation Advice (Crucial for Admin routing to Sales)
            body.appendChild(
              el(
                'div',
                {
                  style:
                    'background: var(--surface-alt); border: 1.5px solid #d97706; border-radius: 8px; padding: 14px 16px; margin: 10px 0;',
                },
                el(
                  'div',
                  {
                    style:
                      'font-weight: 700; color: #d97706; display: flex; align-items: center; gap: 6px; font-size: 14px; margin-bottom: 4px;',
                  },
                  icon('rupee'),
                  t('sv.salesAdvice') ||
                    'Commercial Advice for Sales Team (Negotiation Strategy & Margin Protection)',
                ),
                el(
                  'p',
                  { class: 'small muted', style: 'margin-bottom: 8px;' },
                  t('sv.salesAdviceHelp') ||
                    'Guide the Sales Manager on client budget expectations, ground difficulties, and safe margin limits for negotiation.',
                ),
                el('textarea', {
                  name: 'sales_advice',
                  rows: 3,
                  style:
                    'width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--ink);',
                  placeholder:
                    'e.g. Client budget expectation is around 25L, but site ground reality requires minimum 27L due to soil filling. Advise Sales to pitch initial quote at 30L and hold firm at 28L to protect project margin.',
                  value: current.sales_advice || '',
                  onInput: (e) => {
                    current.sales_advice = e.target.value.trim();
                  },
                }),
              ),
            );

            // Technical Report Summary
            const defaultReport = `Pre-construction feasibility & cost estimation on ${current.visit_date || KRY.localISO(0)}. Overall Cost: ₹${estCost.toLocaleString('en-IN')}. Timeline: ${current.estimated_timeline || 'Standard'}. Risk Level: ${current.site_risk_level || 'Low'}. Scope: ${current.scope_details || 'General construction'}. Plot measurements: ${current.measurements || 'Inspected on site'}.`;
            if (!current.report) current.report = defaultReport;

            body.appendChild(
              field({
                name: 'technical_report',
                label:
                  t('sv.report') || 'Engineering Feasibility & Technical Summary for Admin Desk',
                type: 'textarea',
                rows: 4,
                value: current.report || defaultReport,
              }),
            );

            // Recommendations
            body.appendChild(
              field({
                name: 'recommendation',
                label: t('sv.recommendation') || 'Engineering Recommendations for Management',
                type: 'textarea',
                rows: 2,
                value: current.recommendation || '',
                placeholder:
                  'e.g. Soil testing report recommended before foundation excavation. Clear municipal line access verified.',
              }),
            );

            return body;
          },
          collect(current, root) {
            const salesAdv = root.querySelector('[name="sales_advice"]');
            if (salesAdv && salesAdv.value) current.sales_advice = String(salesAdv.value).trim();
            const rawReport = valueOf(root, 'technical_report');
            const techReportVal = rawReport ? String(rawReport).trim() : '';
            const estCost = Number(current.estimated_cost) || 0;
            const defaultReport = `Pre-construction feasibility & cost estimation on ${current.visit_date || KRY.localISO(0)}. Overall Cost: ₹${estCost.toLocaleString('en-IN')}. Timeline: ${current.estimated_timeline || 'Standard'}. Risk Level: ${current.site_risk_level || 'Low'}. Scope: ${current.scope_details || 'General construction'}. Plot measurements: ${current.measurements || 'Inspected on site'}.`;
            current.report = techReportVal || current.report || defaultReport;
            const rawRec = valueOf(root, 'recommendation');
            current.recommendation = rawRec ? String(rawRec).trim() : '';
            return null;
          },
        },
      ];
    } else {
      /* =========================================================================
       * MODE 2: Active Construction Technical Quality Inspection
       * (Work Order Approved / Active Project Execution on Ground)
       * ========================================================================= */
      steps = [
        {
          titleKey: 'sv.inspStep1',
          render(current, ctx) {
            const body = el('div', { class: 'stack' });
            body.appendChild(modeSwitcherBar('inspection'));

            body.appendChild(
              el(
                'div',
                { class: 'form-grid' },
                field({
                  name: 'construction_stage',
                  label: 'Active Construction Stage (निर्माण चरण)',
                  type: 'select',
                  value: current.construction_stage || 'RCC Columns & Slab Casting',
                  options: [
                    { value: 'Excavation & Footing', label: '1. Excavation & Footing (नींव व खुदाई)' },
                    { value: 'Plinth Beam & DPC', label: '2. Plinth Beam & DPC (प्लिंथ बीम)' },
                    {
                      value: 'RCC Columns & Slab Casting',
                      label: '3. RCC Columns & Slab (कॉलम व छत ढलाई)',
                    },
                    {
                      value: 'Brick Masonry & Plaster',
                      label: '4. Brickwork & Plaster (ईंट चुनाई व प्लास्टर)',
                    },
                    {
                      value: 'MEP Conduits & Plumbing Lines',
                      label: '5. MEP Lines & Conduits (बिजली व प्लंबिंग फिटिंग)',
                    },
                    {
                      value: 'Flooring, Tiling & Painting',
                      label: '6. Flooring & Finishing (फर्श, टाइल व पुट्टी)',
                    },
                    {
                      value: 'Pre-Handover & Final Snagging',
                      label: '7. Pre-Handover & Snags (हैंडओवर व स्नैग लिस्ट)',
                    },
                  ],
                }),
                field({
                  name: 'visit_date',
                  label: t('sv.visitDate'),
                  type: 'date',
                  value: current.visit_date || KRY.localISO(0),
                  required: true,
                }),
              ),
            );

            body.appendChild(
              el(
                'div',
                { class: 'checklist-head' },
                el(
                  'div',
                  {},
                  el('h4', { text: t('sv.checklist') || 'Technical Quality Audit Checklist' }),
                  el(
                    'p',
                    { class: 'small muted', text: t('sv.checklistHelp') },
                  ),
                ),
                el(
                  'span',
                  { class: 'issue-pill' },
                  icon('alert'),
                  el('strong', {
                    dataset: { issueCount: '' },
                    text: String(
                      Object.values(data.checklist).filter((value) => value === 'issue').length,
                    ),
                  }),
                  t('sv.state.issue'),
                ),
              ),
            );

            CHECKLIST.forEach((group) => {
              const groupNode = el(
                'div',
                { class: 'checklist-group' },
                el('h5', { text: t(group.labelKey) }),
              );
              group.items.forEach((item) => groupNode.appendChild(checkRow(item, ctx.rerender)));
              body.appendChild(groupNode);
            });

            body.appendChild(
              el(
                'label',
                { class: 'checkbox-row', style: 'margin-top: 10px;' },
                el('input', {
                  type: 'checkbox',
                  name: 'customer_present',
                  checked: current.customer_present !== false,
                }),
                el('span', { text: t('sv.customerPresent') || 'Client / Supervisor was present' }),
              ),
            );

            return body;
          },
          collect(current, root) {
            current.construction_stage = String(valueOf(root, 'construction_stage')).trim();
            current.visit_date = String(valueOf(root, 'visit_date')) || KRY.localISO(0);
            current.customer_present = Boolean(valueOf(root, 'customer_present'));
            CHECKLIST.forEach((group) => {
              group.items.forEach((item) => {
                const note = root.querySelector(`[name="note_${item.key}"]`);
                if (note) current.checkNotes[item.key] = String(note.value).trim();
              });
            });
            return null;
          },
        },
        {
          titleKey: 'sv.inspStep2',
          render(current, ctx) {
            return renderPhotoVoiceStep(
              current,
              ctx,
              'Upload site construction progress photos, casting quality, safety compliance, or defect evidence.',
            );
          },
          collect(current) {
            if (current.recording) return t('sv.stopFirst');
            return null;
          },
        },
        {
          titleKey: 'sv.inspStep3',
          render(current) {
            const body = el('div', { class: 'stack' });
            const composed = checklistReport(current);

            body.appendChild(
              el(
                'div',
                { class: 'form-grid' },
                field({
                  name: 'progress_pct',
                  label: 'Estimated Physical Progress % (कार्य प्रगति %)',
                  type: 'select',
                  value: current.progress_pct || '25%',
                  options: [
                    { value: '10%', label: '10% — Foundation & Plinth' },
                    { value: '25%', label: '25% — Ground Floor Columns / Slab' },
                    { value: '50%', label: '50% — Full RCC Structure & Brickwork' },
                    { value: '75%', label: '75% — Plaster, MEP Lines & Flooring' },
                    { value: '90%', label: '90% — Painting, Fixtures & Finishing' },
                    { value: '100%', label: '100% — Handover & Snag Clearance' },
                  ],
                }),
                field({
                  name: 'measurements',
                  label: 'Workmanship / Dimensions Verified',
                  type: 'text',
                  value: current.measurements || '',
                  placeholder: 'e.g. Beam depth 450mm checked, slab curing day 7 verified.',
                }),
              ),
            );

            // Flagged Defect / Snag Notes
            body.appendChild(
              field({
                name: 'snag_notes',
                label: 'Corrective Action Required / Snag Rectification Instructions',
                type: 'textarea',
                rows: 3,
                value: current.snag_notes || '',
                placeholder:
                  'e.g. Minor honeycombing on column C-4 needs polymer grouting. Electric conduit pipe near kitchen needs realignment before plaster.',
                hint: 'Specific instructions for site contractor or project manager to fix before next stage.',
              }),
            );

            // Detailed Findings
            if (!current.report) current.report = composed.text;
            body.appendChild(
              field({
                name: 'technical_report',
                label: 'Comprehensive Technical Quality & Site Inspection Report',
                type: 'textarea',
                rows: 5,
                value: current.report || composed.text,
              }),
            );

            return body;
          },
          collect(current, root) {
            current.progress_pct = String(valueOf(root, 'progress_pct')).trim();
            current.measurements = String(valueOf(root, 'measurements')).trim();
            current.snag_notes = String(valueOf(root, 'snag_notes')).trim();
            current.report = String(valueOf(root, 'technical_report')).trim();
            return null;
          },
        },
        {
          titleKey: 'sv.inspStep4',
          render(current) {
            current.photos = Array.isArray(current.photos) ? current.photos : [];
            const composed = checklistReport(current);
            const body = el('div', { class: 'stack' });

            body.appendChild(
              el(
                'div',
                { class: 'review-box summary-row' },
                el('span', {}, icon('check'), t('sv.photoCount', { count: current.photos.length })),
                el('span', {}, icon('alert'), t('sv.itemsFlagged', { count: composed.issues })),
                el('span', {}, icon('folder'), `Stage: ${current.construction_stage || 'Active'}`),
                el('span', {}, icon('mic'), current.voice ? t('sv.voiceReady') : t('common.none')),
              ),
            );

            body.appendChild(
              field({
                name: 'recommendation',
                label: 'Engineering Quality Sign-off & Recommendations for Admin/PM',
                type: 'textarea',
                rows: 3,
                value: current.recommendation || '',
                placeholder:
                  'e.g. Quality approved for next slab shuttering. Re-inspection scheduled after honeycombing grouting.',
              }),
            );

            return body;
          },
          collect(current, root) {
            current.recommendation = String(valueOf(root, 'recommendation')).trim();
            return null;
          },
        },
      ];
    }

    openWizard({
      title: isCostMode
        ? t('sv.costTitle') || 'Pre-Construction Feasibility & Cost Estimation'
        : t('sv.inspTitle') || 'Active Construction Technical Quality Inspection',
      subtitle: `${task.customer_name || task.lead_id} · ${task.id}`,
      steps,
      initialData: data,
      submitLabel: t('submit.button') || 'Send to Admin Desk',
      size: 'wide',
      async onComplete(current) {
        if (current.recording) {
          throw new Error(t('sv.stopFirst'));
        }
        const composed = checklistReport(current);
        const estCost = Number(current.estimated_cost) || 0;

        let reportText = current.report;
        if (!reportText) {
          if (isCostMode) {
            reportText = `Pre-construction feasibility and cost estimation on ${current.visit_date}. Overall Cost: ₹${estCost.toLocaleString('en-IN')}. Timeline: ${current.estimated_timeline || 'Standard'}. Risk Level: ${current.site_risk_level || 'Low'}. Scope: ${current.scope_details || 'General construction'}. Plot measurements: ${current.measurements || 'Inspected on site'}.`;
          } else {
            reportText = `[Stage: ${current.construction_stage || 'Active'} | Progress: ${current.progress_pct || '0%'}] ${composed.text}${current.snag_notes ? `\nSnag Instructions: ${current.snag_notes}` : ''}`;
          }
        }

        const siteConditionText = isCostMode
          ? `Feasibility evaluated · Risk: ${current.site_risk_level || 'Low'}${current.site_condition ? ` · ${current.site_condition}` : ''}`
          : `[Stage: ${current.construction_stage || 'Active'} (${current.progress_pct || '0%'})] ${composed.issues} issue(s) out of ${composed.ok + composed.issues + composed.na}`;

        const result = await api('/site-visits', {
          method: 'POST',
          body: {
            lead_id: task.lead_id,
            task_id: task.id,
            visit_date: current.visit_date,
            visit_time: current.visit_time || null,
            site_condition: siteConditionText.slice(0, 2000),
            technical_report: reportText.slice(0, 8000),
            measurements: current.measurements || null,
            customer_present: Boolean(current.customer_present),
            customer_feedback: current.customer_feedback || null,
            recommendation: current.recommendation || null,
            estimated_cost: estCost,
            civil_cost: Number(current.civil_cost) || 0,
            interior_cost: Number(current.interior_cost) || 0,
            mep_cost: Number(current.mep_cost) || 0,
            labor_logistics_cost: Number(current.labor_logistics_cost) || 0,
            estimated_timeline: current.estimated_timeline || null,
            site_risk_level: current.site_risk_level || 'Low',
            scope_details: current.scope_details || null,
            sales_advice: current.sales_advice || null,
          },
        });

        let failed = false;
        try {
          if (current.photos.length) {
            await KRY.uploadAttachments({
              entityType: 'site_visit',
              entityId: result.site_visit_id,
              attachments: current.photos,
            });
          }
          if (current.voice) {
            await KRY.uploadAttachment({
              entityType: 'site_visit',
              entityId: result.site_visit_id,
              attachment: current.voice,
            });
          }
        } catch {
          failed = true;
        }

        toast(t('sv.submitted'), 'success');
        if (failed) toast(t('sv.notUploaded'), 'error');
        KRY.refreshNotifications();
        KRY.renderRoute();
        openTaskModal(task.id);
      },
    });
  }
  KRY.openSiteInspection = openSiteInspection;

  /* --------------------------------------------------------------- Site visits */

  registerPage('sitevisits', async () => {
    const visits = await api('/site-visits?limit=200');
    const wrap = el('div', { class: 'stack' });

    wrap.appendChild(
      pageHead(
        t('page.sitevisits.title'),
        t('site.noVisitsHelp'),
        KRY.roleIs('SITE_ENGINEER')
          ? [
              el(
                'button',
                { class: 'btn btn-primary', type: 'button', onClick: chooseInspectionTask },
                icon('plus'),
                t('site.newInspection'),
              ),
            ]
          : null,
      ),
    );

    wrap.appendChild(
      card(
        t('site.register'),
        `${visits.length}`,
        dataTable(
          [
            t('common.date'),
            t('common.customer'),
            t('site.report'),
            t('site.condition'),
            t('site.recommendation'),
          ],
          visits.map((visit) => ({
            cells: [
              fmtDate(visit.visit_date),
              el(
                'div',
                {},
                el('div', { class: 'cell-title', text: visit.customer_name || '—' }),
                el('div', { class: 'cell-sub mono', text: visit.lead_id }),
              ),
              el('span', {
                class: 'small',
                text: String(visit.technical_report || '').slice(0, 160),
              }),
              visit.site_condition || '—',
              el('span', {
                class: 'small',
                text: String(visit.recommendation || '—').slice(0, 100),
              }),
            ],
          })),
          { emptyTitle: t('site.noVisits'), emptyMessage: t('site.noVisitsHelp') },
        ),
        { tight: true },
      ),
    );
    return wrap;
  });

  async function chooseInspectionTask() {
    try {
      const tasks = await api('/tasks?department=Technical&limit=200');
      const open = tasks.filter(
        (task) =>
          task.assigned_to === KRY.state.user.id &&
          ['Assigned', 'In Progress'].includes(task.status),
      );
      if (!open.length) {
        toast(t('design.noTask'), 'error');
        return;
      }
      if (open.length === 1) {
        openSiteInspection(open[0]);
        return;
      }
      openModal({
        title: t('design.chooseTask'),
        subtitle: t('design.taskHelp'),
        body: el(
          'div',
          { class: 'list' },
          open.map((task) =>
            el(
              'div',
              { class: 'list-item' },
              el('span', { class: 'list-icon' }, icon('home')),
              el(
                'div',
                { class: 'list-body' },
                el('div', { class: 'list-title', text: task.customer_name || task.lead_id }),
                el('div', {
                  class: 'list-meta',
                  text: `${task.id} · ${KRY.taskTypeLabel(task.task_type)}`,
                }),
              ),
              el('button', {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                text: t('common.select'),
                onClick: () => openSiteInspection(task),
              }),
            ),
          ),
        ),
        actions: [{ label: t('common.cancel'), onClick: closeModal }],
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ----------------------------------------------------------------- Drawings */

  registerPage('designs', async () => {
    const designs = await api('/designs?limit=200');
    const wrap = el('div', { class: 'stack' });

    wrap.appendChild(
      pageHead(
        t('page.designs.title'),
        t('design.taskHelp'),
        KRY.roleIs('ARCHITECT')
          ? [
              el(
                'button',
                { class: 'btn btn-primary', type: 'button', onClick: chooseDesignTask },
                icon('plus'),
                t('design.newVersion'),
              ),
            ]
          : null,
      ),
    );

    wrap.appendChild(
      card(
        t('design.register'),
        `${designs.length}`,
        dataTable(
          [
            t('design.version'),
            t('common.customer'),
            t('design.type'),
            t('design.description'),
            t('common.status'),
            '',
          ],
          designs.map((design) => ({
            cells: [
              el('span', { class: 'mono', text: `v${design.version}` }),
              el(
                'div',
                {},
                el('div', { class: 'cell-title', text: design.customer_name || '—' }),
                el('div', { class: 'cell-sub mono', text: design.lead_id }),
              ),
              design.design_type || '—',
              el('span', { class: 'small', text: String(design.description || '').slice(0, 140) }),
              statusBadge(design.status),
              isCentral()
                ? el('button', {
                    class: 'btn btn-sm',
                    type: 'button',
                    text: t('design.review'),
                    onClick: () => reviewDesign(design),
                  })
                : design.file_url
                  ? el('span', { class: 'small muted', text: design.file_url })
                  : '—',
            ],
          })),
          { emptyTitle: t('design.noDesigns'), emptyMessage: t('design.noDesignsHelp') },
        ),
        { tight: true },
      ),
    );
    return wrap;
  });

  async function chooseDesignTask() {
    try {
      const tasks = await api('/tasks?department=Design&limit=200');
      const open = tasks.filter(
        (task) =>
          task.assigned_to === KRY.state.user.id &&
          ['Assigned', 'In Progress'].includes(task.status),
      );
      if (!open.length) {
        toast(t('design.noTask'), 'error');
        return;
      }
      if (open.length === 1) {
        openDesignSubmission(open[0]);
        return;
      }
      openModal({
        title: t('design.chooseTask'),
        subtitle: t('design.taskHelp'),
        body: el(
          'div',
          { class: 'list' },
          open.map((task) =>
            el(
              'div',
              { class: 'list-item' },
              el('span', { class: 'list-icon' }, icon('doc')),
              el(
                'div',
                { class: 'list-body' },
                el('div', { class: 'list-title', text: task.customer_name || task.lead_id }),
                el('div', {
                  class: 'list-meta',
                  text: `${task.id} · ${KRY.taskTypeLabel(task.task_type)}`,
                }),
              ),
              el('button', {
                class: 'btn btn-sm btn-primary',
                type: 'button',
                text: t('common.select'),
                onClick: () => openDesignSubmission(task),
              }),
            ),
          ),
        ),
        actions: [{ label: t('common.cancel'), onClick: closeModal }],
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openDesignSubmission(task) {
    const types = [
      { value: '2D Floor Plan', label: '2D Floor Plan', icon: 'grid' },
      { value: '3D Render', label: '3D Render', icon: 'folder' },
      { value: 'Working Drawing', label: 'Working Drawing', icon: 'doc' },
      { value: 'MEP Drawing', label: 'MEP Drawing', icon: 'shield' },
      { value: 'Custom', label: t('quote.templateCustom'), icon: 'plus' },
    ];

    const steps = [
      {
        titleKey: 'design.type',
        render(data) {
          data.design_type = data.design_type || '2D Floor Plan';
          return el(
            'div',
            { class: 'stack' },
            choiceCards(types, data.design_type, (value) => {
              data.design_type = value;
            }),
            field({
              name: 'file_url',
              label: t('design.file'),
              value: data.file_url || '',
              placeholder: 'Drive / NAS / DMS reference',
            }),
          );
        },
        collect(data, root) {
          data.file_url = String(valueOf(root, 'file_url')).trim();
          return null;
        },
      },
      {
        titleKey: 'design.description',
        render(data) {
          return el(
            'div',
            { class: 'stack' },
            field({
              name: 'description',
              label: t('design.description'),
              type: 'textarea',
              rows: 5,
              required: true,
              value: data.description || '',
              placeholder: t('design.descriptionPlaceholder'),
            }),
          );
        },
        collect(data, root) {
          data.description = String(valueOf(root, 'description')).trim();
          if (!data.description) return t('wizard.required');
          return null;
        },
      },
    ];

    openWizard({
      title: t('design.newVersion'),
      subtitle: `${task.customer_name || task.lead_id} · ${task.id}`,
      steps,
      submitLabel: t('design.submit'),
      async onComplete(data) {
        await api('/designs', {
          method: 'POST',
          body: {
            lead_id: task.lead_id,
            task_id: task.id,
            design_type: data.design_type,
            file_url: data.file_url || null,
            description: data.description,
          },
        });
        toast(t('design.done'), 'success');
        KRY.refreshNotifications();
        KRY.renderRoute();
        openTaskModal(task.id);
      },
    });
  }
  KRY.openDesignSubmission = openDesignSubmission;

  function reviewDesign(design) {
    openFormModal({
      title: t('design.review'),
      subtitle: `${design.customer_name || design.lead_id} · v${design.version}`,
      submitLabel: t('common.save'),
      fields: [
        {
          name: 'status',
          label: t('design.outcome'),
          type: 'select',
          value: 'Approved',
          options: ['Submitted', 'Revision Needed', 'Approved', 'Rejected'].map((value) => ({
            value,
            label: KRY.statusLabel(value),
          })),
        },
        { name: 'remarks', label: t('design.remarks'), type: 'textarea', span2: true },
      ],
      onSubmit: async (values) => {
        if (
          ['Revision Needed', 'Rejected'].includes(values.status) &&
          !String(values.remarks || '').trim()
        ) {
          throw new Error(t('design.remarks'));
        }
        await api(`/designs/${design.id}`, { method: 'PATCH', body: values });
        toast(t('task.reviewDone'), 'success');
      },
      onSuccess: () => KRY.renderRoute(),
    });
  }
})();
