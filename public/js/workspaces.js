'use strict';

// Specialist entry points share the same persisted records and review workflows.
(function () {
  const K = window.KRY;
  const { el, api, card, pageHead, dataTable, emptyState, money, fmtDate, statusBadge } = K;
  const button = (label, onClick, primary = false) => el('button', {
    type: 'button', class: `btn ${primary ? 'btn-primary' : ''}`, text: label, onClick,
  });
  const screen = (title, description, content, actions = []) => el('div', { class: 'stack' },
    pageHead(title, description, actions), content);
  const options = (rows) => rows.map((row) => ({ value: row.id, label: `${row.customer_name || row.id} · ${row.id}` }));
  const refresh = () => K.renderRoute();

  // Keep existing bookmarked routes useful without maintaining duplicate forms.
  for (const [alias, target] of Object.entries({
    designvault: 'designs', revisions: 'designs', measurements: 'sitevisits',
    payables: 'purchaseorders', quoteapprovals: 'quotations',
    campaigns: 'tasks', contentcalendar: 'tasks',
  })) K.registerPage(alias, () => K.pages[target]());

  K.registerPage('leadanalytics', async () => {
    const leads = await api('/leads?limit=500');
    const sources = new Map();
    for (const lead of leads) {
      const source = lead.source || 'Not recorded';
      const entry = sources.get(source) || { total: 0, won: 0 };
      entry.total += 1;
      if (lead.stage === 'Won' || lead.stage === 'Work Order Confirmed') entry.won += 1;
      sources.set(source, entry);
    }
    return screen('Lead sources', `Based on ${leads.length} accessible leads (up to 500 most recent).`,
      card('Source performance', 'Recorded opportunities and won deals', dataTable(
        ['Source', 'Leads', 'Won', 'Conversion'], [...sources].map(([source, value]) => ({
          cells: [source, value.total, value.won, `${Math.round(value.won / value.total * 100)}%`],
        })), { emptyTitle: 'No lead sources yet', emptyMessage: 'Create a lead with its source to start tracking acquisition.' })));
  });
  K.registerPage('targets', async () => screen('Sales performance', 'Recorded quotations; targets have not been configured.',
    await K.pages.quotations()));

  K.registerPage('procurement', () => K.pages.tasks());
  K.registerPage('vendors', async () => screen('Supplier records', 'Supplier quotations are recorded against Admin-assigned procurement tasks.',
    card('Procurement workspace', 'Open a task to review or submit its supplier quotation.',
      button('Open procurement tasks', () => K.navigate('procurement'), true))));
  K.registerPage('purchaseorders', async () => {
    const requests = await api('/purchase-requests');
    return screen('Purchase requests', 'Recorded material requests and Admin approval status.',
      card('Procurement register', `${requests.length} requests`, dataTable(
        ['Reference', 'Project', 'Material', 'Quantity', 'Estimated cost', 'Status'],
        requests.map((row) => ({ cells: [row.id, row.customer_name, row.item_name, `${row.quantity} ${row.unit}`,
          money(row.estimated_cost_paise / 100), statusBadge(row.status)] })),
        { emptyTitle: 'No purchase requests yet', emptyMessage: 'Requests raised against projects will appear here.' })));
  });

  async function billingRows() {
    const [invoices, payments] = await Promise.all([api('/invoices'), api('/payments')]);
    return invoices.map((invoice) => {
      const paid = payments.filter((p) => p.invoice_id === invoice.id && ['Received', 'Cleared'].includes(p.status))
        .reduce((sum, p) => sum + Number(p.amount_paise), 0);
      return { ...invoice, paid, outstanding: Math.max(0, Number(invoice.total_paise) - paid) };
    });
  }

  function recordPayment(invoice) {
    K.openFormModal({
      title: `Record payment · ${invoice.invoice_number || invoice.id}`,
      subtitle: `${invoice.customer_name} · Outstanding ${money(invoice.outstanding / 100)}`,
      submitLabel: 'Record receipt',
      fields: [
        { name: 'amount', label: 'Amount received (₹)', type: 'number', min: 0.01, step: 0.01, max: invoice.outstanding / 100, required: true },
        { name: 'payment_mode', label: 'Payment method', type: 'select', options: ['UPI', 'NEFT_RTGS', 'BANK_TRANSFER', 'CHEQUE', 'CASH'].map((value) => ({ value, label: value.replaceAll('_', ' ') })) },
        { name: 'reference_number', label: 'UTR / receipt reference', required: true },
        { name: 'payment_date', label: 'Payment date', type: 'date', required: true },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
      onSubmit: async ({ amount, ...values }) => {
        await api(`/invoices/${encodeURIComponent(invoice.id)}/payments`, { method: 'POST', body: { ...values, amount_paise: Math.round(amount * 100) } });
        K.toast('Payment receipt recorded.', 'success');
      }, onSuccess: refresh,
    });
  }

  async function invoiceScreen(outstandingOnly = false) {
    const rows = (await billingRows()).filter((row) => !outstandingOnly || (row.outstanding > 0 && row.status !== 'Cancelled'));
    return screen(outstandingOnly ? 'Receivables' : 'Invoices', 'Amounts include recorded tax. Payments are matched to invoice references.',
      card(outstandingOnly ? 'Outstanding invoices' : 'Invoice register', `${rows.length} records`, dataTable(
        ['Invoice', 'Customer', 'Due date', 'Total', 'Received', 'Outstanding', 'Status', 'Action'],
        rows.map((row) => ({ cells: [row.invoice_number || row.id, row.customer_name, fmtDate(row.due_date),
          money(row.total_paise / 100), money(row.paid / 100), money(row.outstanding / 100), statusBadge(row.status),
          row.outstanding > 0 && row.status !== 'Cancelled' ? button('Record payment', () => recordPayment(row)) : '—',
        ] })), { emptyTitle: outstandingOnly ? 'No outstanding invoices' : 'No invoices yet',
          emptyMessage: 'Invoices and receipts appear here after they are recorded against a work order.' })),
      [button('Create invoice', () => K.openGenerateInvoiceModal(), true)]);
  }
  K.registerPage('invoices', () => invoiceScreen());
  K.registerPage('receivables', () => invoiceScreen(true));
  K.registerPage('ledger', async () => {
    const [orders, payments] = await Promise.all([api('/workorders'), api('/payments')]);
    return screen('Work order ledger', 'Contract value and recorded receipts. Invoice tax is tracked separately in the invoice register.',
      card('Contract receipts', `${orders.length} work orders`, dataTable(['Work order', 'Customer', 'Contract value', 'Receipts', 'Status'],
        orders.map((order) => ({ cells: [order.id, order.customer_name, money(order.amount),
          money(payments.filter((p) => p.work_order_id === order.id && ['Received', 'Cleared'].includes(p.status))
            .reduce((sum, p) => sum + Number(p.amount_paise), 0) / 100), statusBadge(order.status)] })),
        { emptyTitle: 'No work orders yet', emptyMessage: 'Approved work orders will appear here.' })));
  });

  K.openGenerateInvoiceModal = async () => {
    try {
      const orders = await api('/workorders');
      if (!orders.length) return K.openModal({ title: 'No work orders available', body: emptyState('A work order is required', 'Admin Desk must approve the contract before billing can begin.') });
      K.openFormModal({ title: 'Create invoice', subtitle: 'Review the applicable tax rate before saving.', submitLabel: 'Create invoice', fields: [
        { name: 'work_order_id', label: 'Work order', type: 'select', options: options(orders), required: true },
        { name: 'invoice_type', label: 'Invoice type', type: 'select', options: ['TAX_INVOICE', 'ADVANCE_INVOICE', 'PROFORMA'].map((value) => ({ value, label: value.replaceAll('_', ' ') })) },
        { name: 'amount', label: 'Taxable amount (₹)', type: 'number', min: 0.01, step: 0.01, required: true },
        { name: 'gst_rate', label: 'GST rate (%)', type: 'number', min: 0, max: 100, step: 0.01, required: true },
        { name: 'due_date', label: 'Due date', type: 'date', required: true },
      ], onSubmit: async ({ work_order_id, amount, ...values }) => {
        await api(`/work-orders/${encodeURIComponent(work_order_id)}/invoices`, { method: 'POST', body: { ...values, subtotal_paise: Math.round(amount * 100) } });
        K.toast('Invoice created.', 'success');
      }, onSuccess: refresh });
    } catch (err) { K.toast(err.message, 'error'); }
  };

  K.openQuickPhotoModal = async () => {
    try {
      const projects = await api('/projects');
      if (!projects.length) return K.openModal({ title: 'No assigned projects', body: emptyState('No project available', 'Ask Admin Desk to assign a project before uploading site photos.') });
      const file = el('input', { type: 'file', accept: 'image/*', capture: 'environment', required: true });
      K.openFormModal({ title: 'Add site photo', subtitle: 'The photo is stored against the selected project.', submitLabel: 'Upload photo',
        fields: [{ name: 'project_id', label: 'Project', type: 'select', options: options(projects), required: true },
          { name: 'caption', label: 'Photo description', type: 'textarea', required: true }],
        body: el('label', { class: 'field' }, el('span', { text: 'Camera or image file' }), file),
        onSubmit: async (values) => {
          if (!file.files[0]) throw new Error('Choose a photo first.');
          const attachment = await K.fileToAttachment(file.files[0], values.caption);
          await K.uploadAttachment({ entityType: 'project', entityId: values.project_id, attachment });
          K.toast('Site photo uploaded.', 'success');
        }, onSuccess: refresh });
    } catch (err) { K.toast(err.message, 'error'); }
  };

  K.registerPage('settings', async () => screen('Workspace preferences', 'Appearance and account information.',
    card('Appearance', 'Saved for this browser', el('div', { class: 'stack' },
      el('p', { class: 'muted', text: 'Choose Light, Dark or System using the appearance control in the top bar. Account permissions and assignments are managed by Admin Desk.' }),
      button('Change appearance', () => document.getElementById('themeSelect').focus())))));
})();
