import { qs, qsa, e, timestampMs } from './js/ui-helpers.js';
import { createConsultationActionRunner } from './js/consultation-actions.js';
import { bindInteractionHandlers } from './js/interaction-bindings.js';
import { createInteractionWorkspaceController } from './js/interaction-workspace.js';
import { createCallController } from './js/call-controls.js';
import { createConsultationWorkspaceController } from './js/consultation-workspace.js';
import { createAccountWorkspaceController } from './js/account-workspace.js';
import { createAccountNotificationWorkspaceController } from './js/account-notification-workspace.js';
import { createOperationsWorkspaceController } from './js/operations-workspace.js';
import { createApiClient } from './js/api-client.js';
import { bindAccountUiHandlers } from './js/account-ui-bindings.js';
import { bindOperationsUiHandlers } from './js/operations-ui-bindings.js';
import { bindConsultationUiHandlers } from './js/consultation-ui-bindings.js';
import { createAppShellController } from './js/app-shell.js';
import { bindAppEventHandlers } from './js/app-event-bindings.js';
import { createSingleFlight } from './js/single-flight.js';
import { createAuthSessionController } from './js/auth-session.js';
import { initDeferredCampaignContent } from './js/campaign-content.js';
import { renderIntakeContent } from './js/intake-content.js';
import {
  CONSULTATION_PERF_HISTORY_KEY,
  createStartupPerfTelemetryController
} from './js/startup-perf-telemetry.js';
import {
  bindConsultationWorkspaceHandlers,
  CONSULTATION_QUEUE_PRESET_KEY
} from './js/consultation-workspace-bindings.js';
import {
  INTERACTION_PRESET_KEY,
  interactionPresetCatalog,
  interactionPresetsForRole,
  interactionTypesForChannel,
  inferInteractionTypeClient,
  validateInteractionPayloadClient,
  isMessageRequiredInteractionType
} from './js/interaction-helpers.js';

const NOTIFICATION_INBOX_CHANNEL_KEY = 'mindset_notification_inbox_channel';
const NOTIFICATION_INBOX_TYPE_KEY = 'mindset_notification_inbox_type';
const NOTIFICATION_INBOX_SEVERITY_KEY = 'mindset_notification_inbox_severity';
const NOTIFICATION_INBOX_UNREAD_ONLY_KEY = 'mindset_notification_inbox_unread_only';
const NOTIFICATION_SUMMARY_POLL_MS = 15000;
const NOTIFICATION_INBOX_POLL_MS = 30000;
const ACCOUNT_SCREEN_KEY = 'mindset_account_active_screen';
const CONSULTATION_SORT_KEY = 'mindset_consultation_sort_mode';
const CONSULTATION_STATUS_KEY = 'mindset_consultation_filter_status';
const CONSULTATION_TIER_KEY = 'mindset_consultation_filter_tier';
const CONSULTATION_SEARCH_KEY = 'mindset_consultation_filter_search';
const APP_TITLE = 'Mindset Healthcare | Care starts with a conversation';
const INTERACTION_CACHE_TTL_MS = 12000;
const ACCOUNT_WORKSPACE_CACHE_TTL_MS = 30000;

const NOTIFICATION_PRESET_RULES = {
  critical_unread: {
    channel: 'all',
    type: 'all',
    severity: 'critical',
    unreadOnly: true
  },
  communication_unread: {
    channel: 'all',
    type: 'communication',
    severity: 'all',
    unreadOnly: true
  },
  all_unread: {
    channel: 'all',
    type: 'all',
    severity: 'all',
    unreadOnly: true
  },
  all: {
    channel: 'all',
    type: 'all',
    severity: 'all',
    unreadOnly: false
  }
};

