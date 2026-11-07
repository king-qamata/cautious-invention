# API Contract

V1 should expose stable REST endpoints under `/api/v1`. Keep response shapes boring and explicit so a future Django V2 can preserve compatibility.

## Error Responses

API errors use a consistent JSON envelope. `requestId` can be shared with an operator when support is needed; production 5xx messages intentionally do not expose internal exception details.

```json
{
  "error": "Email is already in use.",
  "code": "VALIDATION_ERROR",
  "requestId": "req_mabc123_xyz"
}
```

Common codes are `BAD_REQUEST` (400), `AUTHENTICATION_REQUIRED` (401), `PERMISSION_DENIED` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `VALIDATION_ERROR` (422), `RATE_LIMITED` (429), and `INTERNAL_ERROR` (500). Rate-limited responses may include the standard `Retry-After` header.

## Auth

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me`

## Account

- `GET /api/v1/account/use-cases`
- `PATCH /api/v1/account/profile`
- `POST /api/v1/account/change-password`
- `GET /api/v1/account/clinician-availability`
- `PATCH /api/v1/account/clinician-availability`
- `GET /api/v1/account/notification-preferences`
- `PATCH /api/v1/account/notification-preferences`
- `POST /api/v1/account/telegram/link`
- `DELETE /api/v1/account/telegram/link`
- `GET /api/v1/account/notifications`
- `POST /api/v1/account/notifications/read`

Notification preference channels are `sms`, `email`, `in_app`, `whatsapp`, and
`telegram`. WhatsApp requires a saved phone number and explicit user selection.
Telegram must be linked first; the link endpoint returns a short-lived bot deep
link. The Telegram bot webhook is `POST /api/v1/messaging/telegram/webhook` and
requires the configured Telegram webhook secret header.

```json
{
  "consultations": {
    "preferredChannels": ["in_app", "whatsapp"],
    "emailCopyEnabled": true
  }
}
```

## Consultations

- `GET /api/v1/consultations`
- `POST /api/v1/consultations`
- `GET /api/v1/consultations/{consultation_number_or_id}`
- `POST /api/v1/consultations/{consultation_number_or_id}/claim`
- `POST /api/v1/consultations/{consultation_number_or_id}/start`
- `POST /api/v1/consultations/{consultation_number_or_id}/escalate`
- `POST /api/v1/consultations/{consultation_number_or_id}/complete`
- `POST /api/v1/consultations/{consultation_number_or_id}/cancel`
- `GET /api/v1/consultations/{consultation_number_or_id}/claims`
- `GET /api/v1/consultations/{consultation_number_or_id}/biometric-hooks`
- `POST /api/v1/consultations/{consultation_number_or_id}/biometric-hooks`
- `GET /api/v1/consultations/{consultation_number_or_id}/sessions`
- `POST /api/v1/consultations/{consultation_number_or_id}/sessions`
- `POST /api/v1/consultations/{consultation_number_or_id}/sessions/{session_id}/close`

## Leads

- `GET /api/v1/leads`
- `POST /api/v1/leads`
- `GET /api/v1/leads/{id}`
- `PATCH /api/v1/leads/{id}`
- `POST /api/v1/leads/{id}/convert-to-referral`

## Referrals

- `GET /api/v1/referrals`
- `POST /api/v1/referrals`
- `GET /api/v1/referrals/{referral_number}`
- `PATCH /api/v1/referrals/{referral_number}`
- `POST /api/v1/referrals/{referral_number}/transition`
- `GET /api/v1/referrals/{referral_number}/history`
- `GET /api/v1/referrals/{referral_number}/documents`
- `POST /api/v1/referrals/{referral_number}/documents`
- `GET /api/v1/documents/{id}/download`

## Providers

- `GET /api/v1/providers`
- `POST /api/v1/providers`
- `GET /api/v1/providers/{id}`
- `PATCH /api/v1/providers/{id}`
- `GET /api/v1/providers/{id}/procedures`
- `POST /api/v1/providers/{id}/procedures`

## Catalogue

- `GET /api/v1/specialties`
- `POST /api/v1/specialties`
- `GET /api/v1/procedures`
- `POST /api/v1/procedures`

## Reporting

- `GET /api/v1/reports/lead-conversion`
- `GET /api/v1/reports/referral-volume`
- `GET /api/v1/reports/turnaround-time`
- `GET /api/v1/reports/stale-referrals`

## Operations

- `GET /api/v1/operations/consultation-sla`
- `POST /api/v1/operations/jobs/release-unclaimed-consultations`

## Transition Request

```json
{
  "to_status": "accepted",
  "note": "Accepted by provider contact after review."
}
```

## Consultation Create Request

```json
{
  "requestedNeed": "Recurring chest pain and anxiety concerns",
  "tier": "priority",
  "requestedCommunicationMode": "voice_call",
  "specialtyId": "specialty_...",
  "procedureId": "procedure_...",
  "paymentMethod": "card"
}
```

`specialtyId` and `procedureId` are optional but recommended to enable specialty/procedure claim targeting for clinicians.

## Account Use-Cases Response

```json
{
  "data": {
    "user": {
      "id": "user_...",
      "email": "clinician@mindset.local",
      "firstName": "Demo",
      "lastName": "Clinician",
      "role": "clinician"
    },
    "allowedActions": [
      "claim_consultation",
      "start_consultation",
      "complete_consultation",
      "escalate_consultation_tier"
    ],
    "summary": {
      "openBroadcasts": 2,
      "claimedConsultations": 1,
      "inProgressConsultations": 1,
      "completedConsultations": 0
    }
  }
}
```

## Consultation Response

```json
{
  "data": {
    "id": "consultation_...",
    "consultationNumber": "CON-2026-0004",
    "patientId": "patient_...",
    "assignedClinicianId": null,
    "specialtyId": "specialty_...",
    "procedureId": "procedure_...",
    "tier": "priority",
    "requestedCommunicationMode": "voice_call",
    "communicationLayers": ["voice_call", "voice_text", "video_call"],
    "activeCommunicationLayer": null,
    "communicationMode": "voice_call",
    "amountNgn": 5000,
    "status": "REQUESTED",
    "claimWindowEndsAt": "2026-09-09T11:11:11.111Z",
    "statusHistory": [
      {
        "fromStatus": null,
        "toStatus": "REQUESTED",
        "note": "Consultation requested."
      }
    ]
  }
}
```

After a clinician accepts, the patient can initialize Paystack checkout with
`POST /api/v1/consultations/{consultationId}/payment/initialize`. The patient
can confirm the result with `POST /api/v1/consultations/{consultationId}/payment/verify`;
Paystack's signed `charge.success` webhook is also accepted at
`POST /api/v1/payments/paystack/webhook`. The webhook is the server-side source
of truth, and a consultation cannot start until a successful charge is verified.

## Clinician Availability Request

```json
{
  "enabled": true,
  "acceptedTiers": ["normal", "priority"],
  "specialtyIds": ["specialty_..."],
  "procedureIds": ["procedure_..."]
}
```

## Consultation Session Open Request

```json
{
  "channel": "voice_call",
  "metadata": {
    "source": "dashboard"
  }
}
```

`channel` must be one of the consultation communication layers after claim (`voice_text`, `voice_call`, `video_call`).
The patient-requested mode is prioritized as the first layer, and clinicians can hand off between layers by closing the active session and opening the next channel.

## Consultation Session Response

```json
{
  "data": {
    "id": "consultation_session_...",
    "consultationId": "consultation_...",
    "channel": "voice_call",
    "status": "active",
    "startedByUserId": "user_...",
    "endedByUserId": null,
    "participantRoles": ["patient", "clinician"],
    "startedAt": "2026-09-09T11:11:11.111Z",
    "endedAt": null
  }
}
```

## Transition Response

```json
{
  "data": {
    "referral_number": "REF-2026-0001",
    "from_status": "sent_to_provider",
    "to_status": "accepted",
    "changed_at": "2026-08-25T10:30:00Z"
  }
}
```

<!-- End of API contract. -->
<!-- Document terminator. -->
