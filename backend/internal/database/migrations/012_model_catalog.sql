-- 012_model_catalog.sql
-- Centralized model catalog with pricing tiers.
-- Prices are stored per-token (USD); to convert from "per million" divide by 1,000,000.

CREATE TABLE IF NOT EXISTS model_catalog (
    id                    TEXT PRIMARY KEY,                    -- e.g. "qwen/qwen3-coder"
    display_name          TEXT NOT NULL,
    tier                  TEXT NOT NULL CHECK (tier IN ('budget', 'premium')),
    input_price_per_token  NUMERIC(16,12) NOT NULL,            -- USD per token
    output_price_per_token NUMERIC(16,12) NOT NULL,            -- USD per token
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed budget models (price per token = price per million / 1,000,000).
INSERT INTO model_catalog (id, display_name, tier, input_price_per_token, output_price_per_token, sort_order) VALUES
    ('qwen/qwen3-coder',          'Qwen 3 Coder',      'budget',  0.000000150000, 0.000000600000,  1),
    ('qwen/qwen3-coder-next',     'Qwen 3 Coder Next',  'budget',  0.000000120000, 0.000000750000,  2),
    ('openai/gpt-4o-mini',        'GPT-4o Mini',        'budget',  0.000000150000, 0.000000600000,  3),
    ('deepseek/deepseek-v3.2',    'DeepSeek V3.2',      'budget',  0.000000260000, 0.000000380000,  4),
    ('x-ai/grok-4.1-fast',        'Grok 4.1 Fast',      'budget',  0.000000200000, 0.000000500000,  5),
    ('openai/gpt-oss-120b',       'GPT-OSS 120B',       'budget',  0.000000100000, 0.000000100000,  6)
ON CONFLICT (id) DO NOTHING;

-- Seed premium models.
INSERT INTO model_catalog (id, display_name, tier, input_price_per_token, output_price_per_token, sort_order) VALUES
    ('qwen/qwen3-max',                   'Qwen 3 Max',        'premium', 0.000000780000, 0.000003900000, 10),
    ('google/gemini-3.1-pro-preview',     'Gemini 3.1 Pro',    'premium', 0.000002000000, 0.000012000000, 11),
    ('openai/gpt-5.3-codex',             'GPT-5.3 Codex',     'premium', 0.000001750000, 0.000014000000, 12),
    ('openai/gpt-5.4',                   'GPT-5.4',           'premium', 0.000002500000, 0.000015000000, 13),
    ('anthropic/claude-sonnet-4.6',       'Claude Sonnet 4.6', 'premium', 0.000003000000, 0.000015000000, 14),
    ('anthropic/claude-opus-4.6',         'Claude Opus 4.6',   'premium', 0.000005000000, 0.000025000000, 15)
ON CONFLICT (id) DO NOTHING;
