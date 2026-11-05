function normalizeSignalDescription(payload) {
  if (payload && typeof payload === 'object' && payload.description) {
    return payload.description;
  }
  return payload;
}

function normalizeIceCandidate(payload) {
  if (payload && typeof payload === 'object' && payload.candidate) {
    return payload.candidate;
  }
  return payload;
}

function classifyMediaError(error) {
  const name = String(error?.name || '').toLowerCase();
  if (name === 'notallowederror' || name === 'securityerror') {
    return {
      recoverable: true,
      message: 'Microphone or camera permission is blocked. Allow media access in your browser, then retry.'
    };
  }
  if (name === 'notfounderror' || name === 'overconstrainederror') {
    return {
      recoverable: true,
      message: 'No compatible microphone/camera device was found. Connect a device and retry media permissions.'
    };
  }
  if (name === 'notreadableerror') {
    return {
      recoverable: true,
      message: 'Media device is currently busy. Close other call apps, then retry.'
    };
  }
  return {
    recoverable: false,
    message: error?.message || 'Unable to initialize media devices for this call.'
  };
}

const TURN_REFRESH_SAFETY_MS = 45 * 1000;
const TURN_REFRESH_MIN_WAIT_MS = 5 * 1000;
const SIGNALING_RECONNECT_BASE_MS = 1500;
const SIGNALING_RECONNECT_MAX_ATTEMPTS = 4;

