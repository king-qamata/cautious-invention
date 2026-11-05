import {
  consultationQueuePresetCatalog,
  CONSULTATION_QUEUE_PRESET_KEY
} from './consultation-workspace-bindings.js';

const ACCOUNT_ROLE_PROFILES = {
  patient: {
    title: 'Patient Account',
    narrative: 'Track consultation status, keep profile details current, and triage communication updates from one screen.',
    shortcuts: [
      { label: 'My consultations', view: 'consultations', queuePreset: 'all_queue' },
      { label: 'Notification center', screen: 'notifications' },
      { label: 'Profile updates', screen: 'profile' }
    ],
    screenLibrary: [
      { title: 'Profile hub', caption: 'Identity and contact details', badge: 'Identity', screen: 'profile', actionLabel: 'Edit profile' },
      { title: 'Care alerts', caption: 'Unread and critical care notifications', badge: 'Alerts', screen: 'notifications', actionLabel: 'Open notifications', metricKey: 'pendingConsultations' },
      { title: 'Consultation board', caption: 'Track active and completed sessions', badge: 'Care', view: 'consultations', queuePreset: 'all_queue', actionLabel: 'Open consultations', metricKey: 'consultations' },
      { title: 'Referral journey', caption: 'Monitor referral status and handoffs', badge: 'Journey', view: 'referrals', actionLabel: 'Open referrals', metricKey: 'referrals' }
    ],
    operations: [
      { title: 'Follow up pending consults', detail: 'Review pending items and resolve communication blockers quickly.', metricKey: 'pendingConsultations', actionLabel: 'Open consultation board', view: 'consultations', queuePreset: 'all_queue', alertWhenPositive: true },
      { title: 'Review completed care summaries', detail: 'Confirm closure and follow-up instructions are visible.', metricKey: 'completedConsultations', actionLabel: 'View consultations', view: 'consultations', queuePreset: 'all_queue' },
      { title: 'Update notification channels', detail: 'Keep urgent alerts on your fastest channel.', actionLabel: 'Open notification settings', screen: 'notifications' }
    ]
  },
  clinician: {
    title: 'Clinician Account',
    narrative: 'Monitor active care load, update broadcast eligibility, and keep critical communication channels configured.',
    shortcuts: [
      { label: 'Clinical queue', view: 'consultations', queuePreset: 'needs_claim' },
      { label: 'Availability rules', screen: 'clinician' },
      { label: 'Notification center', screen: 'notifications' }
    ],
    screenLibrary: [
      { title: 'Clinical profile', caption: 'Contact and account identity settings', badge: 'Identity', screen: 'profile', actionLabel: 'Edit profile' },
      { title: 'Broadcast eligibility', caption: 'Specialties, procedures, and accepted tiers', badge: 'Triage', screen: 'clinician', actionLabel: 'Edit clinician rules' },
      { title: 'Call desk notifications', caption: 'Live consultation and escalation alerts', badge: 'Live', screen: 'notifications', actionLabel: 'Open notifications', metricKey: 'inProgressConsultations' },
      { title: 'Case queue', caption: 'Claim and close consultations with context', badge: 'Queue', view: 'consultations', queuePreset: 'needs_claim', actionLabel: 'Open consultations', metricKey: 'openBroadcasts' }
    ],
    operations: [
      { title: 'Claim eligible broadcasts', detail: 'Prioritize open broadcasts aligned to your availability filters.', metricKey: 'openBroadcasts', actionLabel: 'Open consultation queue', view: 'consultations', queuePreset: 'needs_claim', alertWhenPositive: true },
      { title: 'Maintain active consultation cadence', detail: 'Resolve in-progress sessions with timely updates and closure notes.', metricKey: 'inProgressConsultations', actionLabel: 'Open communication desk', view: 'consultations', queuePreset: 'live_triage', alertWhenPositive: true },
      { title: 'Refresh broadcast rules', detail: 'Adjust accepted tiers and procedures as clinic schedule changes.', actionLabel: 'Open clinician rules', screen: 'clinician' }
    ]
  },
  coordinator: {
    title: 'Coordinator Account',
    narrative: 'Stay on top of intake, referral movement, and urgent consultation communication without leaving your account workspace.',
    shortcuts: [
      { label: 'Intake queue', view: 'intake' },
      { label: 'Referral pipeline', view: 'referrals' },
      { label: 'Notification center', screen: 'notifications' }
    ],
    screenLibrary: [
      { title: 'Ops profile', caption: 'Account identity and escalation contacts', badge: 'Identity', screen: 'profile', actionLabel: 'Edit profile' },
      { title: 'Intake overview', caption: 'Leads waiting for qualification and routing', badge: 'Intake', view: 'intake', actionLabel: 'Open intake queue', metricKey: 'leads' },
      { title: 'Referral movement', caption: 'Pipeline handoffs and provider matches', badge: 'Referrals', view: 'referrals', actionLabel: 'Open referrals', metricKey: 'referrals' },
      { title: 'Consultation pressure', caption: 'Operational queue and claim window risk', badge: 'Queue', view: 'consultations', queuePreset: 'live_triage', actionLabel: 'Open consultations', metricKey: 'consultations' }
    ],
    operations: [
      { title: 'Clear intake bottlenecks', detail: 'Resolve aged leads and route new requests quickly.', metricKey: 'leads', actionLabel: 'Open intake queue', view: 'intake', alertWhenPositive: true },
      { title: 'Advance referral states', detail: 'Prioritize under-review and rematch cases to shorten cycle time.', metricKey: 'referrals', actionLabel: 'Open referral pipeline', view: 'referrals', alertWhenPositive: true },
      { title: 'Watch consultation holds', detail: 'Track unsettled consultation holds and reconcile anomalies.', metricKey: 'unsettledConsultationHolds', actionLabel: 'Open reports', view: 'reports', alertWhenPositive: true }
    ]
  },
  admin: {
    title: 'Admin Account',
    narrative: 'Oversee platform-wide operations, maintain access hygiene, and monitor communication pressure across workflows.',
    shortcuts: [
      { label: 'Reports', view: 'reports' },
      { label: 'Provider catalogue', view: 'providers' },
      { label: 'Security controls', screen: 'security' }
    ],
    screenLibrary: [
      { title: 'Admin profile', caption: 'Identity and organization contact controls', badge: 'Identity', screen: 'profile', actionLabel: 'Edit profile' },
      { title: 'Security center', caption: 'Credential rotation and access hygiene', badge: 'Security', screen: 'security', actionLabel: 'Open security' },
      { title: 'Platform telemetry', caption: 'Cross-workflow metrics and health indicators', badge: 'Telemetry', view: 'reports', actionLabel: 'Open reports', metricKey: 'consultations' },
      { title: 'Provider governance', caption: 'Provider network status and readiness', badge: 'Network', view: 'providers', actionLabel: 'Open providers', metricKey: 'appointments' }
    ],
    operations: [
      { title: 'Review platform throughput', detail: 'Track load across leads, referrals, consultations, and appointments.', metricKey: 'consultations', actionLabel: 'Open reports', view: 'reports', alertWhenPositive: true },
      { title: 'Audit pending payment holds', detail: 'Investigate unreconciled holds and keep payment integrity clean.', metricKey: 'unsettledConsultationHolds', actionLabel: 'Open reports', view: 'reports', alertWhenPositive: true },
      { title: 'Run profile and credential hygiene', detail: 'Rotate password and verify notification routing fallback.', actionLabel: 'Open security controls', screen: 'security' }
    ]
  },
  finance: {
    title: 'Finance Account',
    narrative: 'Review payment-sensitive workload metrics and coordinate settlement visibility from a focused account hub.',
    shortcuts: [
      { label: 'Operations reports', view: 'reports' },
      { label: 'Consultation queue', view: 'consultations', queuePreset: 'critical_followup' },
      { label: 'Notification center', screen: 'notifications' }
    ],
    screenLibrary: [
      { title: 'Finance profile', caption: 'Account identity and finance contacts', badge: 'Identity', screen: 'profile', actionLabel: 'Edit profile' },
      { title: 'Hold reconciliation', caption: 'Consultation holds needing financial follow-through', badge: 'Payments', view: 'reports', actionLabel: 'Open reports', metricKey: 'unsettledConsultationHolds' },
      { title: 'Operational queue', caption: 'Consultation volume affecting settlement pressure', badge: 'Queue', view: 'consultations', queuePreset: 'critical_followup', actionLabel: 'Open consultations', metricKey: 'consultations' },
      { title: 'Alert stream', caption: 'Critical account and referral notifications', badge: 'Alerts', screen: 'notifications', actionLabel: 'Open notifications' }
    ],
    operations: [
      { title: 'Reconcile unsettled holds', detail: 'Prioritize consultation hold exceptions to reduce payment drift.', metricKey: 'unsettledConsultationHolds', actionLabel: 'Open reports', view: 'reports', alertWhenPositive: true },
      { title: 'Track consultation demand impact', detail: 'Use queue load as an early signal for settlement operations.', metricKey: 'consultations', actionLabel: 'Open consultations', view: 'consultations', queuePreset: 'critical_followup' },
      { title: 'Triaging payment-related alerts', detail: 'Use filtered inbox views for high-priority communication events.', actionLabel: 'Open notification center', screen: 'notifications' }
    ]
  }
};

