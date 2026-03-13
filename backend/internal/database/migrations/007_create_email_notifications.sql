CREATE TABLE IF NOT EXISTS email_notifications (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    threshold_days  INT NOT NULL,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, notification_type, threshold_days)
);

CREATE INDEX idx_email_notifications_user_id ON email_notifications (user_id);
