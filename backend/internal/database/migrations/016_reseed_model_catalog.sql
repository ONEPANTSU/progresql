-- 016_reseed_model_catalog.sql
-- Add provider column and reseed model_catalog with correct current models.

-- Add provider column if not exists
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openrouter';

-- Add input/output price per million columns (easier to work with than per-token)
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS input_price_per_m NUMERIC(10,4) NOT NULL DEFAULT 0;
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS output_price_per_m NUMERIC(10,4) NOT NULL DEFAULT 0;

-- Clear old data and reseed with current models
DELETE FROM model_catalog;

INSERT INTO model_catalog (id, display_name, provider, tier, input_price_per_token, output_price_per_token, input_price_per_m, output_price_per_m, is_active, sort_order) VALUES
    -- Budget tier
    ('qwen/qwen3-coder',              'Qwen 3 Coder',      'openrouter', 'budget',  0.000000200000, 0.000000600000, 0.20, 0.60,  TRUE, 1),
    ('openai/gpt-4o-mini',            'GPT-4o Mini',        'openrouter', 'budget',  0.000000150000, 0.000000600000, 0.15, 0.60,  TRUE, 2),
    ('google/gemini-2.0-flash-001',   'Gemini 2.0 Flash',   'openrouter', 'budget',  0.000000100000, 0.000000400000, 0.10, 0.40,  TRUE, 3),
    ('deepseek/deepseek-chat-v3-0324','DeepSeek V3',        'openrouter', 'budget',  0.000000200000, 0.000000600000, 0.20, 0.60,  TRUE, 4),
    ('qwen/qwen3-vl-32b-instruct',   'Qwen 3 VL 32B',     'openrouter', 'budget',  0.000000200000, 0.000000600000, 0.20, 0.60,  TRUE, 5),
    ('openai/gpt-oss-120b',          'GPT-OSS 120B',       'openrouter', 'budget',  0.000000200000, 0.000000600000, 0.20, 0.60,  TRUE, 6),
    -- Premium tier
    ('openai/gpt-4.1',               'GPT-4.1',            'openrouter', 'premium', 0.000002000000, 0.000008000000, 2.00, 8.00,  TRUE, 10),
    ('openai/o4-mini',               'o4 Mini',            'openrouter', 'premium', 0.000001100000, 0.000004400000, 1.10, 4.40,  TRUE, 11),
    ('anthropic/claude-sonnet-4',    'Claude Sonnet 4',    'openrouter', 'premium', 0.000003000000, 0.000015000000, 3.00, 15.00, TRUE, 12),
    ('anthropic/claude-opus-4',      'Claude Opus 4',      'openrouter', 'premium', 0.000015000000, 0.000075000000, 15.00, 75.00, TRUE, 13),
    ('google/gemini-2.5-pro-preview','Gemini 2.5 Pro',     'openrouter', 'premium', 0.000001250000, 0.000010000000, 1.25, 10.00, TRUE, 14),
    ('deepseek/deepseek-r1',         'DeepSeek R1',        'openrouter', 'premium', 0.000000550000, 0.000002190000, 0.55, 2.19,  TRUE, 15),
    ('qwen/qwen3-235b-a22b',        'Qwen 3 235B',        'openrouter', 'premium', 0.000000200000, 0.000001200000, 0.20, 1.20,  TRUE, 16)
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    provider = EXCLUDED.provider,
    tier = EXCLUDED.tier,
    input_price_per_token = EXCLUDED.input_price_per_token,
    output_price_per_token = EXCLUDED.output_price_per_token,
    input_price_per_m = EXCLUDED.input_price_per_m,
    output_price_per_m = EXCLUDED.output_price_per_m,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order;