const state = {
  token: localStorage.getItem('mindset_token') || '',
  user: JSON.parse(localStorage.getItem('mindset_user') || 'null'),
  catalogue: null,
  referrals: [],
  selectedReferral: null,
  consultations: [],
  consultationEventLogById: {},
  consultationEventLogErrorById: {},
  consultationEventLogLoadingById: {},
  consultationEventLogKindFilter: 'all',
  consultationQueueSortMode: localStorage.getItem(CONSULTATION_SORT_KEY) || 'recent',
  consultationQueuePreset: localStorage.getItem(CONSULTATION_QUEUE_PRESET_KEY) || 'custom',
  consultationQueueFilters: {
    status: localStorage.getItem(CONSULTATION_STATUS_KEY) || 'all',
    tier: localStorage.getItem(CONSULTATION_TIER_KEY) || 'all',
    search: localStorage.getItem(CONSULTATION_SEARCH_KEY) || ''
  },
  consultationQueueMeta: {
    visibleCount: 0,
    totalCount: 0
  },
  consultationQueueSearchDebounceTimer: null,
  consultationActivePanel: 'queue',
  consultationUiState: {
    actionsOpenById: {},
    logOpenById: {},
    recordsOpenById: {}
  },
  consultationMedicalRecordsById: {},
  consultationMedicalRecordErrorById: {},
  consultationMedicalRecordLoadingById: {},
  consultationSessionsById: {},
  consultationInteractionContext: {
    consultationId: null,
    sessionId: null
  },
  consultationInteractionFilters: {
    type: localStorage.getItem('mindset_interaction_filter_type') || 'all',
    actorRole: localStorage.getItem('mindset_interaction_filter_actor') || 'all',
    limit: localStorage.getItem('mindset_interaction_filter_limit') || '50'
  },
  consultationInteractionDraftBySession: {},
  consultationInteractionCacheByQueryKey: {},
  consultationInteractionCacheFetchedAtByQueryKey: {},
  consultationSessionsFetchedAtById: {},
  lastSeenInteractionAtBySession: {},
  latestInteractionAtBySession: {},
  interactionUnreadBySession: {},
  consultationCommsUsePreloadedOnce: false,
  interactionPollTimer: null,
  accountUseCases: null,
  accountWorkspace: null,
  accountWorkspaceFetchedAt: 0,
  accountWorkspaceInboxCacheKey: '',
  accountActiveScreen: localStorage.getItem(ACCOUNT_SCREEN_KEY) || 'profile',
  notificationInboxFilters: {
    channel: localStorage.getItem(NOTIFICATION_INBOX_CHANNEL_KEY) || 'all',
    type: localStorage.getItem(NOTIFICATION_INBOX_TYPE_KEY) || 'all',
    severity: localStorage.getItem(NOTIFICATION_INBOX_SEVERITY_KEY) || 'all',
    unreadOnly: localStorage.getItem(NOTIFICATION_INBOX_UNREAD_ONLY_KEY) === '1'
  },
  notificationInboxMeta: {
    unreadCount: 0,
    totalCount: 0,
    visibleCount: 0,
    visibleUnreadCount: 0
  },
  notificationInboxPollTimer: null,
  notificationSummaryPollTimer: null,
  urgentMode: false
};

const INTERACTION_POLL_MS = 5000;

const api = createApiClient(state);

let callController = null;
let accountUiBindings = null;
let notificationWorkspace = null;
let operationsUiBindings = null;
let consultationUiBindings = null;

const accordionStateKey = 'mindset_topbar_accordion';

const titles = {
  campaigns: ['Campaigns', 'Choose the path that matches your care need.'],
  intake: ['Intake', 'Capture demand and qualify it into a referral.'],
  consultations: ['Consultations', 'Run Section 3 workflows: request, claim, escalate, complete, and SLA operations.'],
  referrals: ['Referrals', 'Move cases through matching, provider response, appointment, and completion.'],
  providers: ['Providers', 'Maintain the provider capability registry.'],
  reports: ['Reports', 'Track funnel health and operational load.'],
  'patient-portal': ['My care', 'Review your private care summary and manage family access.'],
  account: ['Account', 'Review your role use-cases and manage profile credentials.']
};

