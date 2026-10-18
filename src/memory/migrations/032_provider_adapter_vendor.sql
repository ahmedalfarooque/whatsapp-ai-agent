-- Each provider speaks its vendor's own API through an adapter (openrouter | openai | gemini) and has a vendor identity (groq, google, xai, mistral,
-- cerebras, openrouter, custom). Existing rows keep behaving exactly as before: the OpenAI protocol, with the vendor recognised from the address.
-- Rollback: both columns are harmless if left in place (the previous build ignores them).
ALTER TABLE ai_providers ADD COLUMN adapter TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE ai_providers ADD COLUMN vendor TEXT NOT NULL DEFAULT 'custom';

UPDATE ai_providers SET adapter = 'openrouter', vendor = 'openrouter' WHERE kind = 'openrouter';
UPDATE ai_providers SET vendor = 'groq'      WHERE kind <> 'openrouter' AND base_url LIKE 'https://api.groq.com/%';
UPDATE ai_providers SET vendor = 'google'    WHERE kind <> 'openrouter' AND base_url LIKE 'https://generativelanguage.googleapis.com/%';
UPDATE ai_providers SET vendor = 'xai'       WHERE kind <> 'openrouter' AND base_url LIKE 'https://api.x.ai/%';
UPDATE ai_providers SET vendor = 'mistral'   WHERE kind <> 'openrouter' AND base_url LIKE 'https://api.mistral.ai/%';
UPDATE ai_providers SET vendor = 'cerebras'  WHERE kind <> 'openrouter' AND base_url LIKE 'https://api.cerebras.ai/%';
