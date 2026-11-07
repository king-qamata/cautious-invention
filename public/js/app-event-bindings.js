export function bindAppEventHandlers(deps) {
  const {
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
    getAccountUiBindings,
    getOperationsUiBindings,
    getConsultationUiBindings,
    isMobileViewport,
    stopInteractionPolling,
    getCallController,
    stopNotificationInboxPolling,
    stopNotificationSummaryPolling,
    loadNotificationSummary,
    isAccountViewActive,
    loadNotificationInbox,
    renderStartupPerfTelemetryPanel
  } = deps;

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    const routeCard = event.target.closest('[data-route-card]');
    if (event.target.id === 'drawerBackdrop') {
      closeDrawer();
      return;
    }
    if (routeCard && !button) {
      toggleRouteCard(routeCard);
      return;
    }
    if (!button) return;
    try {
      if (button.dataset.sosRoute === 'consultations') {
        const wasConsultationsActive = qs('.view.active')?.id === 'consultations';
        switchView('consultations');
        if (wasConsultationsActive) {
          await loadConsultations();
        }
        notice('Emergency path opened. Start urgent consultation triage.');
      }
      if (button.id === 'menuToggleBtn') {
        if (document.body.classList.contains('drawer-open')) closeDrawer();
        else openDrawer();
      }
      if (button.dataset.accordionToggle) {
        toggleAccordion(button.dataset.accordionToggle);
      }
      if (button.dataset.urgentModeToggle === 'true') {
        state.urgentMode = !state.urgentMode;
        renderUrgentModeToggleState();
        renderConsultationList();
        notice(state.urgentMode ? 'Urgent mode enabled. Showing priority queues only.' : 'Urgent mode disabled. Showing full queue.');
      }
      if (button.id === 'quickUrgentConsultBtn') {
        await createUrgentConsultation();
        state.urgentMode = true;
        const wasConsultationsActive = qs('.view.active')?.id === 'consultations';
        switchView('consultations');
        if (wasConsultationsActive) {
          await loadConsultations();
        }
        notice('Urgent consultation created and queue focused.');
      }
      if (button.dataset.view) {
        if (button.dataset.view === 'consultations' && button.dataset.queuePreset) {
          applyConsultationQueuePreset(button.dataset.queuePreset);
        }
        switchView(button.dataset.view);
      }
      if (button.dataset.campaignCta) prepareCampaign(button.dataset.campaignCta, switchView);
      if (button.id === 'loginBtn') {
        await signIn({
          email: qs('#email').value,
          password: qs('#password').value
        });
        notice('Signed in.');
        await refreshAll();
      }
      if (button.id === 'openRegistration') {
        qs('#loginPanel').classList.add('hidden');
        qs('#registrationFlow').classList.remove('hidden');
      }
      if (button.id === 'closeRegistration' || button.id === 'cancelVerification') {
        qs('#registrationFlow').classList.add('hidden');
        qs('#loginPanel').classList.remove('hidden');
      }
      if (button.id === 'resendVerification') {
        const form = qs('#verifyAccountForm');
        const email = form.elements.email.value;
        const channel = form.elements.channel.value;
        const result = await startVerification({ email, channel });
        qs('#verificationMessage').textContent = result.message;
        notice(result.message);
      }
      if (button.id === 'logoutBtn') await performLogout();
      if (button.id === 'logoutBtnMobile') await performLogout();
      if (button.id === 'refreshLeads') await loadLeads();
      if (button.id === 'refreshConsultations') await loadConsultations();
      if (button.id === 'refreshReferrals') await loadReferrals();
      if (button.id === 'refreshProviders') await loadProviders();

      const accountUiBindings = getAccountUiBindings();
      if (accountUiBindings && await accountUiBindings.handleAccountActionClick(button)) {
        return;
      }

      const operationsUiBindings = getOperationsUiBindings();
      if (operationsUiBindings && await operationsUiBindings.handleOperationsActionClick(button)) {
        return;
      }

      const consultationUiBindings = getConsultationUiBindings();
      if (consultationUiBindings && await consultationUiBindings.handleConsultationActionClick(button)) {
        return;
      }
    } catch (error) {
      notice(error.message, true);
    }
  });

  const registrationForm = qs('#registerPatientForm');
  const verificationChannel = registrationForm?.elements.verificationChannel;
  const registrationPhone = registrationForm?.elements.phone;
  verificationChannel?.addEventListener('change', () => {
    if (registrationPhone) registrationPhone.required = verificationChannel.value === 'sms';
  });
  registrationForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(registrationForm);
    const payload = Object.fromEntries(form);
    payload.consentGiven = registrationForm.elements.consentGiven.checked;
    const channel = String(payload.verificationChannel);
    const email = String(payload.email);
    try {
      await registerPatient(payload);
      qs('#verifyAccountForm').elements.email.value = email;
      qs('#verifyAccountForm').elements.channel.value = channel;
      qs('#verificationMessage').textContent = `Enter the code sent by ${channel}. Codes expire after 10 minutes.`;
      qs('#verifyAccountForm').classList.remove('hidden');
      registrationForm.classList.add('hidden');
      notice('Account created. Check your selected contact method for a verification code.');
    } catch (error) {
      if (error.status === 502 || error.status === 503) {
        qs('#verifyAccountForm').elements.email.value = email;
        qs('#verifyAccountForm').elements.channel.value = channel;
        qs('#verificationMessage').textContent = 'Code delivery is not available right now. You can try resending after the service is configured.';
        qs('#verifyAccountForm').classList.remove('hidden');
        registrationForm.classList.add('hidden');
      }
      notice(error.message, true);
    }
  });

  const verificationForm = qs('#verifyAccountForm');
  verificationForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(verificationForm));
      await confirmVerification(payload);
      qs('#email').value = payload.email;
      qs('#registrationFlow').classList.add('hidden');
      verificationForm.reset();
      registrationForm.reset();
      registrationForm.classList.remove('hidden');
      qs('#loginPanel').classList.remove('hidden');
      notice('Account verified. Sign in to continue.');
      qs('#password').focus();
    } catch (error) {
      notice(error.message, true);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) {
      closeDrawer();
      const menuToggle = qs('#menuToggleBtn');
      if (menuToggle) menuToggle.focus();
      return;
    }
    const routeCard = event.target.closest('[data-route-card]');
    if (!routeCard) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleRouteCard(routeCard);
    }
  });

  window.addEventListener('resize', () => {
    if (!isMobileViewport()) closeDrawer();
  });

  window.addEventListener('beforeunload', () => {
    const callController = getCallController();
    callController?.leaveCall({ notify: false, sendHangup: true, marker: 'ended' }).catch(() => null);
    stopInteractionPolling();
    stopNotificationInboxPolling();
    stopNotificationSummaryPolling();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.user || !state.token) return;
    loadNotificationSummary({ silent: true }).catch(() => null);
    if (isAccountViewActive()) {
      loadNotificationInbox({ silent: true }).catch(() => null);
    }
  });

  window.addEventListener('mindset:perf', () => {
    renderStartupPerfTelemetryPanel();
  });
}
