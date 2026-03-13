-- 004_create_legal_tables.sql
-- Versioned legal documents and user acceptance history for compliance tracking.

CREATE TABLE IF NOT EXISTS legal_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type        TEXT NOT NULL,
    version         TEXT NOT NULL,
    title           TEXT NOT NULL,
    language        TEXT NOT NULL DEFAULT 'ru',
    content_html    TEXT NOT NULL DEFAULT '',
    published_at    TIMESTAMPTZ,
    effective_at    TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (doc_type, version, language)
);

CREATE INDEX IF NOT EXISTS idx_legal_documents_doc_type ON legal_documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_legal_documents_active ON legal_documents (doc_type, is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS legal_acceptances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type        TEXT NOT NULL,
    doc_version     TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'signup',
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip              TEXT NOT NULL DEFAULT '',
    user_agent      TEXT NOT NULL DEFAULT '',
    app_version     TEXT NOT NULL DEFAULT '',
    locale          TEXT NOT NULL DEFAULT '',
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user_id ON legal_acceptances (user_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_doc_type ON legal_acceptances (doc_type);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_accepted_at ON legal_acceptances (accepted_at);
