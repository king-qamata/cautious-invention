# ADR 0001: CPanel-Compatible Laravel V1

## Status

Accepted

## Context

Mindset Healthcare needs to validate a referral-led healthcare operating model while hosting constraints require a CPanel-compatible deployment. CPanel generally means limited process control, no container orchestration, no Redis, restricted background workers, and a strong preference for PHP/MySQL-style hosting.

The platform must still preserve a credible path to a richer V2 backend after the business model is proven.

## Decision

Build V1 as a Laravel modular monolith deployed to CPanel, with a static JavaScript frontend and a relational database. Use database-backed queues, CPanel cron, SMTP, and local or S3-compatible object storage.

Treat `referrals` as the primary business aggregate. Leads, patients, providers, documents, appointments, payments, and notifications all support the referral lifecycle.

## Consequences

- V1 can launch with low infrastructure cost and minimal operational burden.
- The team gets Laravel's mature ORM, scheduler, queue abstractions, policies, and admin ecosystem.
- Background work must be short-running and cron-friendly.
- The API and schema must be intentionally versioned to avoid locking the project into Laravel.
- V2 can move to Django/cloud infrastructure only after referral volume, workflow complexity, or analytics needs justify the investment.

## V1 Stack

- Backend: Laravel 11 or current CPanel-supported Laravel release
- Frontend: Vue or React static build via Vite
- Database: MySQL 8 on CPanel
- Auth: Laravel Sanctum
- Queue: Laravel database queue
- Scheduler: Laravel scheduler invoked by cron
- Storage: private local storage for MVP, Cloudflare R2 when document volume grows
- Email: SMTP relay
- SMS/WhatsApp: Africa's Talking or Twilio, with delivery logs

## V2 Trigger Conditions

Consider Django/cloud migration when at least one of these becomes true:

- Referral volume exceeds shared-hosting comfort, roughly 100 referrals per day sustained
- Automated provider matching or analytics becomes a core differentiator
- Real-time notifications or chat is required
- Team capacity includes Python/data engineering ownership
- Integrations require long-running workers, queues, or event streaming

