-- Per-business fallback chat models (additive; every existing and future business keeps the shared behaviour until it sets its own).
--
-- business_settings.open_router_fallback_models
--   NULL = inherit the shared env list OPENROUTER_FALLBACK_MODELS (empty by default: nothing paid is ever chosen for a business).
--   ''   = no fallback model for this business.
--   'a/b:free, c/d' = comma-separated OpenRouter model ids. When the business's chat model fails for a MODEL-SPECIFIC reason (refused,
--          provider error, rate limit, empty answer) ONE eligible fallback is tried with the same conversation; after an HTTP 402 only a
--          free (price 0) fallback is tried. An account-wide problem (key rejected, free endpoints blocked by the account's data policy)
--          is never "solved" by switching models: it is recorded for staff and the customer gets the local automated choices instead.
ALTER TABLE business_settings ADD COLUMN open_router_fallback_models TEXT;
