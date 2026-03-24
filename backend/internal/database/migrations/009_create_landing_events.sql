CREATE TABLE IF NOT EXISTS landing_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    session_id VARCHAR(100),
    referrer TEXT,
    referrer_domain VARCHAR(255),
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    country VARCHAR(10),
    button_id VARCHAR(100),
    scroll_percent INTEGER,
    video_action VARCHAR(50),
    screen_width INTEGER,
    user_agent TEXT,
    ip_hash VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_landing_events_type ON landing_events(event_type);
CREATE INDEX idx_landing_events_created ON landing_events(created_at);
CREATE INDEX idx_landing_events_session ON landing_events(session_id);
