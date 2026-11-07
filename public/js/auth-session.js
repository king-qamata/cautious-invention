export function createAuthSessionController(deps) {
  const {
    state,
    qs,
    api,
    notice,
    localStorageRef = localStorage,
    accordionStateKey,
    consultationPerfHistoryKey,
    interactionPresetKey,
    resetAccountWorkspaceView,
    updateAccountTabUnreadIndicator,
    stopInteractionPolling,
    stopNotificationInboxPolling,
    stopNotificationSummaryPolling,
    getCallController
  } = deps;

  function renderSession() {
    const signedInLabel = state.user ? `${state.user.firstName} ${state.user.lastName} (${state.user.role})` : 'Not signed in';
    qs('#sessionUser').textContent = signedInLabel;
    const compactSession = qs('#sessionUserCompact');
    if (compactSession) compactSession.textContent = signedInLabel;
    qs('#loginPanel').classList.toggle('hidden', Boolean(state.user));
    qs('#registrationFlow')?.classList.add('hidden');
    qs('#userChip').classList.toggle('hidden', !state.user);
    qs('#logoutBtn').classList.toggle('hidden', !state.user);
    const patientPortalLink = qs('.tabs [data-view="patient-portal"]');
    const mobilePatientPortalLink = qs('.mobile-nav [data-view="patient-portal"]');
    const canOpenPatientPortal = state.user?.role === 'patient';
    patientPortalLink?.classList.toggle('hidden', !canOpenPatientPortal);
    mobilePatientPortalLink?.classList.toggle('hidden', !canOpenPatientPortal);
    const logoutBtnMobile = qs('#logoutBtnMobile');
    if (logoutBtnMobile) logoutBtnMobile.classList.toggle('hidden', !state.user);
    if (state.user) {
      const initials = `${state.user.firstName?.[0] || ''}${state.user.lastName?.[0] || ''}`.toUpperCase();
      qs('#userAvatar').textContent = initials || 'CC';
      qs('#userRole').textContent = state.user.role === 'coordinator' ? 'Care Coordinator' : state.user.role;
      qs('#userEmail').textContent = ` · ${state.user.email}`;

      const savedPreset = localStorageRef.getItem(`${interactionPresetKey}:${state.user.role}`) || '';
      const presetSelect = qs('#interactionPreset');
      if (presetSelect && savedPreset) {
        presetSelect.value = savedPreset;
      }
    }

    if (!state.user) {
      state.accountWorkspace = null;
      state.notificationInboxMeta = {
        unreadCount: 0,
        totalCount: 0,
        visibleCount: 0,
        visibleUnreadCount: 0
      };
      resetAccountWorkspaceView();
    }

    updateAccountTabUnreadIndicator();
  }

  async function signIn(credentials) {
    const { email, password } = credentials;
    const data = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    state.token = data.token;
    state.user = data.user;
    localStorageRef.setItem('mindset_token', state.token);
    localStorageRef.setItem('mindset_user', JSON.stringify(state.user));
    return data;
  }

  async function registerPatient(payload) {
    return api('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async function startVerification(payload) {
    return api('/api/v1/auth/verification/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async function confirmVerification(payload) {
    return api('/api/v1/auth/verification/confirm', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async function performLogout() {
    const callController = getCallController();
    await callController?.leaveCall({ notify: false, sendHangup: true, marker: 'ended' }).catch(() => null);
    stopInteractionPolling();
    stopNotificationInboxPolling();
    stopNotificationSummaryPolling();
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => null);
    const accordionState = localStorageRef.getItem(accordionStateKey);
    const perfHistoryState = localStorageRef.getItem(consultationPerfHistoryKey);
    localStorageRef.clear();
    if (accordionState) localStorageRef.setItem(accordionStateKey, accordionState);
    if (perfHistoryState) localStorageRef.setItem(consultationPerfHistoryKey, perfHistoryState);
    state.token = '';
    state.user = null;
    renderSession();
    notice('Signed out.');
  }

  return {
    renderSession,
    signIn,
    registerPatient,
    startVerification,
    confirmVerification,
    performLogout
  };
}
