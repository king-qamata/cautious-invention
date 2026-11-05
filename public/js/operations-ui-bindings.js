export function bindOperationsUiHandlers(deps) {
  const {
    qs,
    state,
    api,
    notice,
    loadLeads,
    loadReferrals,
    loadProviders,
    loadReports,
    loadConsultations,
    renderReferralDetail,
    specialtyForProcedure
  } = deps;

  async function handleOperationsActionClick(button) {
    if (!button) return false;

    if (button.id === 'runClaimSweep') {
      await api('/api/v1/operations/jobs/release-unclaimed-consultations', { method: 'POST' });
      notice('Unclaimed consultation sweep completed.');
      await loadConsultations();
      return true;
    }

    if (button.dataset.qualify) {
      await api(`/api/v1/leads/${button.dataset.qualify}`, { method: 'PATCH', body: JSON.stringify({ status: 'qualified' }) });
      notice('Lead qualified.');
      await loadLeads();
      return true;
    }

    if (button.dataset.funnelStage) {
      await api(`/api/v1/leads/${button.dataset.funnelStage}`, { method: 'PATCH', body: JSON.stringify({ funnelStage: button.dataset.nextStage }) });
      notice('Funnel stage advanced.');
      await Promise.all([loadLeads(), loadReports()]);
      return true;
    }

    if (button.dataset.convert) {
      const procedureId = qs(`[data-lead-procedure="${button.dataset.convert}"]`).value;
      await api(`/api/v1/leads/${button.dataset.convert}/convert-to-referral`, {
        method: 'POST',
        body: JSON.stringify({ procedureId, specialtyId: specialtyForProcedure(procedureId), consentGiven: true })
      });
      notice('Referral created.');
      await Promise.all([loadLeads(), loadReferrals(), loadReports()]);
      return true;
    }

    if (button.dataset.selectReferral) {
      state.selectedReferral = await api(`/api/v1/referrals/${button.dataset.selectReferral}`);
      await renderReferralDetail();
      return true;
    }

    if (button.id === 'moveReferral') {
      const toStatus = qs('#nextStatus').value;
      const assignedProviderId = qs('#assignedProvider').value;
      await api(`/api/v1/referrals/${state.selectedReferral.referralNumber}/transition`, {
        method: 'POST',
        body: JSON.stringify({ toStatus, assignedProviderId, note: qs('#transitionNote').value })
      });
      state.selectedReferral = await api(`/api/v1/referrals/${state.selectedReferral.referralNumber}`);
      notice('Referral moved.');
      await Promise.all([loadReferrals(), loadReports()]);
      return true;
    }

    if (button.id === 'attachDoc') {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.onchange = async () => {
        const file = picker.files?.[0];
        if (!file) return;
        try {
          if (file.size > 700 * 1024) throw new Error('Choose a document smaller than 700 KB.');
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          await api(`/api/v1/referrals/${state.selectedReferral.referralNumber}/documents`, {
            method: 'POST',
            body: JSON.stringify({ documentType: 'supporting', fileName: file.name, mimeType: file.type, contentBase64: btoa(binary) })
          });
          notice('Document uploaded.');
          await renderReferralDetail();
        } catch (error) {
          notice(error.message, true);
        }
      };
      picker.click();
      return true;
    }

    if (button.dataset.downloadDocument) {
      const response = await fetch(`/api/v1/documents/${button.dataset.downloadDocument}/download`, {
        headers: { authorization: `Bearer ${state.token}` }
      });
      if (!response.ok) throw new Error('Document download failed.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      link.click();
      URL.revokeObjectURL(url);
      return true;
    }

    return false;
  }

  const leadForm = qs('#leadForm');
  if (leadForm) {
    leadForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = new FormData(event.target);
        const payload = Object.fromEntries(form);
        await api('/api/v1/leads', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        notice('Lead created.');
        await Promise.all([loadLeads(), loadReports()]);
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const providerForm = qs('#providerForm');
  if (providerForm) {
    providerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = new FormData(event.target);
        await api('/api/v1/providers', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
        event.target.reset();
        notice('Provider added.');
        await Promise.all([loadProviders(), loadReports()]);
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  return {
    handleOperationsActionClick
  };
}
