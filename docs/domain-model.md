# Domain Model

## Aggregate Root

`Referral` is the primary business aggregate. It is the durable work item that connects patient demand, provider capacity, documents, appointments, notifications, and finance.

## Core Entities

`User`
: Authenticated account. Role determines portal access and operational permissions.

`Patient`
: Person receiving care. A patient can have many referrals.

`Lead`
: CRM record created from public enquiry, campaign, coordinator intake, or partner source. A lead may convert into zero, one, or many referrals over time.

Public leads record whether the enquiry is for the submitter or a family member, the originating country, and the consent timestamp. Consent is required before the enquiry is stored.

Each lead also carries an independent `funnelStage` and append-only `funnelStageHistory`. CRM status tracks staff work; funnel stage tracks the patient journey: `awareness`, `landing_page`, `application`, `screening`, `provider_match`, `booking`, `consultation`, and `retention`. Stages advance one step at a time so conversion and drop-off can be measured by handoff.

`Provider`
: Hospital, clinic, or diagnostic center in the network.

`Specialty`
: Clinical category used to classify provider capability and referrals.

`Procedure`
: Service or procedure within a specialty.

`ProviderProcedure`
: Mapping between provider and procedure, including availability, waiting time, and optional cost.

`Referral`
: Unit of work. Tracks requirement, specialty, procedure, priority, assigned coordinator, assigned provider, and lifecycle status.

`ReferralStatusHistory`
: Append-only operational history for every referral status change.

`Document`
: File attached to a referral and patient. Access must be policy controlled.

`Appointment`
: Mindset-managed appointment record for V1.

`Payment`
: Manual or semi-manual payment/reconciliation record. Payment processing can remain deferred.

`NotificationLog`
: Delivery audit for email, SMS, WhatsApp, and internal alerts.

## Roles

- `patient`
- `clinician`
- `hospital_staff`
- `coordinator`
- `admin`
- `finance`

## Invariants

- A referral must have exactly one patient.
- A referral number is globally unique and should be used as the business-facing identifier.
- A status change must write a `ReferralStatusHistory` row.
- A referral cannot be accepted without an assigned provider.
- A referral cannot be closed until service delivery or cancellation is recorded.
- Medical documents must not be publicly addressable.