export function createAccountWorkspaceController(deps) {
  const {
    state,
    qs,
    qsa,
    e,
    appTitle,
    accountScreenKey,
    consultationSortKey,
    consultationStatusKey,
    consultationTierKey,
    consultationSearchKey,
    accountWorkspaceCacheTtlMs = 30000,
    api,
    applyNotificationSummary,
    loadNotificationInbox
  } = deps;

  function accountInboxFilterCacheKey() {
    const filters = state.notificationInboxFilters || {};
    return [
      String(filters.channel || 'all'),
      String(filters.type || 'all'),
      String(filters.severity || 'all'),
      filters.unreadOnly ? '1' : '0',
      '50'
    ].join('|');
  }

  function canUseAccountWorkspaceCache(options = {}) {
    if (!options.preferCache || options.forceRefresh) return false;
    const cachedWorkspace = state.accountWorkspace;
    if (!cachedWorkspace || typeof cachedWorkspace !== 'object') return false;
    const fetchedAt = Number(state.accountWorkspaceFetchedAt || 0);
    if (!fetchedAt) return false;
    if ((Date.now() - fetchedAt) > accountWorkspaceCacheTtlMs) return false;
    return String(state.accountWorkspaceInboxCacheKey || '') === accountInboxFilterCacheKey();
  }

  function updateAccountWorkspaceCacheMetadata(workspace) {
    if (workspace && typeof workspace === 'object') {
      state.accountWorkspaceFetchedAt = Date.now();
      state.accountWorkspaceInboxCacheKey = accountInboxFilterCacheKey();
      return;
    }
    state.accountWorkspaceFetchedAt = 0;
    state.accountWorkspaceInboxCacheKey = '';
  }

  function updateAccountTabUnreadIndicator() {
    const unreadCount = Number(state.notificationInboxMeta?.unreadCount || 0);
    qsa('button[data-view="account"]').forEach((button) => {
      button.textContent = unreadCount > 0 ? `Account (${unreadCount})` : 'Account';
    });
    const unreadChip = qs('#accountUnreadChip');
    if (unreadChip) {
      unreadChip.classList.toggle('hidden', unreadCount <= 0);
      unreadChip.textContent = `${unreadCount} unread`;
    }
    document.title = unreadCount > 0 ? `(${unreadCount}) ${appTitle}` : appTitle;
  }

  function normalizeAccountScreen(screen) {
    const value = String(screen || '').toLowerCase();
    if (['profile', 'security', 'notifications', 'operations', 'clinician'].includes(value)) return value;
    return 'profile';
  }

  function setAccountScreen(screen, options = {}) {
    const persist = options.persist !== false;
    const next = normalizeAccountScreen(screen);
    const clinicianTab = qs('#accountScreenClinician');
    const clinicianAllowed = state.user?.role === 'clinician';
    const resolved = next === 'clinician' && !clinicianAllowed ? 'operations' : next;

    state.accountActiveScreen = resolved;
    if (persist) {
      localStorage.setItem(accountScreenKey, resolved);
    }

    qsa('[data-account-screen]').forEach((button) => {
      const active = button.dataset.accountScreen === resolved;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    qsa('[data-account-screen-panel]').forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.accountScreenPanel === resolved);
    });

    if (clinicianTab) {
      clinicianTab.classList.toggle('hidden', !clinicianAllowed);
    }
  }

  function resetAccountWorkspaceView() {
    const roleHeading = qs('#accountRoleHeading');
    const roleNarrative = qs('#accountRoleNarrative');
    const roleChip = qs('#accountRoleChip');
    const snapshotMeta = qs('#accountSnapshotMeta');
    const nextActionsMeta = qs('#accountNextActionsMeta');
    const nextActionsList = qs('#accountNextActionsList');
    const accountUseCases = qs('#accountUseCases');
    const libraryMeta = qs('#accountLibraryMeta');
    const libraryList = qs('#accountScreenLibraryList');
    const roleOps = qs('#accountRoleOpsList');
    const inboxMeta = qs('#notificationInboxMeta');
    const inboxList = qs('#notificationInboxList');

    if (roleHeading) roleHeading.textContent = 'Sign in to personalize your workspace';
    if (roleNarrative) roleNarrative.textContent = 'Role-specific tools, communication controls, and security actions are staged here for fast daily workflows.';
    if (roleChip) roleChip.textContent = 'Role workspace';
    if (snapshotMeta) snapshotMeta.textContent = 'Awaiting account data.';
    if (nextActionsMeta) nextActionsMeta.textContent = 'Sign in to load prioritized actions.';
    if (nextActionsList) nextActionsList.innerHTML = '<div class="empty">Sign in to load prioritized actions.</div>';
    if (accountUseCases) accountUseCases.innerHTML = '<div class="empty">Sign in to load account use-cases.</div>';
    if (libraryMeta) libraryMeta.textContent = 'Role scenes and shortcuts.';
    if (libraryList) libraryList.innerHTML = '<div class="empty">Sign in to load role screens.</div>';
    if (roleOps) roleOps.innerHTML = '<div class="empty">Sign in to load role operations.</div>';
    if (inboxMeta) inboxMeta.textContent = 'Sign in to load notifications.';
    if (inboxList) inboxList.innerHTML = '<div class="empty">No notifications loaded yet.</div>';

    setAccountScreen('profile', { persist: false });
  }

  function hydrateAccountForms() {
    if (!state.user) return;
    const profile = qs('#profileForm');
    if (!profile) return;
    profile.firstName.value = state.user.firstName || '';
    profile.lastName.value = state.user.lastName || '';
    profile.email.value = state.user.email || '';
    profile.phone.value = state.user.phone || '';
  }

  function hydrateNotificationPreferences(preferences) {
    const notificationPreferencesForm = qs('#notificationPreferencesForm');
    if (!notificationPreferencesForm) return;

    const selected = preferences?.consultations?.preferredChannels || ['sms', 'email'];
    for (const option of notificationPreferencesForm.querySelectorAll('select[name="preferredChannels"] option')) {
      option.selected = selected.includes(option.value);
    }

    const emailCopyEnabled = preferences?.consultations?.emailCopyEnabled ?? true;
    const emailCopyInput = notificationPreferencesForm.querySelector('input[name="emailCopyEnabled"]');
    if (emailCopyInput) {
      emailCopyInput.checked = Boolean(emailCopyEnabled);
    }
  }

  async function hydrateClinicianAvailability() {
    const availabilityForm = qs('#clinicianAvailabilityForm');
    if (!availabilityForm) return;

    const isClinician = state.user?.role === 'clinician';
    availabilityForm.classList.toggle('hidden', !isClinician);
    if (!isClinician) return;

    const workspaceAvailability = state.accountWorkspace?.clinicianAvailability || null;
    const availability = workspaceAvailability
      ? await Promise.resolve(workspaceAvailability)
      : await api('/api/v1/account/clinician-availability');
    const catalogue = state.catalogue || await api('/api/v1/catalogue');
    state.catalogue ||= catalogue;

    const specialtyIds = Array.isArray(availability?.specialtyIds) ? availability.specialtyIds : [];
    const procedureIds = Array.isArray(availability?.procedureIds) ? availability.procedureIds : [];
    const acceptedTiers = Array.isArray(availability?.acceptedTiers) ? availability.acceptedTiers : [];

    const specialtySelect = qs('#availabilitySpecialties');
    const procedureSelect = qs('#availabilityProcedures');

    if (specialtySelect) {
      specialtySelect.innerHTML = (catalogue.specialties || [])
        .map((item) => `<option value="${e(item.id)}" ${specialtyIds.includes(item.id) ? 'selected' : ''}>${e(item.name)}</option>`)
        .join('');
    }
    if (procedureSelect) {
      procedureSelect.innerHTML = (catalogue.procedures || [])
        .map((item) => `<option value="${e(item.id)}" ${procedureIds.includes(item.id) ? 'selected' : ''}>${e(item.name)}</option>`)
        .join('');
    }

    const enabled = availabilityForm.querySelector('input[name="enabled"]');
    if (enabled) enabled.checked = Boolean(availability?.enabled);

    for (const option of availabilityForm.querySelectorAll('select[name="acceptedTiers"] option')) {
      option.selected = acceptedTiers.includes(option.value);
    }
  }

  function formatAccountMetricLabel(key) {
    const value = String(key || 'metric');
    return value
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .trim()
      .replace(/^./, (char) => char.toUpperCase());
  }

  function asNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  function resolveMetric(summary, key) {
    if (!summary || typeof summary !== 'object') return null;
    if (!key || !Object.hasOwn(summary, key)) return null;
    return summary[key];
  }

  function toneForMetric(item, metricValue) {
    const numeric = asNumber(metricValue);
    if (item?.alertWhenPositive && numeric > 0) return 'is-alert';
    if (numeric > 0) return 'is-good';
    return 'is-neutral';
  }

  function resolveAccountQueuePreset(view, explicitPreset) {
    if (view !== 'consultations') return '';
    const preferred = String(explicitPreset || state.accountWorkspace?.roleProfile?.recommendedQueuePreset || 'all_queue');
    if (Object.hasOwn(consultationQueuePresetCatalog, preferred)) {
      return preferred;
    }
    return 'all_queue';
  }

  function buildAccountActionAttrs(item = {}) {
    if (item.view) {
      const queuePreset = resolveAccountQueuePreset(item.view, item.queuePreset);
      const queueAttr = queuePreset ? ` data-queue-preset="${e(queuePreset)}"` : '';
      return `data-view="${e(item.view)}"${queueAttr}`;
    }
    return `data-account-jump="${e(item.screen || 'profile')}"`;
  }

  function applyConsultationQueuePreset(presetKey) {
    const resolved = String(presetKey || '');
    if (!Object.hasOwn(consultationQueuePresetCatalog, resolved)) return false;
    const preset = consultationQueuePresetCatalog[resolved];

    state.consultationQueuePreset = resolved;
    state.consultationQueueSortMode = String(preset.sort || 'recent');
    state.consultationQueueFilters = {
      status: String(preset.filters?.status || 'all'),
      tier: String(preset.filters?.tier || 'all'),
      search: String(preset.filters?.search || '')
    };

    localStorage.setItem(CONSULTATION_QUEUE_PRESET_KEY, state.consultationQueuePreset);
    localStorage.setItem(consultationSortKey, state.consultationQueueSortMode);
    localStorage.setItem(consultationStatusKey, state.consultationQueueFilters.status);
    localStorage.setItem(consultationTierKey, state.consultationQueueFilters.tier);
    localStorage.setItem(consultationSearchKey, state.consultationQueueFilters.search);

    return true;
  }

  function priorityClass(priority) {
    const normalized = String(priority || 'routine').toLowerCase();
    if (['critical', 'high', 'medium', 'routine'].includes(normalized)) return normalized;
    return 'routine';
  }

  function priorityLabel(priority) {
    const normalized = priorityClass(priority);
    if (normalized === 'critical') return 'Critical';
    if (normalized === 'high') return 'High';
    if (normalized === 'medium') return 'Medium';
    return 'Routine';
  }

  function renderAccountNextActions(actions = []) {
    const target = qs('#accountNextActionsList');
    const meta = qs('#accountNextActionsMeta');
    if (!target) return;

    const items = Array.isArray(actions) ? actions : [];
    const nextActionMeta = state.accountWorkspace?.nextActionMeta || null;
    const suppressedCount = Number(nextActionMeta?.suppressedCount || 0);
    if (meta) {
      if (items.length) {
        meta.textContent = suppressedCount > 0
          ? `${items.length} prioritized actions · ${suppressedCount} deferred`
          : `${items.length} prioritized actions`;
      } else {
        meta.textContent = suppressedCount > 0
          ? `No active actions · ${suppressedCount} deferred`
          : 'No urgent actions at the moment.';
      }
    }

    if (!items.length) {
      target.innerHTML = '<div class="empty">No prioritized actions right now.</div>';
      return;
    }

    target.innerHTML = items.map((item) => {
      const actionAttrs = buildAccountActionAttrs(item);
      const priority = priorityClass(item.priority);
      const metricLabel = item.metricKey ? formatAccountMetricLabel(item.metricKey) : '';
      const hasMetric = item.metricValue !== null && item.metricValue !== undefined && metricLabel;

      return `
        <article class="account-next-action priority-${priority}">
          <div class="account-next-action-copy">
            <strong>${e(item.title || 'Review action')}</strong>
            <p>${e(item.detail || '')}</p>
            <div class="account-next-action-meta">
              <span class="account-priority-pill priority-${priority}">${e(priorityLabel(priority))}</span>
              ${hasMetric ? `<span class="account-role-op-metric">${e(metricLabel)}: <strong>${e(item.metricValue)}</strong></span>` : ''}
            </div>
          </div>
          <div class="account-next-action-actions">
            <button type="button" class="secondary" ${actionAttrs}>Open</button>
            <button type="button" class="secondary" data-next-action-snooze="${e(item.id)}" data-snooze-minutes="120">Snooze 2h</button>
            <button type="button" class="secondary" data-next-action-complete="${e(item.id)}">Done</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderAccountScreenLibrary(profile, summary) {
    const target = qs('#accountScreenLibraryList');
    const meta = qs('#accountLibraryMeta');
    if (!target) return;

    const cards = Array.isArray(profile.screenLibrary) ? profile.screenLibrary : [];
    if (meta) meta.textContent = `${cards.length} role-specific screens`;

    if (!cards.length) {
      target.innerHTML = '<div class="empty">No role screens configured.</div>';
      return;
    }

    target.innerHTML = cards.map((card) => {
      const metricValue = resolveMetric(summary, card.metricKey);
      const hasMetric = metricValue !== null;
      const actionAttrs = buildAccountActionAttrs(card);
      return `
        <article class="account-library-card">
          <div class="account-library-top">
            <strong>${e(card.title)}</strong>
            <span class="account-library-badge">${e(card.badge || 'Screen')}</span>
          </div>
          <p>${e(card.caption || '')}</p>
          ${hasMetric ? `<div class="account-library-metric">${e(formatAccountMetricLabel(card.metricKey))}: <strong>${e(metricValue)}</strong></div>` : ''}
          <button type="button" class="secondary" ${actionAttrs}>${e(card.actionLabel || 'Open')}</button>
        </article>
      `;
    }).join('');
  }

  function renderAccountRoleOperations(profile, summary) {
    const target = qs('#accountRoleOpsList');
    if (!target) return;
    const items = Array.isArray(profile.operations) ? profile.operations : [];
    if (!items.length) {
      target.innerHTML = '<div class="empty">No operations configured for this role.</div>';
      return;
    }

    target.innerHTML = items.map((item) => {
      const metricValue = resolveMetric(summary, item.metricKey);
      const tone = toneForMetric(item, metricValue);
      const actionAttrs = buildAccountActionAttrs(item);
      const metricText = metricValue === null
        ? ''
        : `<span class="account-role-op-metric">${e(formatAccountMetricLabel(item.metricKey))}: <strong>${e(metricValue)}</strong></span>`;

      return `
        <article class="account-role-op ${tone}">
          <div class="account-role-op-copy">
            <strong>${e(item.title)}</strong>
            <p>${e(item.detail || '')}</p>
            ${metricText}
          </div>
          <div class="account-role-op-actions">
            <button type="button" class="secondary" ${actionAttrs}>${e(item.actionLabel || 'Open')}</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderAccountUseCases(data) {
    const role = state.user?.role || 'coordinator';
    const profile = ACCOUNT_ROLE_PROFILES[role] || ACCOUNT_ROLE_PROFILES.coordinator;
    const summaryData = data?.summary && typeof data.summary === 'object' ? data.summary : {};
    const roleHeading = qs('#accountRoleHeading');
    const roleNarrative = qs('#accountRoleNarrative');
    const roleChip = qs('#accountRoleChip');
    const shortcutGrid = qs('#accountShortcutGrid');
    const snapshotMeta = qs('#accountSnapshotMeta');
    const accountUseCases = qs('#accountUseCases');

    if (roleHeading) roleHeading.textContent = profile.title;
    if (roleNarrative) roleNarrative.textContent = profile.narrative;
    if (roleChip) roleChip.textContent = `${formatAccountMetricLabel(role)} workspace`;
    if (snapshotMeta) snapshotMeta.textContent = `${formatAccountMetricLabel(role)} focus · ${new Date().toLocaleTimeString()}`;

    if (shortcutGrid) {
      const shortcutButtons = profile.shortcuts.map((item) => {
        const actionAttrs = buildAccountActionAttrs(item);
        return `<button type="button" class="secondary" ${actionAttrs}>${e(item.label)}</button>`;
      }).join('');
      shortcutGrid.innerHTML = shortcutButtons;
    }

    const actions = (data.allowedActions || [])
      .map((action) => `<li class="account-action-item">${e(formatAccountMetricLabel(action))}</li>`)
      .join('');
    const summary = Object.entries(summaryData)
      .map(([key, value]) => `
        <article class="account-metric-card">
          <span>${e(formatAccountMetricLabel(key))}</span>
          <strong>${e(value)}</strong>
        </article>
      `)
      .join('');

    if (accountUseCases) {
      accountUseCases.innerHTML = `
        <div class="account-summary-grid">${summary || '<div class="empty">No summary data.</div>'}</div>
        <div class="account-actions-block">
          <h3>Allowed actions</h3>
          <ul class="account-actions-list">${actions || '<li class="empty">No actions available.</li>'}</ul>
        </div>
      `;
    }

    const nextActions = state.accountWorkspace?.nextActions;
    renderAccountNextActions(Array.isArray(nextActions) ? nextActions : []);
    renderAccountScreenLibrary(profile, summaryData);
    renderAccountRoleOperations(profile, summaryData);
  }

  async function hydrateAccountWorkspace(workspace) {
    state.accountWorkspace = workspace && typeof workspace === 'object' ? workspace : null;
    updateAccountWorkspaceCacheMetadata(state.accountWorkspace);

    if (state.accountWorkspace?.useCases) {
      state.accountUseCases = state.accountWorkspace.useCases;
    } else {
      state.accountUseCases = await api('/api/v1/account/use-cases');
    }
    renderAccountUseCases(state.accountUseCases);

    if (state.accountWorkspace?.notificationSummary) {
      applyNotificationSummary(state.accountWorkspace.notificationSummary);
    }

    hydrateAccountForms();

    const preferences = state.accountWorkspace?.notificationPreferences
      || await api('/api/v1/account/notification-preferences').catch(() => null);
    hydrateNotificationPreferences(preferences);

    await hydrateClinicianAvailability();

    const hasSavedAccountScreen = Boolean(localStorage.getItem(accountScreenKey));
    const roleDefaultScreen = normalizeAccountScreen(state.accountWorkspace?.roleProfile?.defaultAccountScreen || 'profile');
    if (!hasSavedAccountScreen) {
      state.accountActiveScreen = roleDefaultScreen;
    }

    setAccountScreen(state.accountActiveScreen, { persist: false });

    if (state.accountWorkspace?.notificationInbox) {
      await loadNotificationInbox({ preloadedPayload: state.accountWorkspace.notificationInbox });
      return;
    }
    await loadNotificationInbox();
  }

  async function loadAccount(options = {}) {
    if (!state.user) return;

    if (canUseAccountWorkspaceCache(options)) {
      await hydrateAccountWorkspace(state.accountWorkspace);
      return;
    }

    const inboxFilters = state.notificationInboxFilters || {};
    const workspaceQuery = new URLSearchParams();
    workspaceQuery.set('includeInbox', 'true');
    workspaceQuery.set('channel', String(inboxFilters.channel || 'all'));
    workspaceQuery.set('type', String(inboxFilters.type || 'all'));
    workspaceQuery.set('severity', String(inboxFilters.severity || 'all'));
    workspaceQuery.set('unreadOnly', inboxFilters.unreadOnly ? 'true' : 'false');
    workspaceQuery.set('limit', '50');

    const workspace = await api(`/api/v1/account/workspace?${workspaceQuery.toString()}`).catch(() => null);
    await hydrateAccountWorkspace(workspace);
  }

  async function updateAccountNextActionState(actionId, status, options = {}) {
    const payload = {
      actionId: String(actionId || ''),
      status: String(status || 'active')
    };
    if (payload.status === 'snoozed') {
      payload.snoozeMinutes = Number(options.snoozeMinutes || 120);
    }

    const response = await api('/api/v1/account/next-actions/state', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const workspace = response?.workspace;
    if (workspace && typeof workspace === 'object') {
      state.accountWorkspace = workspace;
      updateAccountWorkspaceCacheMetadata(workspace);
      if (workspace.useCases) {
        state.accountUseCases = workspace.useCases;
        renderAccountUseCases(state.accountUseCases);
      }
      if (workspace.notificationSummary) {
        applyNotificationSummary(workspace.notificationSummary);
      }
      setAccountScreen(state.accountActiveScreen, { persist: false });
    } else {
      await loadAccount();
    }

    return response?.result || null;
  }

  return {
    updateAccountTabUnreadIndicator,
    normalizeAccountScreen,
    setAccountScreen,
    resetAccountWorkspaceView,
    renderAccountUseCases,
    hydrateAccountWorkspace,
    applyConsultationQueuePreset,
    updateAccountNextActionState,
    loadAccount
  };
}
