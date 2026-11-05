CREATE TABLE users (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(30),
    role ENUM('patient', 'clinician', 'hospital_staff', 'coordinator', 'admin', 'finance') NOT NULL,
    email_verified_at TIMESTAMP NULL,
    remember_token VARCHAR(100),
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL
);

CREATE TABLE patients (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NULL,
    date_of_birth DATE,
    gender ENUM('male', 'female', 'other') NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100) DEFAULT 'Nigeria',
    emergency_contact_name VARCHAR(200),
    emergency_contact_phone VARCHAR(30),
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT patients_user_id_foreign FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE leads (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    patient_id BIGINT UNSIGNED NULL,
    source VARCHAR(100),
    campaign VARCHAR(100),
    channel VARCHAR(50),
    name VARCHAR(200) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(30),
    location VARCHAR(200),
    healthcare_requirement TEXT,
    status ENUM('new', 'contacted', 'qualified', 'referral_created', 'provider_matched', 'appointment', 'completed', 'closed_lost') DEFAULT 'new',
    assigned_staff_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT leads_patient_id_foreign FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL,
    CONSTRAINT leads_assigned_staff_id_foreign FOREIGN KEY (assigned_staff_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE providers (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    type ENUM('hospital', 'clinic', 'diagnostic_center') NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100) DEFAULT 'Nigeria',
    contact_name VARCHAR(200),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(30),
    website VARCHAR(255),
    onboarding_status ENUM('invited', 'documents_submitted', 'verified', 'active', 'suspended') DEFAULT 'invited',
    rating DECIMAL(3,2) NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL
);

CREATE TABLE specialties (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL
);

CREATE TABLE procedures (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    specialty_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    typical_cost DECIMAL(15,2) NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT procedures_specialty_id_foreign FOREIGN KEY (specialty_id) REFERENCES specialties(id)
);

CREATE TABLE provider_procedures (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    provider_id BIGINT UNSIGNED NOT NULL,
    procedure_id BIGINT UNSIGNED NOT NULL,
    cost DECIMAL(15,2) NULL,
    availability ENUM('available', 'limited', 'unavailable') DEFAULT 'available',
    waiting_time_days INT NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT provider_procedures_provider_id_foreign FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
    CONSTRAINT provider_procedures_procedure_id_foreign FOREIGN KEY (procedure_id) REFERENCES procedures(id) ON DELETE CASCADE,
    UNIQUE KEY provider_procedure_unique (provider_id, procedure_id)
);

CREATE TABLE referrals (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    referral_number VARCHAR(50) UNIQUE NOT NULL,
    patient_id BIGINT UNSIGNED NOT NULL,
    lead_id BIGINT UNSIGNED NULL,
    referrer_clinician_id BIGINT UNSIGNED NULL,
    healthcare_requirement TEXT NOT NULL,
    specialty_id BIGINT UNSIGNED NOT NULL,
    procedure_id BIGINT UNSIGNED NOT NULL,
    priority ENUM('routine', 'urgent', 'emergency') DEFAULT 'routine',
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    assigned_coordinator_id BIGINT UNSIGNED NULL,
    assigned_provider_id BIGINT UNSIGNED NULL,
    patient_notes TEXT,
    internal_notes TEXT,
    closed_at TIMESTAMP NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT referrals_patient_id_foreign FOREIGN KEY (patient_id) REFERENCES patients(id),
    CONSTRAINT referrals_lead_id_foreign FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    CONSTRAINT referrals_referrer_clinician_id_foreign FOREIGN KEY (referrer_clinician_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT referrals_specialty_id_foreign FOREIGN KEY (specialty_id) REFERENCES specialties(id),
    CONSTRAINT referrals_procedure_id_foreign FOREIGN KEY (procedure_id) REFERENCES procedures(id),
    CONSTRAINT referrals_assigned_coordinator_id_foreign FOREIGN KEY (assigned_coordinator_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT referrals_assigned_provider_id_foreign FOREIGN KEY (assigned_provider_id) REFERENCES providers(id) ON DELETE SET NULL
);

CREATE TABLE referral_status_history (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    referral_id BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    changed_by_user_id BIGINT UNSIGNED NOT NULL,
    note TEXT,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT referral_status_history_referral_id_foreign FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE CASCADE,
    CONSTRAINT referral_status_history_changed_by_user_id_foreign FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
);

CREATE TABLE documents (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    referral_id BIGINT UNSIGNED NOT NULL,
    patient_id BIGINT UNSIGNED NOT NULL,
    document_type VARCHAR(50),
    file_name VARCHAR(255) NOT NULL,
    storage_disk VARCHAR(50) DEFAULT 'local',
    storage_path VARCHAR(500) NOT NULL,
    file_size_bytes BIGINT UNSIGNED,
    mime_type VARCHAR(100),
    uploaded_by_user_id BIGINT UNSIGNED NOT NULL,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT documents_referral_id_foreign FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE CASCADE,
    CONSTRAINT documents_patient_id_foreign FOREIGN KEY (patient_id) REFERENCES patients(id),
    CONSTRAINT documents_uploaded_by_user_id_foreign FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
);

CREATE TABLE appointments (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    referral_id BIGINT UNSIGNED NOT NULL,
    provider_id BIGINT UNSIGNED NOT NULL,
    patient_id BIGINT UNSIGNED NOT NULL,
    scheduled_date DATE NOT NULL,
    scheduled_time TIME NOT NULL,
    duration_minutes INT DEFAULT 30,
    status ENUM('scheduled', 'confirmed', 'attended', 'cancelled', 'no_show') DEFAULT 'scheduled',
    notes TEXT,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT appointments_referral_id_foreign FOREIGN KEY (referral_id) REFERENCES referrals(id),
    CONSTRAINT appointments_provider_id_foreign FOREIGN KEY (provider_id) REFERENCES providers(id),
    CONSTRAINT appointments_patient_id_foreign FOREIGN KEY (patient_id) REFERENCES patients(id)
);

CREATE TABLE payments (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    referral_id BIGINT UNSIGNED NOT NULL,
    patient_id BIGINT UNSIGNED NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency CHAR(3) DEFAULT 'NGN',
    payment_type ENUM('deposit', 'full', 'commission', 'coordination_fee') NOT NULL,
    status ENUM('pending', 'paid', 'failed', 'refunded') DEFAULT 'pending',
    payment_method VARCHAR(50),
    transaction_reference VARCHAR(255) UNIQUE,
    provider_payout_amount DECIMAL(15,2) NULL,
    reconciliation_status ENUM('unreconciled', 'reconciled') DEFAULT 'unreconciled',
    paid_at TIMESTAMP NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT payments_referral_id_foreign FOREIGN KEY (referral_id) REFERENCES referrals(id),
    CONSTRAINT payments_patient_id_foreign FOREIGN KEY (patient_id) REFERENCES patients(id)
);

CREATE TABLE notification_logs (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    referral_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    channel ENUM('email', 'sms', 'whatsapp', 'internal') NOT NULL,
    recipient VARCHAR(255) NOT NULL,
    subject VARCHAR(255),
    body TEXT,
    status ENUM('pending', 'sent', 'failed') DEFAULT 'pending',
    provider VARCHAR(100),
    provider_reference VARCHAR(255),
    failure_reason TEXT,
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    CONSTRAINT notification_logs_referral_id_foreign FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE SET NULL,
    CONSTRAINT notification_logs_user_id_foreign FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

