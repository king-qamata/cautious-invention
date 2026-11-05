const DEFAULT_NOTIFICATION_PRESET_RULES = {
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

export function createAccountNotificationWorkspaceController(deps) {
  const {
    state,
    qs,
    qsa,
    e,
    api,
    updateAccountTabUnreadIndicator,
    notificationPresetRules = DEFAULT_NOTIFICATION_PRESET_RULES,
    notificationInboxChannelKey = 'mindset_notification_inbox_channel',
    notificationInboxTypeKey = 'mindset_notification_inbox_type',
    notificationInboxSeverityKey = 'mindset_notification_inbox_severity',
    notificationInboxUnreadOnlyKey = 'mindset_notification_inbox_unread_only',
    notificationSummaryPollMs = 15000,
    notificationInboxPollMs = 30000,
    resolveAccountViewActive,
    switchView,
    loadConsultations,
    setConsultationPanel,
    renderInteractionDesk
  } = deps;

  function isAccountViewActive() {
    if (typeof resolveAccountViewActive === 'function') {
      return Boolean(resolveAccountViewActive());
    }
    const active = qs('.view.active');
    return active?.id === 'account';
  }

  function notificationFilterScopeLabel() {
    const filters = state.notificationInboxFilters;
    const parts = [];
    if (filters.channel !== 'all') parts.push(`channel ${String(filters.channel).replace(/_/g, '-')}`);
    if (filters.type !== 'all') parts.push(`${filters.type} type`);
    if (filters.severity !== 'all') parts.push(`${filters.severity} severity`);
    if (filters.unreadOnly) parts.push('unread only');
    return parts.length ? parts.join(', ') : 'all visible notifications';
  }

  function confirmBulkNotificationRead(mode) {
    if (mode === 'all') {
      const unreadCount = Number(state.notificationInboxMeta.unreadCount || 0);
      if (unreadCount <= 0) return false;
      return window.confirm(`Mark all ${unreadCount} unread notifications as read?`);
    }

    const visibleUnreadCount = Number(state.notificationInboxMeta.visibleUnreadCount || 0);
    if (visibleUnreadCount <= 0) return false;
    const scope = notificationFilterScopeLabel();
    return window.confirm(`Mark ${visibleUnreadCount} filtered unread notifications as read (${scope})?`);
  }

  function persistNotificationInboxFilters() {
    localStorage.setItem(notificationInboxChannelKey, state.notificationInboxFilters.channel);
    localStorage.setItem(notificationInboxTypeKey, state.notificationInboxFilters.type);
    localStorage.setItem(notificationInboxSeverityKey, state.notificationInboxFilters.severity);
    localStorage.setItem(notificationInboxUnreadOnlyKey, state.notificationInboxFilters.unreadOnly ? '1' : '0');
  }

  function notificationInboxQueryString() {
    const params = new URLSearchParams();
    if (state.notificationInboxFilters.channel && state.notificationInboxFilters.channel !== 'all') {
      params.set('channel', state.notificationInboxFilters.channel);
    }
    if (state.notificationInboxFilters.type && state.notificationInboxFilters.type !== 'all') {
      params.set('type', state.notificationInboxFilters.type);
    }
    if (state.notificationInboxFilters.severity && state.notificationInboxFilters.severity !== 'all') {
      params.set('severity', state.notificationInboxFilters.severity);
    }
    if (state.notificationInboxFilters.unreadOnly) {
      params.set('unreadOnly', 'true');
    }
    params.set('limit', '50');
    return params.toString();
  }

  function notificationTypeLabel(type) {
    const value = String(type || 'system');
    if (value === 'communication') return 'communication';
    if (value === 'consultation') return 'consultation';
    if (value === 'referral') return 'referral';
    if (value === 'account') return 'account';
    return 'system';
  }

  function notificationSeverityLabel(severity) {
    const value = String(severity || 'info');
    if (value === 'critical') return 'critical';
    if (value === 'warning') return 'warning';
    return 'info';
  }

  function notificationTimestampLabel(value) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp)) return 'Unknown time';
    return new Date(timestamp).toLocaleString();
  }

  function isSameNotificationFilterState(left, right) {
    return (
      String(left?.channel || 'all') === String(right?.channel || 'all')
      && String(left?.type || 'all') === String(right?.type || 'all')
      && String(left?.severity || 'all') === String(right?.severity || 'all')
      && Boolean(left?.unreadOnly) === Boolean(right?.unreadOnly)
    );
  }

  function activeNotificationPreset() {
    for (const [presetKey, preset] of Object.entries(notificationPresetRules)) {
      if (isSameNotificationFilterState(state.notificationInboxFilters, preset)) {
        return presetKey;
      }
    }
    return 'custom';
  }

  function renderNotificationPresetState() {
    const activePreset = activeNotificationPreset();
    qsa('[data-notification-preset]').forEach((button) => {
      const isActive = button.dataset.notificationPreset === activePreset;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function applyNotificationPreset(presetKey) {
    const preset = notificationPresetRules[presetKey];
    if (!preset) return false;
    state.notificationInboxFilters = {
      channel: preset.channel,
      type: preset.type,
      severity: preset.severity,
      unreadOnly: preset.unreadOnly
    };
    persistNotificationInboxFilters();
    renderNotificationPresetState();
    return true;
  }

  function renderNotificationInbox(payload) {
    const list = qs('#notificationInboxList');
    const meta = qs('#notificationInboxMeta');
    const unreadBadge = qs('#notificationInboxUnreadBadge');
    const markAllBtn = qs('#notificationInboxMarkAllBtn');
    const markFilteredBtn = qs('#notificationInboxMarkFilteredBtn');
    const channelFilter = qs('#notificationInboxChannelFilter');
    const typeFilter = qs('#notificationInboxTypeFilter');
    const severityFilter = qs('#notificationInboxSeverityFilter');
    const unreadOnlyFilter = qs('#notificationInboxUnreadOnly');
    if (!list || !meta) return;

    if (channelFilter) {
      channelFilter.value = state.notificationInboxFilters.channel;
    }
    if (typeFilter) {
      typeFilter.value = state.notificationInboxFilters.type;
    }
    if (severityFilter) {
      severityFilter.value = state.notificationInboxFilters.severity;
    }
    if (unreadOnlyFilter) {
      unreadOnlyFilter.checked = state.notificationInboxFilters.unreadOnly;
    }
    renderNotificationPresetState();

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const payloadMeta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
    const unreadCount = Number(payloadMeta.unreadCount || 0);
    const totalCount = Number(payloadMeta.totalCount || 0);
    const visibleCount = Number(payloadMeta.visibleCount || items.length || 0);
    const visibleUnreadCount = Number(payloadMeta.visibleUnreadCount || 0);
    const visibleBySeverity = payloadMeta.visibleBySeverity || {};
    const visibleByType = payloadMeta.visibleByType || {};

    state.notificationInboxMeta = {
      unreadCount,
      totalCount,
      visibleCount,
      visibleUnreadCount
    };
    updateAccountTabUnreadIndicator();

    if (unreadBadge) {
      unreadBadge.classList.toggle('hidden', unreadCount <= 0);
      unreadBadge.textContent = `${unreadCount} unread`;
    }
    if (markAllBtn) {
      markAllBtn.disabled = unreadCount <= 0;
    }
    if (markFilteredBtn) {
      markFilteredBtn.disabled = visibleUnreadCount <= 0;
    }

    meta.textContent = `Showing ${visibleCount} of ${totalCount} notifications. Severity: ${Number(visibleBySeverity.critical || 0)} critical, ${Number(visibleBySeverity.warning || 0)} warning. Types: ${Number(visibleByType.communication || 0)} communication, ${Number(visibleByType.consultation || 0)} consultation.`;

    if (!items.length) {
      list.innerHTML = '<div class="empty">No notifications for the selected filters.</div>';
      return;
    }

    list.innerHTML = items
      .map((item) => {
        const unread = !item.readAt;
        const statusText = unread ? 'Unread' : `Read ${e(notificationTimestampLabel(item.readAt))}`;
        const createdAtText = notificationTimestampLabel(item.createdAt || item.sentAt);
        const channelLabel = String(item.channel || 'in_app').replace('_', '-');
        const subject = item.subject || `${channelLabel.toUpperCase()} notification`;
        const notificationType = notificationTypeLabel(item.notificationType);
        const severity = notificationSeverityLabel(item.severity);

        return `
          <article class="item notification-item ${unread ? 'is-unread' : ''}">
            <div class="notification-item-head">
              <strong>${e(subject)}</strong>
              <span class="notification-channel-pill">${e(channelLabel)}</span>
            </div>
            <div class="notification-item-tags">
              <span class="notification-tag type-${e(notificationType)}">${e(notificationType)}</span>
              <span class="notification-tag severity-${e(severity)}">${e(severity)}</span>
            </div>
            <div class="notification-item-meta">
              <span>${e(createdAtText)}</span>
              <span>${e(statusText)}</span>
              ${item.consultationId ? `<span>Consultation: ${e(item.consultationId)}</span>` : ''}
            </div>
            <div class="notification-item-body">${e(item.body || '')}</div>
            <div class="actions">
              ${unread ? `<button type="button" class="secondary" data-mark-notification-read="${e(item.id)}">Mark read</button>` : ''}
              ${item.consultationId ? `<button type="button" class="secondary" data-open-notification-consultation="${e(item.consultationId)}" data-notification-id="${e(item.id)}" data-notification-unread="${unread ? 'true' : 'false'}">Open consultation</button>` : ''}
            </div>
          </article>
        `;
      })
      .join('');
  }

  function applyNotificationSummary(payload) {
    const unreadCount = Number(payload?.unreadCount || 0);
    const totalCount = Number(payload?.totalCount || 0);
    state.notificationInboxMeta = {
      unreadCount,
      totalCount,
      visibleCount: state.notificationInboxMeta.visibleCount,
      visibleUnreadCount: state.notificationInboxMeta.visibleUnreadCount
    };
    updateAccountTabUnreadIndicator();

    const unreadBadge = qs('#notificationInboxUnreadBadge');
    if (unreadBadge) {
      unreadBadge.classList.toggle('hidden', unreadCount <= 0);
      unreadBadge.textContent = `${unreadCount} unread`;
    }

    const markAllBtn = qs('#notificationInboxMarkAllBtn');
    if (markAllBtn) {
      markAllBtn.disabled = unreadCount <= 0;
    }

    const markFilteredBtn = qs('#notificationInboxMarkFilteredBtn');
    if (markFilteredBtn) {
      markFilteredBtn.disabled = Number(state.notificationInboxMeta.visibleUnreadCount || 0) <= 0;
    }

    const meta = qs('#notificationInboxMeta');
    const inboxList = qs('#notificationInboxList');
    const listEmpty = inboxList && inboxList.children.length === 1 && inboxList.querySelector('.empty');
    if (meta && (!state.user || listEmpty)) {
      meta.textContent = state.user
        ? `Unread ${unreadCount} of ${totalCount} notifications.`
        : 'Sign in to load notifications.';
    }
  }

  async function loadNotificationInbox(options = {}) {
    if (!state.user) return;
    try {
      const payload = options.preloadedPayload && typeof options.preloadedPayload === 'object'
        ? options.preloadedPayload
        : await api(`/api/v1/account/notifications${notificationInboxQueryString() ? `?${notificationInboxQueryString()}` : ''}`);
      renderNotificationInbox(payload);
    } catch (error) {
      if (!options.silent) throw error;
    }
  }

  async function loadNotificationSummary(options = {}) {
    if (!state.user || !state.token) return;
    try {
      const payload = await api('/api/v1/account/notifications/summary');
      applyNotificationSummary(payload);
    } catch (error) {
      if (!options.silent) throw error;
    }
  }

  function stopNotificationSummaryPolling() {
    if (state.notificationSummaryPollTimer) {
      clearInterval(state.notificationSummaryPollTimer);
      state.notificationSummaryPollTimer = null;
    }
  }

  function stopNotificationInboxPolling() {
    if (state.notificationInboxPollTimer) {
      clearInterval(state.notificationInboxPollTimer);
      state.notificationInboxPollTimer = null;
    }
  }

  function startNotificationInboxPolling() {
    stopNotificationInboxPolling();
    if (!state.user || !state.token) return;
    if (!isAccountViewActive()) return;

    loadNotificationInbox({ silent: true }).catch(() => null);
    state.notificationInboxPollTimer = setInterval(() => {
      if (!isAccountViewActive() || document.hidden) return;
      loadNotificationInbox({ silent: true }).catch(() => null);
    }, notificationInboxPollMs);
  }

  function startNotificationSummaryPolling() {
    if (!state.user || !state.token) return;
    if (state.notificationSummaryPollTimer) return;

    loadNotificationSummary({ silent: true }).catch(() => null);
    state.notificationSummaryPollTimer = setInterval(() => {
      loadNotificationSummary({ silent: true }).catch(() => null);
    }, notificationSummaryPollMs);
  }

  async function markNotificationRead(notificationId, options = {}) {
    const result = await api('/api/v1/account/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ notificationId })
    });

    if (options.refreshInbox === false) {
      const unreadCount = Number(result?.unreadCount || 0);
      const updatedCount = Number(result?.updatedCount || 0);
      state.notificationInboxMeta.visibleUnreadCount = Math.max(
        0,
        Number(state.notificationInboxMeta.visibleUnreadCount || 0) - updatedCount
      );
      applyNotificationSummary({
        unreadCount,
        totalCount: state.notificationInboxMeta.totalCount
      });
      return result;
    }

    await loadNotificationInbox();
    return result;
  }

  async function markAllNotificationsRead() {
    await api('/api/v1/account/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ markAll: true })
    });
    await loadNotificationInbox();
  }

  async function markFilteredNotificationsRead() {
    await api('/api/v1/account/notifications/read', {
      method: 'POST',
      body: JSON.stringify({
        markFiltered: true,
        filters: {
          channel: state.notificationInboxFilters.channel,
          type: state.notificationInboxFilters.type,
          severity: state.notificationInboxFilters.severity,
          unreadOnly: state.notificationInboxFilters.unreadOnly
        }
      })
    });
    await loadNotificationInbox();
  }

  async function openNotificationConsultation(consultationId, options = {}) {
    if (options.markReadFirst && options.notificationId) {
      await markNotificationRead(options.notificationId, { refreshInbox: false });
    }
    switchView('consultations');
    await loadConsultations();
    setConsultationPanel('comms');
    await renderInteractionDesk(consultationId);
  }

  return {
    isAccountViewActive,
    notificationFilterScopeLabel,
    confirmBulkNotificationRead,
    persistNotificationInboxFilters,
    renderNotificationPresetState,
    applyNotificationPreset,
    applyNotificationSummary,
    loadNotificationInbox,
    loadNotificationSummary,
    stopNotificationSummaryPolling,
    stopNotificationInboxPolling,
    startNotificationInboxPolling,
    startNotificationSummaryPolling,
    markNotificationRead,
    markAllNotificationsRead,
    markFilteredNotificationsRead,
    openNotificationConsultation
  };
}
