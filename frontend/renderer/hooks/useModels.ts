import { useState, useEffect } from 'react';
import { ModelInfo } from '../types';
import { fetchModels } from '../services/auth';

// Fallback models if API fails (matches backend config.DefaultModels)
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'qwen/qwen3-coder', name: 'Qwen 3 Coder', provider: 'openrouter', tier: 'budget', input_price_per_m: 0.20, output_price_per_m: 0.60, is_default: false },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openrouter', tier: 'budget', input_price_per_m: 0.15, output_price_per_m: 0.60, is_default: false },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', provider: 'openrouter', tier: 'budget', input_price_per_m: 0.10, output_price_per_m: 0.40, is_default: false },
  { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', provider: 'openrouter', tier: 'budget', input_price_per_m: 0.20, output_price_per_m: 0.60, is_default: false },
  { id: 'qwen/qwen3-vl-32b-instruct', name: 'Qwen 3 VL 32B', provider: 'openrouter', tier: 'budget', input_price_per_m: 0.20, output_price_per_m: 0.60, is_default: false },
  { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', provider: 'openrouter', tier: 'budget', input_price_per_m: 0.20, output_price_per_m: 0.60, is_default: false },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1', provider: 'openrouter', tier: 'premium', input_price_per_m: 2.00, output_price_per_m: 8.00, is_default: false },
  { id: 'openai/o4-mini', name: 'o4 Mini', provider: 'openrouter', tier: 'premium', input_price_per_m: 1.10, output_price_per_m: 4.40, is_default: false },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'openrouter', tier: 'premium', input_price_per_m: 3.00, output_price_per_m: 15.00, is_default: false },
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', provider: 'openrouter', tier: 'premium', input_price_per_m: 15.00, output_price_per_m: 75.00, is_default: false },
  { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', provider: 'openrouter', tier: 'premium', input_price_per_m: 1.25, output_price_per_m: 10.00, is_default: false },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'openrouter', tier: 'premium', input_price_per_m: 0.55, output_price_per_m: 2.19, is_default: false },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen 3 235B', provider: 'openrouter', tier: 'premium', input_price_per_m: 0.20, output_price_per_m: 1.20, is_default: false },
];

let cachedModels: ModelInfo[] | null = null;

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>(cachedModels || FALLBACK_MODELS);
  const [loading, setLoading] = useState(!cachedModels);

  useEffect(() => {
    if (cachedModels) return;
    let cancelled = false;

    fetchModels()
      .then(data => {
        if (!cancelled && data.models?.length > 0) {
          cachedModels = data.models;
          setModels(data.models);
        }
      })
      .catch(() => {
        // Use fallback
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const budgetModels = models.filter(m => m.tier === 'budget');
  const premiumModels = models.filter(m => m.tier === 'premium');

  return { models, budgetModels, premiumModels, loading };
}

// Utility: format model name from any ID (with fuzzy matching)
export function formatModelName(modelId: string, models: ModelInfo[]): string {
  // Exact match
  const exact = models.find(m => m.id === modelId);
  if (exact) return exact.name;

  // Fuzzy: check if model's short name is contained in the given ID
  for (const m of models) {
    const shortName = m.id.replace(/^[^/]+\//, ''); // remove provider prefix
    if (modelId.includes(shortName)) return m.name;
  }

  // Fallback: clean up the raw ID
  const short = modelId.split('/').pop() || modelId;
  return short.replace(/-\d{8,}$/, '');
}
