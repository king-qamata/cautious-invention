# Referral State Machine

## States

| State | Meaning |
| --- | --- |
| `draft` | Referral exists but is incomplete or internal-only. |
| `submitted` | Patient, clinician, or coordinator has submitted the case. |
| `under_review` | Coordinator or clinical admin is reviewing details. |
| `matched` | One or more provider candidates have been identified. |
| `sent_to_provider` | Referral has been sent to a selected provider. |
| `accepted` | Provider accepted the referral. |
| `request_info` | Provider or coordinator needs more information. |
| `resubmitted` | Additional information has been supplied. |
| `appointment_scheduled` | Appointment details have been recorded. |
| `patient_attended` | Patient attended the appointment. |
| `service_completed` | Provider service has been completed. |
| `closed` | Referral is complete and operationally closed. |
| `rejected` | Provider or clinical review rejected the referral. |
| `rematch` | Referral is being reassigned after rejection. |
| `cancelled` | Referral was cancelled before completion. |

## Allowed Transitions

| From | To |
| --- | --- |
| `draft` | `submitted`, `cancelled` |
| `submitted` | `under_review`, `cancelled` |
| `under_review` | `matched`, `request_info`, `rejected`, `cancelled` |
| `matched` | `sent_to_provider`, `rematch`, `cancelled` |
| `sent_to_provider` | `accepted`, `rejected`, `request_info` |
| `accepted` | `appointment_scheduled`, `request_info`, `cancelled` |
| `request_info` | `resubmitted`, `cancelled` |
| `resubmitted` | `under_review`, `accepted`, `rejected` |
| `appointment_scheduled` | `patient_attended`, `cancelled` |
| `patient_attended` | `service_completed` |
| `service_completed` | `closed` |
| `rejected` | `rematch`, `closed` |
| `rematch` | `matched`, `sent_to_provider`, `cancelled` |
| `closed` | none |
| `cancelled` | none |

## Side Effects

- `submitted`: notify coordinator queue
- `matched`: record provider candidates
- `sent_to_provider`: notify provider contact
- `accepted`: notify patient and coordinator
- `request_info`: notify responsible party
- `appointment_scheduled`: notify patient and provider
- `service_completed`: notify finance/admin for reconciliation
- `closed`: lock most operational edits

