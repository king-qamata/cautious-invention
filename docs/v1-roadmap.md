# V1 Roadmap

## Goal

Validate whether Mindset Healthcare can reliably move a patient from demand to service delivery through a managed provider network.

## 6-8 Week MVP Sequence

1. Core Laravel project
   - Laravel app structure
   - Sanctum authentication
   - Role model and policies
   - Database-backed sessions, cache, and queues

2. Core domain schema
   - Users and patients
   - Leads
   - Providers, specialties, procedures
   - Referrals and referral status history
   - Documents

3. Referral workflow
   - Referral number generation
   - State transition validation
   - Append-only status history
   - Coordinator assignment
   - Provider assignment

4. Coordinator operations
   - Lead list and qualification
   - Convert lead to referral
   - Manual provider matching
   - Referral status updates
   - Internal notes

5. Patient-facing basics
   - Public enquiry form
   - Registration/login
   - Referral status view
   - Document upload

6. Provider catalogue
   - Provider CRUD
   - Specialty/procedure mapping
   - Availability and waiting time fields
   - Seed list for priority providers

7. Notifications
   - Email on key status changes
   - SMS for patient-facing status updates
   - Notification log table
   - Failed notification review queue

8. Reporting
   - Lead counts by source/status
   - Referral counts by status/provider
   - Average time in status
   - Stale referrals requiring action

## V1 Non-Goals

- Automated provider matching
- Payment gateway integration
- Provider self-service onboarding
- Diaspora sponsor portal
- Clinician network portal
- Data warehouse or ETL pipeline
- WebSockets or real-time chat

