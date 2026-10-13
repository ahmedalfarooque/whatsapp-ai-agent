-- Shared AI capability layer: reply-language policy and the vision model, per business (additive only; nothing is rewritten or removed).
--
-- Every business, existing or created later, gets the same defaults when these are NULL:
--   ai_reply_language        NULL = reply in the language of the customer's latest message (the shared default policy). A language code
--                            ('ar', 'en', ...) is a deliberate account-level override: always reply in that language.
--   open_router_vision_model NULL = env OPENROUTER_VISION_MODEL. The model given the actual image bytes when a customer sends a picture;
--                            it must accept image input. A text-only model is never pretended to have seen the picture.
ALTER TABLE business_settings ADD COLUMN ai_reply_language TEXT;
ALTER TABLE business_settings ADD COLUMN open_router_vision_model TEXT;