const accountWorkspace = createAccountWorkspaceController({
  state,
  qs,
  qsa,
  e,
  appTitle: APP_TITLE,
  accountScreenKey: ACCOUNT_SCREEN_KEY,
  consultationSortKey: CONSULTATION_SORT_KEY,
  consultationStatusKey: CONSULTATION_STATUS_KEY,
  consultationTierKey: CONSULTATION_TIER_KEY,
  consultationSearchKey: CONSULTATION_SEARCH_KEY,
  accountWorkspaceCacheTtlMs: ACCOUNT_WORKSPACE_CACHE_TTL_MS,
  api,
  applyNotificationSummary,
  loadNotificationInbox
});

const {
  updateAccountTabUnreadIndicator,
  setAccountScreen,
  resetAccountWorkspaceView,
  hydrateAccountWorkspace,
  applyConsultationQueuePreset,
  updateAccountNextActionState,
  loadAccount: loadAccountImpl
} = accountWorkspace;

const appShell = createAppShellController({
  qs,
  qsa,
  accordionStateKey
});

const {
  isMobileViewport,
  openDrawer,
  closeDrawer,
  toggleAccordion,
  restoreAccordionState,
  prepareCampaign,
  toggleRouteCard
} = appShell;

let noticeTimer = null;

function notice(message, isError = false) {
  const box = qs('#notice');
  box.textContent = message;
  box.className = `notice${isError ? ' error' : ''}`;
  box.setAttribute('role', isError ? 'alert' : 'status');
  box.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  box.setAttribute('aria-atomic', 'true');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => box.classList.add('hidden'), 4500);
}

const startupPerfTelemetry = createStartupPerfTelemetryController({
  qs,
  e
});

const {
  renderStartupPerfTelemetryPanel,
  beginStartupConsultationPerf,
  markStartupConsultationFirstRender
} = startupPerfTelemetry;

async function loadCatalogue() {
  state.catalogue = await api('/api/v1/catalogue');
  const consultationProcedure = qs('#consultProcedure');
  if (consultationProcedure) {
    consultationProcedure.innerHTML = procedureOptions();
  }
}

function procedureOptions() {
  return state.catalogue.procedures.map((procedure) => `<option value="${e(procedure.id)}">${e(procedure.name)}</option>`).join('');
}

function specialtyForProcedure(procedureId) {
  const procedure = state.catalogue.procedures.find((item) => item.id === procedureId);
  return procedure?.specialtyId || state.catalogue.specialties[0]?.id;
}

function badgeTone(status) {
  if (['accepted', 'appointment_scheduled', 'service_completed', 'closed', 'completed'].includes(status)) return 'ok';
  if (['request_info', 'rematch', 'under_review', 'matched', 'sent_to_provider'].includes(status)) return 'warn';
  if (['rejected', 'cancelled', 'closed_lost'].includes(status)) return 'bad';
  return '';
}

