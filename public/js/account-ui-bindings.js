function selectedValues(select) {
  if (!select) return [];
  return [...select.options].filter((option) => option.selected).map((option) => option.value);
}

export function bindAccountUiHandlers(deps) {
  const {
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
  } = deps;

  async function handleAccountActionClick(button) {
    if (!button) return false;

    if (button.id === 'notificationInboxRefreshBtn') {
      await loadNotificationInbox();
      notice('Notifications refreshed.');
      return true;
    }
    if (button.dataset.accountScreen) {
      setAccountScreen(button.dataset.accountScreen);
      return true;
    }
    if (button.dataset.accountJump) {
      switchView('account');
      setAccountScreen(button.dataset.accountJump);
      return true;
    }
    if (button.dataset.nextActionComplete) {
      await updateAccountNextActionState(button.dataset.nextActionComplete, 'completed');
      notice('Action marked complete.');
      return true;
    }
    if (button.dataset.nextActionSnooze) {
      const snoozeMinutes = Number.parseInt(button.dataset.snoozeMinutes || '120', 10);
      await updateAccountNextActionState(button.dataset.nextActionSnooze, 'snoozed', { snoozeMinutes });
      notice('Action snoozed for 2 hours.');
      return true;
    }
    if (button.id === 'notificationInboxMarkAllBtn') {
      if (!confirmBulkNotificationRead('all')) return true;
      await markAllNotificationsRead();
      notice('All notifications marked as read.');
      return true;
    }
    if (button.id === 'notificationInboxMarkFilteredBtn') {
      if (!confirmBulkNotificationRead('filtered')) return true;
      await markFilteredNotificationsRead();
      notice('Filtered notifications marked as read.');
      return true;
    }
    if (button.dataset.notificationPreset) {
      const applied = applyNotificationPreset(button.dataset.notificationPreset);
      if (applied) {
        await loadNotificationInbox();
      }
      return true;
    }
    if (button.dataset.markNotificationRead) {
      await markNotificationRead(button.dataset.markNotificationRead);
      notice('Notification marked as read.');
      return true;
    }
    if (button.dataset.openNotificationConsultation) {
      await openNotificationConsultation(button.dataset.openNotificationConsultation, {
        notificationId: button.dataset.notificationId,
        markReadFirst: button.dataset.notificationUnread === 'true'
      });
      notice('Consultation opened from notification.');
      return true;
    }

    return false;
  }

  const profileForm = qs('#profileForm');
  if (profileForm) {
    profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = new FormData(event.target);
        const profile = await api('/api/v1/account/profile', {
          method: 'PATCH',
          body: JSON.stringify(Object.fromEntries(form))
        });
        state.user = profile;
        localStorage.setItem('mindset_user', JSON.stringify(state.user));
        renderSession();
        notice('Profile updated.');
        await loadAccount();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const passwordForm = qs('#passwordForm');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = new FormData(event.target);
        await api('/api/v1/account/change-password', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(form))
        });
        localStorage.clear();
        stopNotificationInboxPolling();
        stopNotificationSummaryPolling();
        state.token = '';
        state.user = null;
        renderSession();
        notice('Password changed. Sign in again.');
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const clinicianAvailabilityForm = qs('#clinicianAvailabilityForm');
  if (clinicianAvailabilityForm) {
    clinicianAvailabilityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = event.target;
        await api('/api/v1/account/clinician-availability', {
          method: 'PATCH',
          body: JSON.stringify({
            enabled: form.querySelector('input[name="enabled"]').checked,
            acceptedTiers: selectedValues(form.querySelector('select[name="acceptedTiers"]')),
            specialtyIds: selectedValues(form.querySelector('select[name="specialtyIds"]')),
            procedureIds: selectedValues(form.querySelector('select[name="procedureIds"]'))
          })
        });
        notice('Clinician availability updated.');
        await Promise.all([loadAccount(), loadConsultations()]);
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const notificationPreferencesForm = qs('#notificationPreferencesForm');
  const telegramLinkButton = qs('#telegramLinkButton');
  if (telegramLinkButton) {
    telegramLinkButton.addEventListener('click', async () => {
      try {
        const result = await api('/api/v1/account/telegram/link', { method: 'POST' });
        const linkResult = qs('#telegramLinkResult');
        if (linkResult) {
          const link = document.createElement('a');
          link.href = result.deepLink;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Open Telegram to finish linking';
          linkResult.replaceChildren(link);
          linkResult.classList.remove('hidden');
        }
        notice('Telegram link created. It expires in 15 minutes.');
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const telegramUnlinkButton = qs('#telegramUnlinkButton');
  if (telegramUnlinkButton) {
    telegramUnlinkButton.addEventListener('click', async () => {
      try {
        await api('/api/v1/account/telegram/link', { method: 'DELETE' });
        notice('Telegram account unlinked.');
        await loadAccount();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  if (notificationPreferencesForm) {
    notificationPreferencesForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const form = event.target;
        const preferredChannels = selectedValues(form.querySelector('select[name="preferredChannels"]'));
        const emailCopyEnabled = Boolean(form.querySelector('input[name="emailCopyEnabled"]')?.checked);
        await api('/api/v1/account/notification-preferences', {
          method: 'PATCH',
          body: JSON.stringify({
            consultations: {
              preferredChannels,
              emailCopyEnabled
            }
          })
        });
        notice('Notification preferences updated.');
        await loadAccount();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const notificationInboxChannelFilter = qs('#notificationInboxChannelFilter');
  if (notificationInboxChannelFilter) {
    notificationInboxChannelFilter.addEventListener('change', async (event) => {
      state.notificationInboxFilters.channel = String(event.target.value || 'all');
      persistNotificationInboxFilters();
      renderNotificationPresetState();
      try {
        await loadNotificationInbox();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const notificationInboxTypeFilter = qs('#notificationInboxTypeFilter');
  if (notificationInboxTypeFilter) {
    notificationInboxTypeFilter.addEventListener('change', async (event) => {
      state.notificationInboxFilters.type = String(event.target.value || 'all');
      persistNotificationInboxFilters();
      renderNotificationPresetState();
      try {
        await loadNotificationInbox();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const notificationInboxSeverityFilter = qs('#notificationInboxSeverityFilter');
  if (notificationInboxSeverityFilter) {
    notificationInboxSeverityFilter.addEventListener('change', async (event) => {
      state.notificationInboxFilters.severity = String(event.target.value || 'all');
      persistNotificationInboxFilters();
      renderNotificationPresetState();
      try {
        await loadNotificationInbox();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  const notificationInboxUnreadOnlyFilter = qs('#notificationInboxUnreadOnly');
  if (notificationInboxUnreadOnlyFilter) {
    notificationInboxUnreadOnlyFilter.addEventListener('change', async (event) => {
      state.notificationInboxFilters.unreadOnly = Boolean(event.target.checked);
      persistNotificationInboxFilters();
      renderNotificationPresetState();
      try {
        await loadNotificationInbox();
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  return {
    handleAccountActionClick
  };
}
