# Mindset Healthcare

CPanel-compatible V1 platform for managing healthcare leads, patient referrals, provider matching, documents, notifications, and operational reporting.

## Direction

The project starts as a Laravel V1 on shared CPanel hosting because that is the fastest reliable path to business validation. The system is designed around the referral lifecycle as the core unit of work, with a stable API contract and database model that can later support a Django V2 backend without rewriting the frontend.

## V1 Scope

- Patient lead capture and referral submission
- Self and family-care intake with country and consent capture
- Coordinator dashboard for lead qualification and referral management
- Provider catalogue with specialties, procedures, availability, and manual matching
- Referral state machine with append-only status history
- Private document content storage and authenticated downloads
- Email/SMS notification logging
- Operational dashboards with channel conversion, provider training, and referral turnaround metrics

Deferred from V1: diaspora self-service portal, clinician self-registration, provider staff self-onboarding, automated matching, real-time WhatsApp/Telegram messaging, advanced analytics, and integrated payments.

## Documents

- [Architecture decision](docs/adr/0001-cpanel-laravel-v1.md)
- [V1 roadmap](docs/v1-roadmap.md)
- [Domain model](docs/domain-model.md)
- [Referral state machine](docs/referral-state-machine.md)
- [API contract](docs/api-contract.md)
- [Database schema](docs/schema.sql)

## Run The MVP

```bash
npm start
```

Open `http://localhost:3000`.

Demo accounts:

- `admin@mindset.local` / `password`
- `coordinator@mindset.local` / `password`
- `patient@mindset.local` / `password`
- `clinician@mindset.local` / `password`

The current implementation is lightweight Node.js (minimal runtime dependencies) with JSON persistence in `data/mindset.json`, so it can run in shared-hosting environments that support Node. The design still preserves the Laravel/CPanel V1 direction in the documentation.

Authentication uses per-password random salts and PBKDF2-SHA256 (120,000 iterations); login attempts are rate-limited. Social login is not configured because no identity provider or callback credentials are part of this deployment.