export function createCallController(deps) {
  const {
    state,
    qs,
    api,
    notice,
    currentInteractionSession
  } = deps;

  const callState = {
    consultationId: null,
    sessionId: null,
    channel: null,
    selfUserId: null,
    activePeerUserId: null,
    pc: null,
    ws: null,
    localStream: null,
    remoteStream: null,
    joining: false,
    connected: false,
    markerLastSentAt: {},
    serverCallState: 'idle',
    media: {
      micMuted: false,
      cameraEnabled: true,
      permissionIssue: null
    },
    transport: {
      turnCredentialMode: null,
      turnCredentialExpiresAt: null,
      turnRefreshTimerId: null,
      relayMetaPulseTimerId: null,
      turnRefreshInFlight: false,
      signalingReconnectTimerId: null,
      signalingReconnectAttempts: 0,
      intentionalSocketClose: false
    },
    ui: {
      minimized: false,
      pinned: false
    }
  };

  function supportsWebRtc() {
    return Boolean(
      window.RTCPeerConnection &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      window.WebSocket
    );
  }

  function activeContext() {
    return {
      consultationId: state.consultationInteractionContext.consultationId,
      sessionId: state.consultationInteractionContext.sessionId,
      session: currentInteractionSession()
    };
  }

  function isCallChannel(session) {
    return session && ['voice_call', 'video_call'].includes(session.channel);
  }

  function isJoinableSession(session) {
    return isCallChannel(session) && session.status === 'active';
  }

  function setCallStatus(text, tone = 'neutral') {
    const status = qs('#callStatusBadge');
    const hint = qs('#callDeskHint');
    if (status) {
      status.textContent = text;
      status.classList.remove('ok', 'warn', 'bad');
      if (tone === 'ok') status.classList.add('ok');
      if (tone === 'warn') status.classList.add('warn');
      if (tone === 'bad') status.classList.add('bad');
    }
    if (hint) hint.textContent = text;
  }

  function setMediaRecoveryHint(message = '', visible = false) {
    const hint = qs('#callRecoveryHint');
    if (!hint) return;
    if (!visible || !message) {
      hint.textContent = '';
      hint.classList.add('hidden');
      return;
    }
    hint.textContent = message;
    hint.classList.remove('hidden');
  }

  function applyMediaPreviewVisibility(session) {
    const desk = qs('#callDesk');
    if (!desk) return;
    const voiceOnly = session?.channel === 'voice_call';
    desk.classList.toggle('voice-only', voiceOnly);
  }

  function applyDeskLayout() {
    const desk = qs('#callDesk');
    if (!desk) return;
    desk.classList.toggle('is-minimized', callState.ui.minimized);
    desk.classList.toggle('is-pinned', callState.ui.pinned);

    const minimizeBtn = qs('#toggleCallMinimizeBtn');
    if (minimizeBtn) {
      minimizeBtn.textContent = callState.ui.minimized ? 'Restore desk' : 'Minimize';
    }

    const pinBtn = qs('#toggleCallPinBtn');
    if (pinBtn) {
      pinBtn.textContent = callState.ui.pinned ? 'Unpin desk' : 'Pin desk';
    }
  }

  function updateControlState() {
    const joinBtn = qs('#joinCallBtn');
    const leaveBtn = qs('#leaveCallBtn');
    const muteBtn = qs('#toggleMuteBtn');
    const cameraBtn = qs('#toggleCameraBtn');
    const providerReadyBtn = qs('#providerReadyBtn');
    const retryBtn = qs('#retryMediaPermissionsBtn');
    const context = activeContext();
    const canJoin = isJoinableSession(context.session) && !callState.connected && !callState.joining;

    if (joinBtn) joinBtn.disabled = !canJoin;
    if (leaveBtn) leaveBtn.disabled = !callState.connected;
    if (muteBtn) {
      muteBtn.disabled = !callState.connected;
      muteBtn.textContent = callState.media.micMuted ? 'Unmute mic' : 'Mute mic';
    }

    const supportsVideo = context.session?.channel === 'video_call';
    if (cameraBtn) {
      cameraBtn.disabled = !callState.connected || !supportsVideo;
      cameraBtn.textContent = callState.media.cameraEnabled ? 'Camera off' : 'Camera on';
    }

    if (providerReadyBtn) {
      const canMarkProviderReady = ['clinician', 'coordinator', 'admin'].includes(state.user?.role);
      providerReadyBtn.classList.toggle('hidden', !canMarkProviderReady);
      providerReadyBtn.disabled = !isJoinableSession(context.session);
    }

    if (retryBtn) {
      const hasIssue = Boolean(callState.media.permissionIssue);
      retryBtn.classList.toggle('hidden', !hasIssue);
      retryBtn.disabled = !isJoinableSession(context.session) && !callState.connected;
    }

    applyDeskLayout();
  }

  function clearTurnRefreshTimer() {
    if (callState.transport.turnRefreshTimerId) {
      clearTimeout(callState.transport.turnRefreshTimerId);
      callState.transport.turnRefreshTimerId = null;
    }
  }

  function clearRelayMetaPulseTimer() {
    if (callState.transport.relayMetaPulseTimerId) {
      clearInterval(callState.transport.relayMetaPulseTimerId);
      callState.transport.relayMetaPulseTimerId = null;
    }
  }

  function syncRelayMetaPulseTimer() {
    const mode = String(callState.transport.turnCredentialMode || 'none');
    const shouldPulse = callState.connected && mode === 'ephemeral';
    if (!shouldPulse) {
      clearRelayMetaPulseTimer();
      return;
    }
    if (callState.transport.relayMetaPulseTimerId) return;

    callState.transport.relayMetaPulseTimerId = setInterval(() => {
      if (callState.transport.turnRefreshInFlight) {
        refreshRelayMetaFromState({ forceRefreshing: true });
        return;
      }
      refreshRelayMetaFromState();
    }, 1000);
  }

  function clearSignalingReconnectTimer() {
    if (callState.transport.signalingReconnectTimerId) {
      clearTimeout(callState.transport.signalingReconnectTimerId);
      callState.transport.signalingReconnectTimerId = null;
    }
  }

  function setRelayMeta(text, tone = 'neutral') {
    const relay = qs('#callRelayMeta');
    if (!relay) return;
    relay.textContent = text;
    relay.classList.remove('is-warn', 'is-bad');
    if (tone === 'warn') relay.classList.add('is-warn');
    if (tone === 'bad') relay.classList.add('is-bad');
  }

  function refreshRelayMetaFromState(options = {}) {
    if (options.forceRefreshing) {
      setRelayMeta('Relay credentials refreshing...', 'warn');
      return;
    }

    const mode = String(callState.transport.turnCredentialMode || 'none');
    const expiresAt = callState.transport.turnCredentialExpiresAt;
    if (mode === 'ephemeral') {
      const expiresAtMs = new Date(expiresAt || '').getTime();
      if (!Number.isFinite(expiresAtMs)) {
        setRelayMeta('Relay credentials: short-lived (refreshing automatically).');
        return;
      }
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs <= 0) {
        setRelayMeta('Relay credentials expired; rotating now.', 'warn');
        return;
      }
      const remainingSeconds = Math.max(0, Math.round(remainingMs / 1000));
      setRelayMeta(`Relay credentials rotate in ~${remainingSeconds}s.`);
      return;
    }

    if (mode === 'static') {
      setRelayMeta('Relay credentials are static (production: prefer short-lived mode).', 'warn');
      return;
    }

    setRelayMeta('Relay mode: STUN/default (no TURN credential metadata).');
  }

  function applyCallConfigTransport(callConfig, options = {}) {
    const config = callConfig && typeof callConfig === 'object' ? callConfig : {};
    callState.transport.turnCredentialMode = config.turnCredentialMode || null;
    callState.transport.turnCredentialExpiresAt = config.turnCredentialExpiresAt || null;

    if (options.updatePeerConnection && callState.pc && typeof callState.pc.setConfiguration === 'function') {
      const nextIceServers = Array.isArray(config.iceServers) ? config.iceServers : [];
      try {
        callState.pc.setConfiguration({ iceServers: nextIceServers });
      } catch {
        // Ignore ICE reconfiguration failures and keep the active transport alive.
      }
    }

    refreshRelayMetaFromState();
    syncRelayMetaPulseTimer();
    scheduleTurnCredentialRefresh();
  }

  function scheduleTurnCredentialRefresh() {
    clearTurnRefreshTimer();
    const mode = String(callState.transport.turnCredentialMode || 'none');
    if (mode !== 'ephemeral' || !callState.connected) return;

    const expiresAtMs = new Date(callState.transport.turnCredentialExpiresAt || '').getTime();
    if (!Number.isFinite(expiresAtMs)) return;

    const msUntilExpiry = expiresAtMs - Date.now();
    if (msUntilExpiry <= 0) {
      callState.transport.turnRefreshTimerId = setTimeout(() => {
        refreshTurnCredentials('expired').catch(() => null);
      }, TURN_REFRESH_MIN_WAIT_MS);
      return;
    }

    const refreshInMs = Math.max(TURN_REFRESH_MIN_WAIT_MS, msUntilExpiry - TURN_REFRESH_SAFETY_MS);
    callState.transport.turnRefreshTimerId = setTimeout(() => {
      refreshTurnCredentials('scheduled').catch(() => null);
    }, refreshInMs);
  }

  async function refreshTurnCredentials(trigger = 'scheduled') {
    if (!callState.connected || !callState.consultationId || !callState.sessionId) return;
    if (callState.transport.turnRefreshInFlight) return;

    callState.transport.turnRefreshInFlight = true;
    refreshRelayMetaFromState({ forceRefreshing: true });

    try {
      const callConfig = await api(`/api/v1/consultations/${callState.consultationId}/sessions/${callState.sessionId}/call-config`);
      if (!callState.connected) return;
      applyCallConfigTransport(callConfig, { updatePeerConnection: true });
    } catch (error) {
      setRelayMeta('Relay credential refresh failed. Signaling will retry.', 'warn');
      await tryMarkSession('reconnecting', {
        metadata: {
          trigger,
          message: String(error?.message || 'refresh_failed')
        }
      });
    } finally {
      callState.transport.turnRefreshInFlight = false;
      refreshRelayMetaFromState();
      scheduleTurnCredentialRefresh();
    }
  }

  function stopTrackSet(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore best-effort cleanup failures
      }
    }
  }

  function clearMediaElements() {
    const localVideo = qs('#callLocalVideo');
    const remoteVideo = qs('#callRemoteVideo');
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
  }

  async function tryMarkSession(marker, options = {}) {
    const consultationId = options.consultationId || callState.consultationId;
    const sessionId = options.sessionId || callState.sessionId;
    if (!sessionId || !consultationId) return;

    const nowMs = Date.now();
    const lastSentAt = callState.markerLastSentAt[marker] || 0;
    if (nowMs - lastSentAt < 1500) return;
    callState.markerLastSentAt[marker] = nowMs;

    try {
      await api(`/api/v1/consultations/${consultationId}/sessions/${sessionId}/interactions`, {
        method: 'POST',
        body: JSON.stringify({
          interactionType: 'session_marker',
          marker,
          metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {}
        })
      });
    } catch {
      // keep call workflow resilient even if marker logging fails
    }
  }

  async function postCallState(nextState, options = {}) {
    const consultationId = options.consultationId || callState.consultationId;
    const sessionId = options.sessionId || callState.sessionId;
    if (!consultationId || !sessionId) return null;
    if (!options.force && callState.serverCallState === nextState) return null;

    try {
      const result = await api(`/api/v1/consultations/${consultationId}/sessions/${sessionId}/call-state`, {
        method: 'POST',
        body: JSON.stringify({
          state: nextState,
          reason: options.reason || null,
          metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {}
        })
      });
      callState.serverCallState = result?.state || nextState;
      return result;
    } catch {
      return null;
    }
  }

  function sendSignal(type, payload = {}, targetUserId = null) {
    if (!callState.ws || callState.ws.readyState !== WebSocket.OPEN) return;
    callState.ws.send(JSON.stringify({
      type,
      targetUserId,
      payload
    }));
  }

  async function reconnectSignalingTransport(source = 'socket_close') {
    if (!callState.connected || !callState.consultationId || !callState.sessionId) return;

    try {
      const callConfig = await api(`/api/v1/consultations/${callState.consultationId}/sessions/${callState.sessionId}/call-config`);
      if (!callState.connected) return;

      applyCallConfigTransport(callConfig, { updatePeerConnection: true });

      if (callState.ws) {
        callState.transport.intentionalSocketClose = true;
        try {
          callState.ws.close();
        } catch {
          // best-effort close
        }
      }

      initializeWebSocket(callConfig.signalingUrl, {
        isReconnect: true,
        source,
        attempt: callState.transport.signalingReconnectAttempts
      });
    } catch {
      scheduleSignalingReconnect(source);
    }
  }

  function scheduleSignalingReconnect(source = 'socket_close') {
    if (!callState.connected) return;
    if (callState.transport.signalingReconnectTimerId) return;

    if (callState.transport.signalingReconnectAttempts >= SIGNALING_RECONNECT_MAX_ATTEMPTS) {
      setCallStatus('Signaling lost. Leave and rejoin call.', 'bad');
      tryMarkSession('failed', { metadata: { reason: 'signaling_reconnect_exhausted' } }).catch(() => null);
      return;
    }

    callState.transport.signalingReconnectAttempts += 1;
    const attempt = callState.transport.signalingReconnectAttempts;
    const delayMs = Math.min(12000, SIGNALING_RECONNECT_BASE_MS * Math.pow(2, attempt - 1));

    setCallStatus(`Signaling dropped. Reconnecting (${attempt}/${SIGNALING_RECONNECT_MAX_ATTEMPTS})...`, 'warn');
    callState.transport.signalingReconnectTimerId = setTimeout(() => {
      callState.transport.signalingReconnectTimerId = null;
      reconnectSignalingTransport(source).catch(() => scheduleSignalingReconnect(source));
    }, delayMs);
  }

  async function createOfferForPeer(peerUserId) {
    if (!callState.pc || !peerUserId) return;
    if (callState.pc.signalingState !== 'stable') return;

    const offer = await callState.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: callState.channel === 'video_call'
    });
    await callState.pc.setLocalDescription(offer);
    callState.activePeerUserId = peerUserId;
    sendSignal('offer', { description: callState.pc.localDescription }, peerUserId);
    setCallStatus('Calling peer...', 'warn');
    await postCallState('waiting_room', {
      reason: 'offer_sent',
      metadata: { targetUserId: peerUserId }
    });
    await tryMarkSession('ringing');
    await tryMarkSession('offer_sent', { metadata: { targetUserId: peerUserId } });
  }

  async function handleIncomingSignal(message) {
    if (!callState.pc) return;
    const signalType = String(message.signalType || '').toLowerCase();
    const fromUserId = message.from?.userId;
    if (!fromUserId || fromUserId === callState.selfUserId) return;

    if (signalType === 'offer') {
      const remoteDescription = normalizeSignalDescription(message.payload);
      const isCollision = callState.pc.signalingState !== 'stable';
      const polite = String(callState.selfUserId || '') > String(fromUserId || '');
      if (isCollision && !polite) {
        return;
      }
      if (isCollision && polite && callState.pc.signalingState === 'have-local-offer') {
        await callState.pc.setLocalDescription({ type: 'rollback' });
      }
      await callState.pc.setRemoteDescription(remoteDescription);
      const answer = await callState.pc.createAnswer();
      await callState.pc.setLocalDescription(answer);
      callState.activePeerUserId = fromUserId;
      sendSignal('answer', { description: callState.pc.localDescription }, fromUserId);
      setCallStatus('In call', 'ok');
      await postCallState('in_call', { reason: 'offer_answer_exchange' });
      await tryMarkSession('answer_sent', { metadata: { targetUserId: fromUserId } });
      return;
    }

    if (signalType === 'answer') {
      const remoteDescription = normalizeSignalDescription(message.payload);
      if (callState.pc.signalingState === 'have-local-offer') {
        await callState.pc.setRemoteDescription(remoteDescription);
        setCallStatus('In call', 'ok');
        await postCallState('in_call', { reason: 'answer_received' });
      }
      return;
    }

    if (signalType === 'ice_candidate') {
      const candidate = normalizeIceCandidate(message.payload);
      if (candidate?.candidate) {
        await callState.pc.addIceCandidate(candidate).catch(() => null);
      }
      return;
    }

    if (signalType === 'hangup') {
      setCallStatus('Peer ended the call.', 'warn');
      await leaveCall({ notify: false, sendHangup: false, marker: 'ended', reason: 'peer_hangup' });
      return;
    }

    if (signalType === 'media_state') {
      return;
    }
  }

  function attachPeerConnectionHandlers() {
    if (!callState.pc) return;

    callState.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendSignal('ice_candidate', { candidate: event.candidate }, callState.activePeerUserId);
    };

    callState.pc.ontrack = async (event) => {
      if (!callState.remoteStream) {
        callState.remoteStream = new MediaStream();
      }
      for (const track of event.streams[0]?.getTracks?.() || [event.track]) {
        if (!callState.remoteStream.getTracks().some((item) => item.id === track.id)) {
          callState.remoteStream.addTrack(track);
        }
      }
      const remoteVideo = qs('#callRemoteVideo');
      if (remoteVideo) {
        remoteVideo.srcObject = callState.remoteStream;
        remoteVideo.play().catch(() => null);
      }
      setCallStatus('In call', 'ok');
      await postCallState('in_call', { reason: 'remote_track_received' });
      await tryMarkSession('connected');
      await tryMarkSession('in_call');
    };

    callState.pc.onconnectionstatechange = async () => {
      const stateLabel = callState.pc?.connectionState;
      if (stateLabel === 'connected') {
        setCallStatus('In call', 'ok');
        await postCallState('in_call', { reason: 'peer_connection_connected' });
        await tryMarkSession('connected');
      } else if (stateLabel === 'disconnected') {
        setCallStatus('Connection unstable. Reconnecting...', 'warn');
        await postCallState('waiting_room', { reason: 'peer_connection_disconnected' });
        await tryMarkSession('reconnecting');
      } else if (stateLabel === 'failed') {
        setCallStatus('Call connection failed.', 'bad');
        await postCallState('failed', { reason: 'peer_connection_failed' });
        await tryMarkSession('failed');
      } else if (stateLabel === 'closed') {
        setCallStatus('Call ended.', 'neutral');
      }
    };
  }

  function attachWebSocketHandlers(socket, options = {}) {
    if (!socket) return;

    socket.addEventListener('open', async () => {
      if (socket !== callState.ws) return;

      clearSignalingReconnectTimer();
      const didReconnect = callState.transport.signalingReconnectAttempts > 0 || options.isReconnect;
      callState.transport.signalingReconnectAttempts = 0;
      callState.transport.intentionalSocketClose = false;

      if (didReconnect) {
        await tryMarkSession('connected', {
          metadata: {
            source: options.source || 'unknown',
            attempt: Number(options.attempt || 0)
          }
        });
      }

      sendSignal('ping', {});

      const connectionState = String(callState.pc?.connectionState || '').toLowerCase();
      if (connectionState === 'connected' || callState.serverCallState === 'in_call') {
        setCallStatus('In call', 'ok');
        return;
      }

      setCallStatus('Connected to signaling. Waiting for peer...', 'warn');
      await postCallState('waiting_room', { reason: 'signaling_connected' });
      await tryMarkSession('waiting_room');
    });

    socket.addEventListener('message', async (event) => {
      if (socket !== callState.ws) return;
      try {
        const message = JSON.parse(String(event.data || '{}'));
        const type = String(message.type || '');
        if (type === 'room_state') {
          const peers = Array.isArray(message.peers) ? message.peers : [];
          const candidate = peers.find((item) => item.userId && item.userId !== callState.selfUserId);
          if (candidate) {
            await createOfferForPeer(candidate.userId);
          } else {
            await postCallState('waiting_room', { reason: 'awaiting_peer' });
            setCallStatus('Waiting room active. Awaiting participant.', 'warn');
          }
          return;
        }

        if (type === 'peer_joined') {
          const peer = message.peer;
          if (peer?.userId && peer.userId !== callState.selfUserId) {
            await tryMarkSession('participant_joined', { metadata: { peerUserId: peer.userId } });
            await createOfferForPeer(peer.userId);
          }
          return;
        }

        if (type === 'peer_left') {
          if (message.peer?.userId && message.peer.userId === callState.activePeerUserId) {
            callState.activePeerUserId = null;
            setCallStatus('Peer left. Waiting for reconnection...', 'warn');
            await postCallState('waiting_room', {
              reason: 'peer_left',
              metadata: { peerUserId: message.peer.userId }
            });
            await tryMarkSession('participant_left', { metadata: { peerUserId: message.peer.userId } });
          }
          return;
        }

        if (type === 'signal_error') {
          const messageText = String(message.error || 'Signaling error received.');
          setCallStatus(messageText, 'bad');
          return;
        }

        if (type === 'signal') {
          await handleIncomingSignal(message);
        }
      } catch {
        // Ignore malformed socket payloads to keep the call running.
      }
    });

    socket.addEventListener('close', async () => {
      if (socket !== callState.ws) return;
      if (!callState.connected) return;

      if (callState.transport.intentionalSocketClose) {
        callState.transport.intentionalSocketClose = false;
        return;
      }

      setCallStatus('Signaling disconnected.', 'warn');
      await postCallState('waiting_room', { reason: 'signaling_disconnected' });
      await tryMarkSession('reconnecting');
      scheduleSignalingReconnect('socket_close');
    });
  }

  function initializeWebSocket(signalingUrl, options = {}) {
    const socket = new WebSocket(signalingUrl);
    callState.ws = socket;
    attachWebSocketHandlers(socket, options);
  }

  async function replaceMediaStream(mediaConstraints) {
    const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);

    if (callState.pc) {
      for (const track of stream.getTracks()) {
        const sender = callState.pc.getSenders().find((item) => item.track && item.track.kind === track.kind);
        if (sender) {
          await sender.replaceTrack(track);
        } else {
          callState.pc.addTrack(track, stream);
        }
      }
    }

    stopTrackSet(callState.localStream);
    callState.localStream = stream;

    const localVideo = qs('#callLocalVideo');
    if (localVideo) {
      localVideo.srcObject = stream;
      localVideo.muted = true;
      localVideo.play().catch(() => null);
    }

    const hasAudioTrack = stream.getAudioTracks().length > 0;
    const hasVideoTrack = stream.getVideoTracks().length > 0;
    callState.media.micMuted = hasAudioTrack ? false : callState.media.micMuted;
    callState.media.cameraEnabled = hasVideoTrack ? true : callState.media.cameraEnabled;
  }

  async function joinCall() {
    if (!supportsWebRtc()) {
      notice('This browser does not support WebRTC call transport.', true);
      return;
    }

    const { consultationId, sessionId, session } = activeContext();
    if (!consultationId || !sessionId || !session) {
      notice('Select a consultation and session first.', true);
      return;
    }
    if (!isJoinableSession(session)) {
      notice('Call transport requires an active voice_call or video_call session.', true);
      return;
    }
    if (callState.connected || callState.joining) return;

    callState.joining = true;
    updateControlState();

    try {
      const callConfig = await api(`/api/v1/consultations/${consultationId}/sessions/${sessionId}/call-config`);
      const mediaConstraints = callConfig.mediaConstraints || {
        audio: true,
        video: session.channel === 'video_call'
      };
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);

      callState.pc = new RTCPeerConnection({ iceServers: callConfig.iceServers || [] });
      callState.localStream = stream;
      callState.remoteStream = new MediaStream();
      callState.consultationId = consultationId;
      callState.sessionId = sessionId;
      callState.channel = session.channel;
      callState.selfUserId = callConfig.selfUserId || state.user?.id || null;
      callState.activePeerUserId = null;
      callState.connected = true;
      callState.serverCallState = String(callConfig.callState || session.callState || 'idle');
      callState.markerLastSentAt = {};
      callState.media.permissionIssue = null;
      callState.transport.signalingReconnectAttempts = 0;
      setMediaRecoveryHint('', false);

      applyCallConfigTransport(callConfig, { updatePeerConnection: false });

      const localVideo = qs('#callLocalVideo');
      if (localVideo) {
        localVideo.srcObject = stream;
        localVideo.muted = true;
        localVideo.play().catch(() => null);
      }

      for (const track of stream.getTracks()) {
        callState.pc.addTrack(track, stream);
      }

      attachPeerConnectionHandlers();
      initializeWebSocket(callConfig.signalingUrl, { isReconnect: false, source: 'join' });
      setCallStatus('Starting media transport...', 'warn');
      updateControlState();
    } catch (error) {
      const mediaError = classifyMediaError(error);
      callState.media.permissionIssue = mediaError.recoverable ? mediaError.message : null;
      setMediaRecoveryHint(mediaError.message, mediaError.recoverable);
      if (mediaError.recoverable) {
        await tryMarkSession('permission_required', {
          consultationId,
          sessionId,
          metadata: { reason: mediaError.message }
        });
      }
      await leaveCall({ notify: false, sendHangup: false, marker: null, reason: 'join_failed' });
      notice(mediaError.message, true);
    } finally {
      callState.joining = false;
      updateControlState();
    }
  }

  async function recoverMediaPermissions() {
    if (!supportsWebRtc()) {
      notice('WebRTC media recovery is not available in this browser.', true);
      return;
    }

    const { consultationId, sessionId, session } = activeContext();
    if (!consultationId || !sessionId || !session || !isCallChannel(session)) {
      notice('Select an active call session first.', true);
      return;
    }

    const mediaConstraints = {
      audio: true,
      video: session.channel === 'video_call'
    };

    try {
      if (callState.connected) {
        await replaceMediaStream(mediaConstraints);
      } else {
        await joinCall();
      }
      callState.media.permissionIssue = null;
      setMediaRecoveryHint('', false);
      await postCallState('waiting_room', { reason: 'media_permission_recovered' });
      await tryMarkSession('permission_recovered', {
        consultationId,
        sessionId
      });
      sendSignal('media_state', {
        audioMuted: callState.media.micMuted,
        cameraEnabled: callState.media.cameraEnabled,
        permissionRecovered: true
      }, callState.activePeerUserId);
      updateControlState();
      notice('Media permissions recovered.');
    } catch (error) {
      const mediaError = classifyMediaError(error);
      callState.media.permissionIssue = mediaError.message;
      setMediaRecoveryHint(mediaError.message, true);
      notice(mediaError.message, true);
    }
  }

  async function leaveCall(options = {}) {
    const {
      notify = true,
      sendHangup = true,
      marker = 'ended',
      reason = 'user_left'
    } = options;
    if (!callState.connected && !callState.pc && !callState.ws) return;

    clearTurnRefreshTimer();
    clearRelayMetaPulseTimer();
    clearSignalingReconnectTimer();

    const markerContext = {
      consultationId: callState.consultationId,
      sessionId: callState.sessionId
    };

    if (sendHangup && callState.activePeerUserId) {
      sendSignal('hangup', { reason }, callState.activePeerUserId);
    }

    if (callState.ws) {
      callState.transport.intentionalSocketClose = true;
      try {
        callState.ws.close();
      } catch {
        // ignore close errors
      }
    }
    if (callState.pc) {
      try {
        callState.pc.close();
      } catch {
        // ignore close errors
      }
    }

    stopTrackSet(callState.localStream);
    stopTrackSet(callState.remoteStream);

    if (marker) {
      await tryMarkSession(marker, markerContext);
      await postCallState('ended', {
        consultationId: markerContext.consultationId,
        sessionId: markerContext.sessionId,
        reason
      });
    }

    callState.consultationId = null;
    callState.sessionId = null;
    callState.channel = null;
    callState.selfUserId = null;
    callState.activePeerUserId = null;
    callState.pc = null;
    callState.ws = null;
    callState.localStream = null;
    callState.remoteStream = null;
    callState.connected = false;
    callState.joining = false;
    callState.media = {
      micMuted: false,
      cameraEnabled: true,
      permissionIssue: callState.media.permissionIssue
    };
    callState.transport = {
      turnCredentialMode: null,
      turnCredentialExpiresAt: null,
      turnRefreshTimerId: null,
      relayMetaPulseTimerId: null,
      turnRefreshInFlight: false,
      signalingReconnectTimerId: null,
      signalingReconnectAttempts: 0,
      intentionalSocketClose: false
    };
    callState.serverCallState = marker === 'failed' ? 'failed' : 'ended';

    clearMediaElements();
    setCallStatus('Call idle. Join when both participants are ready.');
    setRelayMeta('Relay mode: awaiting call config.');
    updateControlState();

    if (notify) {
      notice('Call ended.');
    }
  }

  function toggleMute() {
    if (!callState.localStream || !callState.connected) return;
    const audioTracks = callState.localStream.getAudioTracks();
    if (!audioTracks.length) return;
    callState.media.micMuted = !callState.media.micMuted;
    for (const track of audioTracks) {
      track.enabled = !callState.media.micMuted;
    }
    sendSignal('media_state', {
      audioMuted: callState.media.micMuted,
      cameraEnabled: callState.media.cameraEnabled
    }, callState.activePeerUserId);
    updateControlState();
  }

  function toggleCamera() {
    if (!callState.localStream || !callState.connected) return;
    const videoTracks = callState.localStream.getVideoTracks();
    if (!videoTracks.length) return;
    callState.media.cameraEnabled = !callState.media.cameraEnabled;
    for (const track of videoTracks) {
      track.enabled = callState.media.cameraEnabled;
    }
    sendSignal('media_state', {
      audioMuted: callState.media.micMuted,
      cameraEnabled: callState.media.cameraEnabled
    }, callState.activePeerUserId);
    updateControlState();
  }

  function callStateHint(session) {
    const source = String(session?.callState || callState.serverCallState || 'idle');
    if (source === 'waiting_room') return { text: 'Waiting room active. Join when ready.', tone: 'warn' };
    if (source === 'provider_ready') return { text: 'Provider ready. Patient can now join the call.', tone: 'warn' };
    if (source === 'in_call') return { text: 'Call is active. Join to reconnect media transport.', tone: 'ok' };
    if (source === 'failed') return { text: 'Previous call attempt failed. Retry join.', tone: 'bad' };
    if (source === 'ended') return { text: 'Call ended. Join when both participants are ready.', tone: 'neutral' };
    return { text: 'Call idle. Join when both participants are ready.', tone: 'neutral' };
  }

  async function toggleProviderReady() {
    const { consultationId, sessionId, session } = activeContext();
    if (!consultationId || !sessionId || !session || !isJoinableSession(session)) {
      notice('Select an active call session before marking provider ready.', true);
      return;
    }

    await postCallState('provider_ready', {
      consultationId,
      sessionId,
      reason: 'provider_ready_button'
    });
    await tryMarkSession('provider_ready', { consultationId, sessionId });
    callState.serverCallState = 'provider_ready';
    setCallStatus('Provider ready. Patient can now join the call.', 'warn');
    notice('Provider-ready state published.');
    updateControlState();
  }

  async function toggleMinimize() {
    callState.ui.minimized = !callState.ui.minimized;
    applyDeskLayout();
    if (callState.ui.minimized) {
      await tryMarkSession('minimized');
    }
  }

  async function togglePin() {
    callState.ui.pinned = !callState.ui.pinned;
    applyDeskLayout();
    await tryMarkSession(callState.ui.pinned ? 'pinned' : 'unpinned');
  }

  async function syncCallDesk() {
    const desk = qs('#callDesk');
    if (!desk) return;

    const { consultationId, sessionId, session } = activeContext();
    const callSessionSelected = isCallChannel(session);
    desk.classList.toggle('hidden', !callSessionSelected);

    if (!callSessionSelected) {
      if (callState.connected) {
        await leaveCall({ notify: false, sendHangup: true, marker: 'ended', reason: 'context_switched' });
      }
      setRelayMeta('Relay mode: select an active call session.');
      return;
    }

    applyMediaPreviewVisibility(session);

    const contextChanged =
      callState.connected &&
      (consultationId !== callState.consultationId || sessionId !== callState.sessionId);
    if (contextChanged) {
      await leaveCall({ notify: false, sendHangup: true, marker: 'ended', reason: 'context_switched' });
    }

    callState.serverCallState = String(session.callState || callState.serverCallState || 'idle');

    if (!supportsWebRtc()) {
      setCallStatus('WebRTC is unavailable in this browser.', 'bad');
      setRelayMeta('Relay mode unavailable: browser lacks WebRTC support.', 'bad');
    } else if (!isJoinableSession(session)) {
      setCallStatus('Session must be active to start call transport.', 'warn');
      setRelayMeta('Relay mode: activate session before joining call.', 'warn');
    } else if (!callState.connected) {
      const hint = callStateHint(session);
      setCallStatus(hint.text, hint.tone);
      refreshRelayMetaFromState();
    }

    if (!callState.media.permissionIssue) {
      setMediaRecoveryHint('', false);
    } else {
      setMediaRecoveryHint(callState.media.permissionIssue, true);
    }

    updateControlState();
  }

  function bind() {
    const joinBtn = qs('#joinCallBtn');
    const leaveBtn = qs('#leaveCallBtn');
    const muteBtn = qs('#toggleMuteBtn');
    const cameraBtn = qs('#toggleCameraBtn');
    const providerReadyBtn = qs('#providerReadyBtn');
    const retryBtn = qs('#retryMediaPermissionsBtn');
    const minimizeBtn = qs('#toggleCallMinimizeBtn');
    const pinBtn = qs('#toggleCallPinBtn');

    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        joinCall().catch((error) => notice(error.message || 'Failed to join call.', true));
      });
    }

    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => {
        leaveCall({ notify: true, sendHangup: true, marker: 'ended', reason: 'user_left' }).catch((error) => {
          notice(error.message || 'Failed to leave call.', true);
        });
      });
    }

    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        toggleMute();
      });
    }

    if (cameraBtn) {
      cameraBtn.addEventListener('click', () => {
        toggleCamera();
      });
    }

    if (providerReadyBtn) {
      providerReadyBtn.addEventListener('click', () => {
        toggleProviderReady().catch((error) => notice(error.message || 'Failed to mark provider ready.', true));
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        recoverMediaPermissions().catch((error) => notice(error.message || 'Media recovery failed.', true));
      });
    }

    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => {
        toggleMinimize().catch(() => null);
      });
    }

    if (pinBtn) {
      pinBtn.addEventListener('click', () => {
        togglePin().catch(() => null);
      });
    }

    setRelayMeta('Relay mode: awaiting call config.');
    syncCallDesk().catch(() => null);
  }

  return {
    bind,
    syncCallDesk,
    leaveCall,
    recoverMediaPermissions
  };
}
