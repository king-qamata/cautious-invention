export function createOperationsWorkspaceController(deps) {
  const {
    state,
    qs,
    e,
    api,
    badgeTone,
    procedureOptions,
    renderReferralDetail
  } = deps;

  function renderLead(lead) {
    const nextStage = {
      awareness: 'landing_page',
      landing_page: 'application',
      application: 'screening',
      screening: 'provider_match',
      provider_match: 'booking',
      booking: 'consultation',
      consultation: 'retention'
    }[lead.funnelStage || 'application'];
    return `
      <article class="item">
        <div class="item-row">
          <strong>${e(lead.name)}</strong>
          <span class="badge">${e(lead.status)}</span>
        </div>
        <div>${e(lead.healthcareRequirement)}</div>
        <div class="subtle">${e(lead.phone)} · ${e(lead.location || 'No location')} · ${e(lead.channel)} · ${e(lead.preferredUrgency || 'normal')} · stage: ${e(lead.funnelStage || 'application')}</div>
        <div class="actions">
          <select data-lead-procedure="${e(lead.id)}">${procedureOptions()}</select>
          <button data-convert="${e(lead.id)}">Convert</button>
          <button class="secondary" data-qualify="${e(lead.id)}">Qualify</button>
          ${nextStage ? `<button class="secondary" data-funnel-stage="${e(lead.id)}" data-next-stage="${nextStage}">Advance to ${e(nextStage.replace('_', ' '))}</button>` : ''}
        </div>
      </article>
    `;
  }

  function renderReferralRow(referral) {
    return `
      <article class="item">
        <div class="item-row">
          <strong>${e(referral.referralNumber)}</strong>
          <span class="badge ${badgeTone(referral.status)}">${e(referral.status)}</span>
        </div>
        <div>${e(referral.healthcareRequirement)}</div>
        <div class="subtle">${e(referral.patient?.name || 'Unknown patient')} · ${e(referral.procedure?.name || 'No procedure')} · ${e(referral.provider?.name || 'No provider assigned')}</div>
        <div class="actions">
          <button data-select-referral="${e(referral.referralNumber)}">Open</button>
        </div>
      </article>
    `;
  }

  function renderReports(report) {
    if (!report) {
      qs('#reportGrid').innerHTML = '<div class="empty">Report access is not available for this role.</div>';
      return;
    }

    qs('#reportGrid').innerHTML = `
      <div class="metric"><span>Total Leads</span><strong>${e(report.leads.total)}</strong><div class="subtle">${e(JSON.stringify(report.leads.byStatus))}</div></div>
      <div class="metric"><span>Total Referrals</span><strong>${e(report.referrals.total)}</strong><div class="subtle">${e(JSON.stringify(report.referrals.byStatus))}</div></div>
      <div class="metric"><span>Stale Referrals</span><strong>${e(report.referrals.stale)}</strong><div class="subtle">Open for more than 3 days</div></div>
      <div class="metric"><span>Active Providers</span><strong>${e(report.providers.active)}</strong><div class="subtle">${e(report.providers.trained)} trained</div></div>
      <div class="metric"><span>Lead Conversion</span><strong>${e(report.leads.conversionRate)}%</strong><div class="subtle">${e(JSON.stringify(report.leads.byChannel))}</div></div>
      <div class="metric"><span>Screened Leads</span><strong>${e(report.leads.screened)}</strong><div class="subtle">${e(JSON.stringify(report.leads.funnel))}</div></div>
      <div class="metric"><span>Preferred urgency</span><strong>${e(report.leads.preferredUrgency?.priority || 0)}</strong><div class="subtle">Priority requests</div></div>
      <div class="metric"><span>Avg Referral Turnaround</span><strong>${e(report.referrals.averageTurnaroundDays)}d</strong><div class="subtle">${e(report.referrals.completed)} completed referrals</div></div>
    `;
  }

  function applyReferralsToView(referrals) {
    state.referrals = Array.isArray(referrals) ? referrals : [];
    qs('#referralList').innerHTML = state.referrals.length ? state.referrals.map(renderReferralRow).join('') : '<div class="empty">No referrals yet.</div>';
    if (state.selectedReferral) {
      state.selectedReferral = state.referrals.find((item) => item.id === state.selectedReferral.id) || null;
      renderReferralDetail();
    }
  }

  async function loadLeads() {
    try {
      const leads = await api('/api/v1/leads');
      qs('#leadList').innerHTML = leads.length ? leads.map(renderLead).join('') : '<div class="empty">No leads yet.</div>';
    } catch (error) {
      qs('#leadList').innerHTML = `<div class="empty">${error.message}</div>`;
    }
  }

  async function loadReferrals() {
    const referrals = await api('/api/v1/referrals');
    applyReferralsToView(referrals);
  }

  async function loadProviders() {
    const providers = await api('/api/v1/providers');
    qs('#providerList').innerHTML = providers.map((provider) => `
      <article class="item">
        <div class="item-row">
          <strong>${e(provider.name)}</strong>
          <span class="badge ${provider.isActive ? 'ok' : 'bad'}">${e(provider.onboardingStatus)}</span>
        </div>
        <div class="subtle">${e(provider.type)} · ${e(provider.city)}, ${e(provider.state || provider.country)} · rating ${e(provider.rating || 0)}</div>
        <div>${e(provider.contactEmail || 'No contact email')} · training: ${e(provider.trainingStatus || 'not_started')}</div>
      </article>
    `).join('');
  }

  async function loadReports() {
    const report = await api('/api/v1/reports/summary');
    renderReports(report);
  }

  async function loadOperationsWorkspace(options = {}) {
    const query = new URLSearchParams();
    if (options.includeConsultations) {
      query.set('includeConsultations', 'true');
      const filters = options.consultationFilters || {};
      if (filters.sort) query.set('consultationSort', String(filters.sort));
      if (filters.status && String(filters.status) !== 'all') query.set('consultationStatus', String(filters.status));
      if (filters.tier && String(filters.tier) !== 'all') query.set('consultationTier', String(filters.tier));
      if (filters.search && String(filters.search).trim()) query.set('consultationSearch', String(filters.search).trim());
      if (options.includeConsultationComms) {
        query.set('includeConsultationComms', 'true');
        const interactionFilters = options.interactionFilters || {};
        if (interactionFilters.type && String(interactionFilters.type) !== 'all') {
          query.set('interactionType', String(interactionFilters.type));
        }
        if (interactionFilters.actorRole && String(interactionFilters.actorRole) !== 'all') {
          query.set('interactionActorRole', String(interactionFilters.actorRole));
        }
        if (interactionFilters.limit) {
          query.set('interactionLimit', String(interactionFilters.limit));
        }
      }
    }
    if (options.includeAccountWorkspace) {
      query.set('includeAccountWorkspace', 'true');
      const accountFilters = options.accountNotificationFilters || {};
      query.set('accountNotificationChannel', String(accountFilters.channel || 'all'));
      query.set('accountNotificationType', String(accountFilters.type || 'all'));
      query.set('accountNotificationSeverity', String(accountFilters.severity || 'all'));
      query.set('accountNotificationUnreadOnly', accountFilters.unreadOnly ? 'true' : 'false');
      query.set('accountNotificationLimit', String(accountFilters.limit || '50'));
    }
    const queryString = query.toString();
    const workspace = await api(`/api/v1/operations/workspace${queryString ? `?${queryString}` : ''}`);

    const leads = Array.isArray(workspace?.leads) ? workspace.leads : [];
    qs('#leadList').innerHTML = leads.length ? leads.map(renderLead).join('') : '<div class="empty">No leads yet.</div>';

    const referrals = Array.isArray(workspace?.referrals) ? workspace.referrals : [];
    applyReferralsToView(referrals);

    const providers = Array.isArray(workspace?.providers) ? workspace.providers : [];
    qs('#providerList').innerHTML = providers.map((provider) => `
      <article class="item">
        <div class="item-row">
          <strong>${e(provider.name)}</strong>
          <span class="badge ${provider.isActive ? 'ok' : 'bad'}">${e(provider.onboardingStatus)}</span>
        </div>
        <div class="subtle">${e(provider.type)} · ${e(provider.city)}, ${e(provider.state || provider.country)} · rating ${e(provider.rating || 0)}</div>
        <div>${e(provider.contactEmail || 'No contact email')} · training: ${e(provider.trainingStatus || 'not_started')}</div>
      </article>
    `).join('');

    renderReports(workspace?.reportSummary || null);
    return workspace;
  }

  return {
    loadLeads,
    loadReferrals,
    loadProviders,
    loadReports,
    loadOperationsWorkspace
  };
}