API errors return `{ "error", "code", "requestId" }`; rate-limited responses may also include `Retry-After`. The frontend displays validation and connectivity feedback and carries request IDs on `ApiError` for support diagnostics. See [the API error contract](docs/api-contract.md#error-responses).

The current persistence layer is a serialized JSON-file store intended for a lightweight single-node MVP. Database index tuning and Redis caching should follow a planned migration to a queryable datastore and measured workload; the frontend already uses short-lived workspace caching and request coalescing for repeated reads. The UI is responsive without a framework dependency, and uses native ARIA/live-region and reduced-motion support. Full localization should follow selection and review of supported languages, especially for clinical, urgency, and consent wording.

## Production MVP Notes

Set these environment variables on the host:

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_FILE=/home/username/mindset-data/mindset.json
DOCUMENT_DIR=/home/username/mindset-data/documents
CORS_ORIGINS=https://your-domain.example
SESSION_TTL_HOURS=168
MAX_BODY_BYTES=1048576
WRITE_RATE_WINDOW_MS=60000
WRITE_RATE_MAX_REQUESTS=30
MAX_IN_PROGRESS_MINUTES=120
CLAIM_CONFLICT_THRESHOLD=5
TERMINAL_HOLD_RECONCILIATION_GRACE_MINUTES=30
CLAIM_SWEEP_INTERVAL_MS=30000
ENABLE_CLAIM_SWEEP_JOB=true
PUBLIC_BASE_URL=https://your-domain.example
CALL_SIGNAL_TOKEN_TTL_SECONDS=180
CALL_SIGNAL_PEER_RATE_WINDOW_MS=10000
CALL_SIGNAL_PEER_RATE_MAX=160
CALL_SIGNAL_ROOM_RATE_WINDOW_MS=10000
CALL_SIGNAL_ROOM_RATE_MAX=320
CALL_STUN_URLS=stun:stun.l.google.com:19302
CALL_TURN_URLS=turns:turn.example.com:5349?transport=tcp
CALL_TURN_SHARED_SECRET=turn-shared-secret
CALL_TURN_CREDENTIAL_TTL_SECONDS=300
CALL_TURN_USERNAME=turn-username
CALL_TURN_CREDENTIAL=turn-password
```

TURN credentials behavior:

- If `CALL_TURN_SHARED_SECRET` is set, the API returns short-lived TURN credentials per call config request (`turnCredentialMode: "ephemeral"`).
- If no shared secret is set, the API falls back to static TURN credentials (`CALL_TURN_USERNAME`/`CALL_TURN_CREDENTIAL`) when provided.
- If TURN variables are omitted entirely, only STUN servers are returned.

Call signaling and TURN variable usage details:

- `CALL_SIGNAL_TOKEN_TTL_SECONDS`: Lifespan of the signaling token returned by call-config. Keep short to reduce replay risk if leaked. Typical production range: `60-300` seconds.
- `CALL_SIGNAL_PEER_RATE_WINDOW_MS` + `CALL_SIGNAL_PEER_RATE_MAX`: Per-client message throttling for WebSocket signaling. Example with `10000` + `160` allows up to 160 signaling messages per peer every 10 seconds.
- `CALL_SIGNAL_ROOM_RATE_WINDOW_MS` + `CALL_SIGNAL_ROOM_RATE_MAX`: Aggregate room-level throttling. Example with `10000` + `320` allows 320 signaling messages across all peers in the room every 10 seconds.
- `CALL_STUN_URLS`: Comma-separated STUN URLs used for basic ICE discovery. Keep at least one reliable public STUN server; add regional redundancy when possible.
- `CALL_TURN_URLS`: Comma-separated TURN endpoints. Use `turns:` in production so relay transport is TLS-protected.
- `CALL_TURN_SHARED_SECRET`: Enables ephemeral TURN credentials generated server-side (recommended for production).
- `CALL_TURN_CREDENTIAL_TTL_SECONDS`: Expiry for ephemeral TURN credentials when shared-secret mode is active. Typical range: `120-600` seconds.
- `CALL_TURN_USERNAME` + `CALL_TURN_CREDENTIAL`: Static TURN fallback credentials used only when shared secret is not configured.

Recommended deployment modes:

- STUN-only (low reliability, lowest complexity): Set `CALL_STUN_URLS` and omit all TURN variables. Suitable only for demos or trusted networks.
- TURN static credentials (baseline production fallback): Set `CALL_STUN_URLS`, `CALL_TURN_URLS`, `CALL_TURN_USERNAME`, and `CALL_TURN_CREDENTIAL`.
- TURN ephemeral credentials (preferred production): Set `CALL_STUN_URLS`, `CALL_TURN_URLS`, `CALL_TURN_SHARED_SECRET`, and `CALL_TURN_CREDENTIAL_TTL_SECONDS`.

Operational tuning notes:

- If users see frequent signaling disconnects or `rate_limited` markers, increase peer/room limits gradually (10-20 percent at a time) and re-test.
- If you suspect token leakage risk, reduce `CALL_SIGNAL_TOKEN_TTL_SECONDS` before increasing rate limits.
- Keep TURN credential TTL longer than normal call setup time but shorter than expected abuse windows.
- Rotate `CALL_TURN_SHARED_SECRET` and static TURN credentials regularly; treat them like production secrets.

Useful commands:

```bash
npm test
npm run backup
npm run migrate:data
npm run reset:data
```

Operational endpoints:

- `GET /api/v1/health`
- `GET /api/v1/readiness`
- `GET /api/v1/operations/consultation-sla` (includes `alerts`, `alertDetails`, `highestSeverity`, `medianClaimTimeSeconds`, `p90ClaimTimeSeconds`, `holdReleaseRatePercent`, `riskDistribution`, and `criticalRiskPercent`)
- `POST /api/v1/operations/jobs/release-unclaimed-consultations`
- `GET /api/v1/admin/export` with an admin token

Operational alert payloads include actionable `remediation` hints per alert code so coordinators can resolve stuck workflow/payment inconsistencies quickly.

Section 3 capabilities now exposed as API workflows:

- Tiered consultation requests (`normal`, `priority`, `super_priority`) with payment hold creation
- Patient-requested communication preference captured at intake (`voice_text`, `voice_call`, `video_call`)
- Atomic doctor claim endpoint with 2-minute claim window and conflict handling
- Consultation lifecycle transitions (`REQUESTED` → `DOCTOR_ACCEPTED` → `IN_PROGRESS` → `COMPLETED`)
- Three-layer communication orchestration after claim, with patient-preferred layer first
- Clinician channel handoff support (close active session and open another requested layer)
- Mid-consultation tier escalation to a higher tier only
- Hold capture on completion and hold release on cancellation/timeout
- Explicit reason required for cancellation and active-session close actions
- Account notification inbox endpoints for in-app operations: `GET /api/v1/account/notifications` and `POST /api/v1/account/notifications/read`
- Notification inbox supports triage filters via query params: `channel`, `type`, `severity`, `unreadOnly`, and `limit`
- Notification inbox payload now includes filtered unread telemetry (`meta.visibleUnreadCount`) for targeted bulk actions
- Notification read endpoint now supports filter-scoped bulk updates with `{ "markFiltered": true, "filters": { "channel": "all", "type": "communication", "severity": "warning", "unreadOnly": true } }`
- Lightweight unread summary endpoint for global badges/polling: `GET /api/v1/account/notifications/summary`
- Biometric verification hooks for doctor/patient verification records (hook mode)
- Consultation SLA snapshot and claim-window sweep operation endpoints
- Clinician claim eligibility rules using specialty/procedure availability filters
- Consultation timeline API with query filtering: `GET /api/v1/consultations/{consultationId}/events?kind=interaction&limit=50`
- Consultation timeline export endpoint: `GET /api/v1/consultations/{consultationId}/events/export?format=csv&kind=interaction&limit=200`
- Consultation queue API with sorting: `GET /api/v1/consultations?sort=urgency` (supported: `recent`, `urgency`, `claim_expiry`, `waiting_time`, `risk_score`)

Implementation-level communication use cases (patient ↔ clinician):

1. Voice-text use case (`voice_text`)

- Create + claim + start consultation.
- Open voice-text session: `POST /api/v1/consultations/{consultationId}/sessions` with `{ "channel": "voice_text" }`
- Patient sends text interaction: `POST /api/v1/consultations/{consultationId}/sessions/{sessionId}/interactions` with `{ "interactionType": "patient_message", "message": "..." }`
- Clinician replies: same endpoint with `{ "interactionType": "clinician_message", "message": "..." }`
- Fetch transcript: `GET /api/v1/consultations/{consultationId}/sessions/{sessionId}/interactions`

1. Voice-call use case (`voice_call`)

- Open voice-call session: `POST /api/v1/consultations/{consultationId}/sessions` with `{ "channel": "voice_call" }`
- Request call transport config: `GET /api/v1/consultations/{consultationId}/sessions/{sessionId}/call-config`
- Call config now includes TURN credential metadata when applicable: `turnCredentialMode` (`ephemeral` or `static`) and `turnCredentialExpiresAt`.
- The Communication Desk now refreshes short-lived TURN credentials before expiry and applies refreshed ICE server config during active calls.
- Join realtime signaling using the returned `signalingUrl` (session-scoped WebSocket room)
- Update explicit call state: `POST /api/v1/consultations/{consultationId}/sessions/{sessionId}/call-state` with `{ "state": "waiting_room" | "provider_ready" | "in_call" | "ended" | "failed", "reason": "..." }`
- Read call state timeline: `GET /api/v1/consultations/{consultationId}/sessions/{sessionId}/call-state`
- Record call lifecycle markers: `POST /api/v1/consultations/{consultationId}/sessions/{sessionId}/interactions` with `{ "interactionType": "session_marker", "marker": "connected" }` (also supports `in_call`, `waiting_room`, `provider_ready`, `participant_joined`, `participant_left`, `offer_sent`, `answer_sent`, `authorization_blocked`, `rate_limited`, `permission_required`, `permission_recovered`, `ended`, `failed`, `reconnecting`, `switched`)
- Record clinician note during/after call: same endpoint with `{ "interactionType": "clinical_note", "message": "..." }`

1. Video-call use case (`video_call`)

- Open video session: `POST /api/v1/consultations/{consultationId}/sessions` with `{ "channel": "video_call" }`
- Request call transport config: `GET /api/v1/consultations/{consultationId}/sessions/{sessionId}/call-config`
- Record video session markers via `session_marker` interactions.
- Record clinical summary as `clinical_note`.

Notes:

- Channel enforcement is strict: `patient_message`/`clinician_message` are for `voice_text`; `session_marker` is for `voice_call`/`video_call`.
- After a session is closed, only `clinical_note` interactions are accepted.
- Waiting-room and provider-ready transitions emit multi-channel alerts (`in_app`, `sms`, `email`) to patient, clinician, and coordinator audiences.
- Dashboard support: the Consultations view now includes a Communication Desk panel to select a consultation/session, record interactions, and view transcript history in-app.
- The Communication Desk auto-refreshes transcript data every 5 seconds while the Consultations view is active.
- Communication Desk transcript queries now support filtering by interaction type and actor role plus row limits via `GET /api/v1/consultations/{consultationId}/sessions/{sessionId}/interactions?type=clinician_message&actorRole=clinician&limit=50`.
- Communication Desk transcript exports are now available via `GET /api/v1/consultations/{consultationId}/sessions/{sessionId}/interactions/export?format=csv&type=clinical_note&actorRole=clinician&limit=200`.
- Communication Desk now preserves per-session draft text locally while operators switch sessions and provides explicit draft clear control.
- Communication Desk now includes one-tap quick session markers (`connected`, `reconnecting`, `ended`) and a `New updates` indicator for rapid live-ops awareness.
- Interaction intake is resilient to human-readable labels and missing `interactionType` values; the service normalizes aliases (for example `Session Marker`, `patient`) and infers safe defaults from channel + payload when omitted.
- Communication Desk now supports role-aware workflow presets (for example live triage, patient updates, call markers) and persists chosen presets per signed-in role.
- Transcript export format is selectable in UI (CSV or JSON), while keeping server-side filtering and authorization.
- Keyboard-first entry is enabled for messages/notes using Ctrl+Enter (Cmd+Enter on macOS) to submit interactions quickly.
- Frontend communication and consultation workspace code is now modularized from app.js into focused modules: public/js/ui-helpers.js, public/js/interaction-helpers.js, public/js/consultation-actions.js, public/js/interaction-bindings.js, and public/js/consultation-workspace.js for maintainability and safer iteration.
- App-level DOM/window listener orchestration is now extracted into `public/js/app-event-bindings.js` so `public/app.js` stays focused on composition rather than event plumbing.
- Frontend high-frequency workspace loaders now use a single-flight coalescing helper (`public/js/single-flight.js`) so concurrent `loadConsultations` and `loadAccount` calls reuse one in-flight request per key.
- Authentication/session responsibilities are now extracted into `public/js/auth-session.js` (session render, login state persistence, and logout cleanup), further reducing orchestration coupling inside `public/app.js`.
- Intake section static form/queue markup is now rendered eagerly from `public/js/intake-content.js` into `#intakeContentMount`, shrinking `public/index.html` while preserving immediate workflow access.
- Campaign deferred content now uses intersection-triggered rendering (`public/js/campaign-content.js`) so below-the-fold marketing blocks mount only when the Campaigns view is actually visible.
- Campaign deferred content now shows skeleton placeholders before hydration to improve perceived smoothness on low-end mobile devices.
- Consultation queue and event-log control listeners are now isolated in `public/js/consultation-workspace-bindings.js` to keep `public/app.js` focused on orchestration.
- Communication form submit now validates message-required interaction payloads client-side before API calls to reduce avoidable 422 failures.
- Communication Desk now shows inline submission hints and disables submit when required payload fields are missing for the resolved interaction type.
- Consultation SLA snapshot now includes communication throughput metrics (`interactionsLast24h`, `interactionBreakdownLast24h`, `activeSessions`, `interactionsPerActiveSessionLast24h`) for operations triage and staffing visibility.
- Consultation SLA snapshot now includes call-state pressure/readiness metrics (`totalCallSessions`, `activeCallSessions`, `activeCallStateCounts`, `waitingRoomPressureScore`, `waitingRoomPressureLevel`, `callReadinessPercent`, and oldest waiting/provider-ready ages).
- Consultation rows now include `callStateSummary` with waiting-room, provider-ready, in-call, and latest-state details for queue triage visibility.
- Consultation cards now include event log controls with kind filtering and server-backed CSV export for operations evidence capture.
- Consultation queue controls now include server-backed sort modes (Newest, Highest urgency, Claim expiry soonest, Longest waiting) with frontend persistence.
- Consultation queue now supports server-backed filtering by `status`, `tier`, and `search` using `GET /api/v1/consultations?sort=recent&status=IN_PROGRESS&tier=priority&search=neurology`; the same filters also apply to `GET /api/v1/consultations/workspace`.
- Consultations queue UI now includes filter chips (status/tier), text search (press Enter), clear-filters action, and an active filter summary for faster live operations navigation.
- Consultations queue now supports saved workflow presets in UI (`All queue`, `Needs claim`, `Live triage`, `Critical follow-up`) with persistence and auto-detection back to `Custom view` when filters diverge.
- Consultations queue now also exposes one-tap quick preset chips for faster triage switching without opening dropdown controls.
- Consultation queue search now supports live debounced apply for 3+ characters plus an explicit `Apply search` action for deliberate operator control.
- Consultation workspace now supports a consolidated payload endpoint `GET /api/v1/consultations/workspace?sort=risk_score` returning `{ consultations, snapshot, generatedAt }` so queue + ops metrics refresh in one request.
- Consultation workspace payload now includes `appliedFilters` metadata so frontend state aligns with backend-normalized `sort`, `status`, `tier`, and `search` values.
- Consultation workspace payload now includes `meta.visibleCount` and `meta.totalCount` so UI can display filtered queue coverage at a glance.
- In-progress consultations now feature complete active communication layer lifecycle management: `startConsultation` automatically provisions an active communication session on the requested mode; atomic `POST /api/v1/consultations/{id}/sessions/switch` handles layer switching; `POST /api/v1/consultations/{id}/sessions/ensure-active` guarantees session availability; and data migration auto-recovers active layers for legacy in-progress rows.
- Communication Desk now supports browser-native WebRTC call transport for active `voice_call` and `video_call` sessions, with signaling bootstrapped by `GET /api/v1/consultations/{id}/sessions/{sessionId}/call-config` and a session-scoped WebSocket route under `/api/v1/realtime/consultations/{id}/sessions/{sessionId}`.
- Communication Desk now retries signaling reconnect with capped exponential backoff after unexpected socket disconnects, while keeping operators informed via explicit relay/transport status text.
- Consultation cards now surface claimed clinician profile details (name, contact, facility, specialties) so patients can see who accepted their consultation.
- Assigned clinicians can now retrieve patient records through `GET /api/v1/consultations/{consultationId}/patient-medical-records?limit=50`, which includes structured records, linked referral documents, and OpenEMR-compatible source metadata for future integration.
- Account view now includes an in-app Notification Center with channel/unread filtering, unread counters, one-tap mark-read actions, and consultation deep-link shortcuts.
- Notification Center now includes type/severity filters and badges (`communication`, `consultation`, `referral`, `account`, `system` with `info`, `warning`, `critical`) for faster operations triage.
- Notification Center now includes quick preset chips (`Critical unread`, `Communication unread`, `All unread`, `Reset`) and a `Mark filtered read` action for high-speed inbox triage.
- Notification Center bulk read actions now require explicit confirmation and include scope-aware prompts to reduce accidental queue clears.
- Global account unread badge now auto-refreshes in the background (polling `GET /api/v1/account/notifications/summary`) so unread status stays current even outside the Account view.
- While the Account view is active, the inbox list now silently refreshes every 30 seconds and on tab visibility return to keep triage state current without manual refresh.
- Campaigns view now includes an operations panel for need-state flyer portfolio execution, including launch dependency gates, budget reconciliation, sequencing rationale, and one-click attributed lead prefill.
- Consultation cards now surface a backend-computed `riskSummary` (score, level, flags), and queue sorting can prioritize highest risk first.
- Consultation risk summaries now include `topFlags` with readable labels for explainable triage on each card.
- Consultation operations metrics now include critical risk share plus risk distribution counts (`critical`, `warning`, `stable`).
- Consultations queue header now shows `Last refresh` timestamp sourced from workspace payload `generatedAt` for clearer operational awareness.
- Mobile consultations workspace now includes panel tabs for `New request`, `Queue`, and `Comms desk` with in-view switching.

Consultation records can optionally include `specialtyId` and `procedureId` so claim broadcasts target eligible clinicians.
For older datasets, run `npm run migrate:data` to proactively backfill consultation collections and clinician consultation-availability defaults.

For a real healthcare pilot, run behind HTTPS, keep `DATA_FILE` outside the public web root, back it up daily, rotate demo passwords immediately, and restrict admin access to trusted staff.