async function renderReferralDetail() {
  const target = qs('#referralDetail');
  const referral = state.selectedReferral;
  if (!referral) {
    target.className = 'detail empty';
    target.textContent = 'Select a referral to review matching and move the case.';
    return;
  }
  const [recommendations, history, documents] = await Promise.all([
    api(`/api/v1/referrals/${referral.referralNumber}/recommendations`),
    api(`/api/v1/referrals/${referral.referralNumber}/history`),
    api(`/api/v1/referrals/${referral.referralNumber}/documents`)
  ]);
  target.className = 'detail';
  target.innerHTML = `
    <div>
      <h2>${e(referral.referralNumber)}</h2>
      <p class="subtle">${e(referral.patient?.name || 'Unknown patient')} · ${e(referral.procedure?.name || '')}</p>
    </div>
    <div>${e(referral.healthcareRequirement)}</div>
    <label>Recommended Provider
      <select id="assignedProvider">
        <option value="">Select provider</option>
        ${recommendations.map((provider) => `<option value="${e(provider.id)}" ${provider.id === referral.assignedProviderId ? 'selected' : ''}>${e(provider.name)} · score ${e(provider.score)}</option>`).join('')}
      </select>
    </label>
    <label>Status
      <select id="nextStatus">
        ${(window.referralTransitions?.[referral.status] || []).map((status) => `<option value="${e(status)}">${e(status)}</option>`).join('')}
      </select>
    </label>
    <label>Note<textarea id="transitionNote" placeholder="Operational note"></textarea></label>
    <div class="actions">
      <button id="moveReferral">Move Referral</button>
      <button class="secondary" id="attachDoc">Attach Document</button>
    </div>
    <div>
      <h2>Status History</h2>
      <div class="list">
        ${history.map((item) => `<div class="item"><strong>${e(item.toStatus)}</strong><span class="subtle">${e(item.fromStatus || 'created')} · ${e(new Date(item.createdAt).toLocaleString())}</span><div>${e(item.note || '')}</div></div>`).join('')}
      </div>
    </div>
    <div>
      <h2>Documents</h2>
      <div class="list">
        ${documents.length ? documents.map((document) => `<div class="item"><div class="item-row"><strong>${e(document.fileName)}</strong><button class="secondary" data-download-document="${e(document.id)}">Download</button></div><span class="subtle">${e(document.documentType)} · ${e(document.storageDisk)}</span></div>`).join('') : '<div class="empty">No documents attached.</div>'}
      </div>
    </div>
  `;
}


