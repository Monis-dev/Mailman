CREATE TABLE jobs (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    service VARCHAR(100) NOT NULL,
    target_url TEXT NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'QUEUED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status_service ON jobs(status, service, created_at);

CREATE TABLE job_attempts (
    id BIGSERIAL PRIMARY KEY,
    job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    response_status_code INTEGER,
    execution_duration_ms INTEGER NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_attempts_job_id ON job_attempts(job_id);