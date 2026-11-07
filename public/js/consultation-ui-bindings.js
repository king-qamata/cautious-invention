export function bindConsultationUiHandlers(deps) {
  const {
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
  } = deps;

  async function handleConsultationActionClick(button) {
    if (!button) return false;

    if (button.dataset.consultToggle === 'actions' && button.dataset.consultId) {
      const consultId = button.dataset.consultId;
      const isOpen = Boolean(state.consultationUiState.actionsOpenById[consultId]);
      setConsultationActionsOpen(consultId, !isOpen);
      return true;
    }

    if (button.dataset.consultPanel) {
      setConsultationPanel(button.dataset.consultPanel);
      return true;
    }

    if (button.dataset.consultToggle === 'events' && button.dataset.consultId) {
      const consultId = button.dataset.consultId;
      const isOpen = Boolean(state.consultationUiState.logOpenById[consultId]);
      await setConsultationLogOpen(consultId, !isOpen);
      return true;
    }

    if (button.dataset.consultToggle === 'records' && button.dataset.consultId) {
      const consultId = button.dataset.consultId;
      const isOpen = Boolean(state.consultationUiState.recordsOpenById[consultId]);
      await setConsultationRecordsOpen(consultId, !isOpen);
      if (!isOpen) {
        notice('Patient records loaded.');
      }
      return true;
    }

    if (!button.dataset.consultAction) return false;

    const consultId = button.dataset.consultId;
    const result = await runConsultationAction(button.dataset.consultAction, consultId);
    if (button.dataset.consultAction === 'refresh_events') {
      await loadConsultationEventLog(consultId, { forceRefresh: true });
      notice('Consultation event log refreshed.');
      renderConsultationList();
      return true;
    }
    if (button.dataset.consultAction === 'export_events') {
      notice('Consultation event log exported as CSV.');
      return true;
    }
    if (button.dataset.consultAction === 'verify_payment') {
      notice(result?.payment?.status === 'captured'
        ? 'Payment confirmed. The clinician can now start the consultation.'
        : result?.payment?.status === 'refund_required'
          ? 'Payment received after cancellation; a manual refund review is required.'
          : 'Payment is not confirmed yet. You can check again shortly.');
      await Promise.all([loadConsultations(), loadAccount()]);
      return true;
    }
    delete state.consultationEventLogById[consultId];
    delete state.consultationEventLogErrorById[consultId];
    delete state.consultationEventLogLoadingById[consultId];
    if (state.consultationUiState.recordsOpenById[consultId]) {
      await loadConsultationMedicalRecords(consultId, { forceRefresh: true });
    }
    if (button.dataset.consultAction === 'switch_layer' && result?.channel) {
      notice(`Session switched to ${result.channel.replace(/_/g, ' ')}.`);
    } else {
      notice(`Consultation ${button.dataset.consultAction} action completed.`);
    }
    await Promise.all([loadConsultations(), loadAccount()]);
    return true;
  }

  const consultationForm = qs('#consultationForm');
  if (consultationForm) {
    consultationForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = new FormData(event.target);
        const procedureId = form.get('procedureId');
        await api('/api/v1/consultations', {
          method: 'POST',
          body: JSON.stringify({
            requestedNeed: form.get('requestedNeed'),
            tier: form.get('tier'),
            requestedCommunicationMode: form.get('requestedCommunicationMode'),
            procedureId,
            specialtyId: specialtyForProcedure(procedureId),
            paymentMethod: form.get('paymentMethod')
          })
        });
        event.target.reset();
        notice('Consultation request submitted.');
        await Promise.all([loadConsultations(), loadAccount()]);
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  return {
    handleConsultationActionClick
  };
}