function setConsultationPanel(panelId) {
  state.consultationActivePanel = panelId;
  qsa('[data-consult-panel-id]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.consultPanelId === panelId);
  });
  qsa('[data-consult-panel]').forEach((button) => {
    const active = button.dataset.consultPanel === panelId;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

const interactionWorkspace = createInteractionWorkspaceController({
  state,
  qs,
  e,
  timestampMs,
  api,
  syncCallDesk: async () => {
    await callController?.syncCallDesk();
  },
  interactionPresetKey: INTERACTION_PRESET_KEY,
  interactionPresetCatalog,
  interactionPresetsForRole,
  interactionTypesForChannel,
  inferInteractionTypeClient,
  validateInteractionPayloadClient,
  isMessageRequiredInteractionType,
  interactionPollMs: INTERACTION_POLL_MS,
  interactionCacheTtlMs: INTERACTION_CACHE_TTL_MS
});

const {
  applyInteractionPreset,
  downloadInteractionTranscriptExport,
  currentInteractionSession,
  renderInteractionTypeControl,
  updateInteractionSubmitState,
  postQuickSessionMarker,
  renderInteractionDesk,
  stopInteractionPolling,
  startInteractionPolling,
  renderInteractionTranscript,
  hydratePreloadedConsultationComms
} = interactionWorkspace;

const consultationWorkspace = createConsultationWorkspaceController({
  state,
  qs,
  qsa,
  e,
  api,
  badgeTone,
  renderInteractionDesk,
  renderInteractionTranscript,
  startInteractionPolling,
  stopInteractionPolling
});

const {
  nextCommunicationLayer,
  loadConsultations: loadConsultationsImpl,
  hydrateConsultationWorkspace,
  loadConsultationEventLog,
  downloadConsultationEventsExport,
  loadConsultationMedicalRecords,
  setConsultationLogOpen,
  setConsultationActionsOpen,
  setConsultationRecordsOpen,
  renderConsultationList,
  renderUrgentModeToggleState
} = consultationWorkspace;

const loadConsultations = createSingleFlight(async () => loadConsultationsImpl());

const loadAccount = createSingleFlight(
  async (options = {}) => loadAccountImpl(options),
  {
    keyResolver: (args) => {
      const options = args?.[0] || {};
      return JSON.stringify({
        preferCache: Boolean(options.preferCache),
        forceRefresh: Boolean(options.forceRefresh),
        silent: Boolean(options.silent)
      });
    }
  }
);

const operationsWorkspace = createOperationsWorkspaceController({
  state,
  qs,
  e,
  api,
  badgeTone,
  procedureOptions,
  renderReferralDetail
});

const {
  loadLeads,
  loadReferrals,
  loadProviders,
  loadReports,
  loadOperationsWorkspace
} = operationsWorkspace;

notificationWorkspace = createAccountNotificationWorkspaceController({
  state,
  qs,
  qsa,
  e,
  api,
  updateAccountTabUnreadIndicator,
  notificationPresetRules: NOTIFICATION_PRESET_RULES,
  notificationInboxChannelKey: NOTIFICATION_INBOX_CHANNEL_KEY,
  notificationInboxTypeKey: NOTIFICATION_INBOX_TYPE_KEY,
  notificationInboxSeverityKey: NOTIFICATION_INBOX_SEVERITY_KEY,
  notificationInboxUnreadOnlyKey: NOTIFICATION_INBOX_UNREAD_ONLY_KEY,
  notificationSummaryPollMs: NOTIFICATION_SUMMARY_POLL_MS,
  notificationInboxPollMs: NOTIFICATION_INBOX_POLL_MS,
  resolveAccountViewActive: () => {
    const active = qs('.view.active');
    return active?.id === 'account';
  },
  switchView,
  loadConsultations,
  setConsultationPanel,
  renderInteractionDesk
});

const {
  isAccountViewActive,
  confirmBulkNotificationRead,
  persistNotificationInboxFilters,
  renderNotificationPresetState,
  applyNotificationPreset,
  applyNotificationSummary: applyNotificationSummaryInternal,
  loadNotificationInbox: loadNotificationInboxInternal,
  loadNotificationSummary,
  stopNotificationSummaryPolling,
  stopNotificationInboxPolling,
  startNotificationInboxPolling,
  startNotificationSummaryPolling,
  markNotificationRead,
  markAllNotificationsRead,
  markFilteredNotificationsRead,
  openNotificationConsultation
} = notificationWorkspace;

function applyNotificationSummary(payload) {
  applyNotificationSummaryInternal(payload);
}

async function loadNotificationInbox(options = {}) {
  await loadNotificationInboxInternal(options);
}

const authSession = createAuthSessionController({
  state,
  qs,
  api,
  notice,
  localStorageRef: localStorage,
  accordionStateKey,
  consultationPerfHistoryKey: CONSULTATION_PERF_HISTORY_KEY,
  interactionPresetKey: INTERACTION_PRESET_KEY,
  resetAccountWorkspaceView,
  updateAccountTabUnreadIndicator,
  stopInteractionPolling,
  stopNotificationInboxPolling,
  stopNotificationSummaryPolling,
  getCallController: () => callController
});

const {
  renderSession,
  signIn,
  registerPatient,
  startVerification,
  confirmVerification,
  performLogout
} = authSession;

async function refreshAll() {
  renderSession();
  beginStartupConsultationPerf();
  await loadCatalogue();
  const inboxFilters = state.notificationInboxFilters || {};
  const operationsWorkspaceData = await loadOperationsWorkspace({
    includeConsultations: true,
    includeConsultationComms: true,
    includeAccountWorkspace: true,
    consultationFilters: {
      sort: state.consultationQueueSortMode,
      status: state.consultationQueueFilters?.status,
      tier: state.consultationQueueFilters?.tier,
      search: state.consultationQueueFilters?.search
    },
    interactionFilters: {
      type: state.consultationInteractionFilters?.type,
      actorRole: state.consultationInteractionFilters?.actorRole,
      limit: state.consultationInteractionFilters?.limit
    },
    accountNotificationFilters: {
      channel: inboxFilters.channel,
      type: inboxFilters.type,
      severity: inboxFilters.severity,
      unreadOnly: inboxFilters.unreadOnly,
      limit: '50'
    }
  }).catch(async () => {
    await Promise.allSettled([loadLeads(), loadReferrals(), loadProviders(), loadReports()]);
    return null;
  });

  if (operationsWorkspaceData?.consultationWorkspace) {
    hydratePreloadedConsultationComms(operationsWorkspaceData.consultationCommsBootstrap);
    await hydrateConsultationWorkspace(operationsWorkspaceData.consultationWorkspace);
  } else {
    await loadConsultations();
  }

  if (operationsWorkspaceData?.accountWorkspace) {
    await hydrateAccountWorkspace(operationsWorkspaceData.accountWorkspace);
  } else {
    await loadAccount();
  }

  markStartupConsultationFirstRender({
    source: operationsWorkspaceData?.consultationWorkspace ? 'operations_workspace_preload' : 'consultation_workspace_direct',
    usedPreloadedComms: Boolean(operationsWorkspaceData?.consultationCommsBootstrap),
    consultationCount: state.consultations.length
  });

  startNotificationSummaryPolling();
  if (isAccountViewActive()) {
    startNotificationInboxPolling();
  } else {
    stopNotificationInboxPolling();
  }
}

function renderPatientCase(caseData) {
  const referrals = caseData.referrals.length
    ? caseData.referrals.map((item) => `
        <article class="portal-case-row">
          <strong>${e(item.referralNumber || 'Referral')}</strong>
          <span class="badge">${e(item.status || 'unknown')}</span>
          <span>${e(item.procedure || 'Care coordination')}</span>
          <span class="subtle">${e(item.provider || 'Provider to be confirmed')}</span>
        </article>
      `).join('')
    : '<p class="subtle">No referrals to show.</p>';
  const consultations = caseData.consultations.length
    ? caseData.consultations.map((item) => `
        <article class="portal-case-row">
          <strong>${e(item.consultationNumber || 'Consultation')}</strong>
          <span class="badge">${e(item.status || 'unknown')}</span>
          <span>${e(item.tier || 'Consultation')}</span>
          <span class="subtle">${e(item.channel || 'Channel pending')}</span>
        </article>
      `).join('')
    : '<p class="subtle">No consultations to show.</p>';
  return `
    <section class="panel portal-case-card">
      <h2>${e(caseData.patientName || 'My care')}</h2>
      <div><h3>Referrals</h3><div class="portal-case-list">${referrals}</div></div>
      <div><h3>Consultations</h3><div class="portal-case-list">${consultations}</div></div>
    </section>
  `;
}

async function loadPatientPortal() {
  const data = await api('/api/v1/patient/portal');
  const providers = await api('/api/v1/onboarding/providers');
  const providerOptions = providers.length
    ? `<option value="">Choose an approved provider</option>${providers.map((provider) => `<option value="${e(provider.id)}">${e(provider.name)} · ${e(provider.city || provider.country || '')}</option>`).join('')}`
    : '<option value="">No approved providers available</option>';
  qsa('[data-onboarding-provider]').forEach((select) => {
    const selected = select.value;
    select.innerHTML = providerOptions;
    if (providers.some((provider) => provider.id === selected)) select.value = selected;
    select.disabled = providers.length === 0;
  });
  const cases = [data.self, ...(data.sharedCases || [])].filter(Boolean);
  qs('#patientPortalCases').innerHTML = cases.length
    ? cases.map(renderPatientCase).join('')
    : '<div class="empty">No care records are available yet.</div>';
  const invitationMarkup = [
    ...(data.incomingInvitations || []).map((item) => `
      <article class="item">
        <div><strong>Family access request</strong><div class="subtle">Shared by ${e(item.patientName)} · case status only</div></div>
        <button type="button" data-accept-family="${e(item.id)}">Accept access</button>
      </article>
    `),
    ...(data.familyInvitations || []).map((item) => `
      <article class="item">
        <div class="item-row"><strong>${e(item.invitedEmail)}</strong><span class="badge">${e(item.status)}</span></div>
        <div class="subtle">Case status only · expires ${e(item.expiresAt?.slice(0, 10) || '—')}</div>
        ${['pending', 'accepted'].includes(item.status) ? `<button type="button" class="secondary" data-revoke-family="${e(item.id)}">Revoke access</button>` : ''}
      </article>
    `)
  ].join('');
  qs('#familyInvitationList').innerHTML = invitationMarkup || '<p class="subtle">No family invitations.</p>';
  qs('#onboardingApplicationStatus').innerHTML = data.onboardingApplications?.length
    ? data.onboardingApplications.map((item) => `
        <article class="item">
          <div class="item-row"><strong>${e(item.type === 'clinician' ? 'Clinician application' : 'Provider staff application')}</strong><span class="badge">${e(item.status)}</span></div>
          <span class="subtle">Submitted ${e(item.createdAt?.slice(0, 10) || '—')}${item.reviewedAt ? ` · reviewed ${e(item.reviewedAt.slice(0, 10))}` : ''}</span>
        </article>
      `).join('')
    : '<p class="subtle">No onboarding applications submitted.</p>';
}

function switchView(view) {
  if (!Object.hasOwn(titles, view)) return;
  if (view === 'patient-portal' && state.user?.role !== 'patient') {
    notice('Sign in with a patient account to open My care.', true);
    return;
  }
  const currentActiveView = qs('.view.active')?.id || '';
  const isSameView = currentActiveView === view;
  qsa('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  qsa('.mobile-nav button[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const mobileSos = qs('.mobile-nav .mobile-sos');
  if (mobileSos) mobileSos.classList.toggle('active', view === 'consultations');
  qsa('.view').forEach((section) => section.classList.toggle('active', section.id === view));
  if (isMobileViewport()) closeDrawer();
  qs('#viewTitle').textContent = titles[view][0];
  qs('#viewSubtitle').textContent = titles[view][1];
  if (view === 'reports' && !isSameView) {
    renderStartupPerfTelemetryPanel();
    loadReports().catch((error) => notice(error.message, true));
  }
  if (view === 'patient-portal' && !isSameView) {
    loadPatientPortal().catch((error) => notice(error.message, true));
  }
  if (view === 'consultations') {
    if (!isSameView) {
      loadConsultations().catch((error) => notice(error.message, true));
    }
  } else {
    callController?.leaveCall({ notify: false, sendHangup: true, marker: 'ended' }).catch(() => null);
    stopInteractionPolling();
  }
  if (view === 'account') {
    if (!isSameView) {
      loadAccount({ preferCache: true }).catch((error) => notice(error.message, true));
    }
    startNotificationInboxPolling();
  } else {
    stopNotificationInboxPolling();
  }
}

window.addEventListener('mindset:workspace-view', (event) => {
  switchView(event.detail);
});

async function createUrgentConsultation() {
  if (!state.catalogue?.procedures?.length) {
    await loadCatalogue();
  }
  const defaultProcedureId = state.catalogue?.procedures?.[0]?.id;
  if (!defaultProcedureId) {
    throw new Error('No procedure available for quick urgent consultation.');
  }
  await api('/api/v1/consultations', {
    method: 'POST',
    body: JSON.stringify({
      requestedNeed: 'Urgent triage requested from mobile quick action',
      tier: 'priority',
      procedureId: defaultProcedureId,
      specialtyId: specialtyForProcedure(defaultProcedureId),
      paymentMethod: 'card'
    })
  });
}

const runConsultationAction = createConsultationActionRunner({
  api,
  state,
  qs,
  nextCommunicationLayer,
  setConsultationPanel,
  renderInteractionDesk,
  downloadConsultationEventsExport
});

renderIntakeContent(qs);

bindAppEventHandlers({
  qs,
  state,
  notice,
  signIn,
  registerPatient,
  startVerification,
  confirmVerification,
  switchView,
  loadConsultations,
  closeDrawer,
  toggleRouteCard,
  openDrawer,
  toggleAccordion,
  renderUrgentModeToggleState,
  renderConsultationList,
  createUrgentConsultation,
  applyConsultationQueuePreset,
  prepareCampaign,
  refreshAll,
  performLogout,
  loadLeads,
  loadReferrals,
  loadProviders,
  getAccountUiBindings: () => accountUiBindings,
  getOperationsUiBindings: () => operationsUiBindings,
  getConsultationUiBindings: () => consultationUiBindings,
  isMobileViewport,
  stopInteractionPolling,
  getCallController: () => callController,
  stopNotificationInboxPolling,
  stopNotificationSummaryPolling,
  loadNotificationSummary,
  isAccountViewActive,
  loadNotificationInbox,
  renderStartupPerfTelemetryPanel
});

operationsUiBindings = bindOperationsUiHandlers({
  qs,
  state,
  api,
  notice,
  loadLeads,
  loadReferrals,
  loadProviders,
  loadReports,
  loadPatientPortal,
  loadConsultations,
  renderReferralDetail,
  specialtyForProcedure
});

consultationUiBindings = bindConsultationUiHandlers({
  qs,
  state,
  api,
  notice,
  specialtyForProcedure,
  loadConsultations,
  loadAccount,
  runConsultationAction,
  loadConsultationEventLog,
  loadConsultationMedicalRecords,
  setConsultationActionsOpen,
  setConsultationLogOpen,
  setConsultationRecordsOpen,
  setConsultationPanel,
  renderConsultationList
});

accountUiBindings = bindAccountUiHandlers({
  qs,
  state,
  api,
  notice,
  renderSession,
  stopNotificationInboxPolling,
  stopNotificationSummaryPolling,
  loadAccount,
  loadConsultations,
  loadNotificationInbox,
  persistNotificationInboxFilters,
  renderNotificationPresetState,
  setAccountScreen,
  switchView,
  updateAccountNextActionState,
  confirmBulkNotificationRead,
  markAllNotificationsRead,
  markFilteredNotificationsRead,
  applyNotificationPreset,
  markNotificationRead,
  openNotificationConsultation
});

renderNotificationPresetState();

setConsultationPanel(state.consultationActivePanel);
setAccountScreen(state.accountActiveScreen, { persist: false });

bindConsultationWorkspaceHandlers({
  qs,
  qsa,
  state,
  notice,
  loadConsultations
});

callController = createCallController({
  state,
  qs,
  api,
  notice,
  currentInteractionSession
});
callController.bind();

bindInteractionHandlers({
  qs,
  qsa,
  state,
  notice,
  renderInteractionDesk,
  updateInteractionSubmitState,
  renderInteractionTypeControl,
  currentInteractionSession,
  postQuickSessionMarker,
  downloadInteractionTranscriptExport,
  applyInteractionPreset,
  interactionPresetCatalog,
  INTERACTION_PRESET_KEY,
  inferInteractionTypeClient,
  validateInteractionPayloadClient,
  api
});

window.referralTransitions = {
  draft: ['submitted', 'cancelled'],
  submitted: ['under_review', 'cancelled'],
  under_review: ['matched', 'request_info', 'rejected', 'cancelled'],
  matched: ['sent_to_provider', 'rematch', 'cancelled'],
  sent_to_provider: ['accepted', 'rejected', 'request_info'],
  accepted: ['appointment_scheduled', 'request_info', 'cancelled'],
  request_info: ['resubmitted', 'cancelled'],
  resubmitted: ['under_review', 'accepted', 'rejected'],
  appointment_scheduled: ['patient_attended', 'cancelled'],
  patient_attended: ['service_completed'],
  service_completed: ['closed'],
  rejected: ['rematch', 'closed'],
  rematch: ['matched', 'sent_to_provider', 'cancelled'],
  closed: [],
  cancelled: []
};

restoreAccordionState();
renderSession();
initDeferredCampaignContent(qs);
renderStartupPerfTelemetryPanel();
document.documentElement.dataset.appReady = 'true';
if (qs('#app').dataset.initialView) {
  const initialView = qs('#app').dataset.initialView;
  delete qs('#app').dataset.initialView;
  switchView(initialView);
}
if (state.token) refreshAll().catch((error) => notice(error.message, true));
else loadCatalogue().catch(() => null);
