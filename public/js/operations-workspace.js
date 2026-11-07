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
      qs('#advancedReportGrid').innerHTML = '';
      return;
    }

    const renderGroups = (title, result) => {
      const groups = result.groups.length
        ? `<ul>${result.groups.map((group) => `<li><span>${e(group.key)}</span><strong>${e(group.count)}</strong></li>`).join('')}</ul>`
        : '<p class="subtle">No groups meet the minimum reporting threshold.</p>';
      const suppressed = result.suppressedGroups
        ? `<p class="subtle">${e(result.suppressedGroups)} group(s) suppressed to protect privacy.</p>`
        : '';
      return `<section class="panel analytics-card"><h3>${e(title)}</h3>${groups}${suppressed}</section>`;
    };
    const monthlyRows = report.advanced.monthly.length
      ? `<div class="analytics-monthly">${report.advanced.monthly.map((item) => `
          <div class="analytics-month">
            <strong>${e(item.month)}</strong>
            <span>Leads: ${item.leads < 5 ? 'Suppressed' : e(item.leads)}</span>
            <span>Referrals: ${item.referrals < 5 ? 'Suppressed' : e(item.referrals)}</span>
          </div>
        `).join('')}</div>`
      : '<p class="subtle">No records in this date range.</p>';

    const period = report.advanced.period;
    qs('#reportPeriod').textContent = period
      ? `Records created ${period.from || 'from the earliest record'} through ${period.to || 'the latest record'}. Provider counts reflect current status.`
      : 'Showing all available records. Provider counts reflect current status.';
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
    qs('#advancedReportGrid').innerHTML = `
      <section class="panel analytics-card"><h3>Monthly volume</h3>${monthlyRows}<p class="subtle">Counts below five are suppressed.</p></section>
      ${renderGroups('Leads by country', report.advanced.leadsByCountry)}
      ${renderGroups('Leads by care type', report.advanced.leadsByCareType)}
      ${renderGroups('Referrals by provider', report.advanced.referralsByProvider)}
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
    await loadOnboardingApplications();
  }

  async function loadOnboardingApplications() {
    const panel = qs('#onboardingReviewPanel');
    if (!panel) return;
    if (state.user?.role !== 'admin') {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    const applications = await api('/api/v1/onboarding/applications');
    qs('#onboardingApplicationList').innerHTML = applications.length
      ? applications.map((application) => `
          <article class="item">
            <div class="item-row">
              <strong>${e(application.type === 'clinician' ? 'Clinician' : 'Provider staff')} · ${e(application.applicant ? `${application.applicant.firstName} ${application.applicant.lastName}` : 'Unknown applicant')}</strong>
              <span class="badge ${application.status === 'approved' ? 'ok' : application.status === 'rejected' ? 'bad' : 'warn'}">${e(application.status)}</span>
            </div>
            <div>${e(application.provider?.name || 'Provider unavailable')} · ${e(application.createdAt?.slice(0, 10) || 'Unknown submission date')}</div>
            <div class="subtle">${e(application.applicant?.email || 'No email')} · ${e(application.applicant?.phone || 'No phone')}</div>
            ${application.type === 'clinician'
              ? `<div>${e(application.professionalTitle || 'Clinician')} · License: ${e(application.licenseNumber || 'Not supplied')} · Specialties: ${e(application.specialtyIds?.length || 0)}</div>`
              : `<div>${e(application.jobTitle || 'Provider staff')}</div>`}
            ${application.status === 'pending' ? `
              <div class="actions">
                <button data-review-onboarding="${e(application.id)}" data-review-status="approved">Approve and grant access</button>
                <button class="secondary" data-review-onboarding="${e(application.id)}" data-review-status="rejected">Reject</button>
              </div>
            ` : ''}
          </article>
        `).join('')
      : '<div class="empty">No onboarding applications.</div>';
  }

  async function loadReports() {
    const query = new URLSearchParams();
    const from = qs('#reportFilters [name="from"]')?.value;
    const to = qs('#reportFilters [name="to"]')?.value;
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const suffix = query.size ? `?${query}` : '';
    const report = await api(`/api/v1/reports/summary${suffix}`);
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

    await loadOnboardingApplications();
    renderReports(workspace?.reportSummary || null);
    return workspace;
  }

  return {
    loadLeads,
    loadReferrals,
    loadProviders,
    loadOnboardingApplications,
    loadReports,
    loadOperationsWorkspace
  };
}
