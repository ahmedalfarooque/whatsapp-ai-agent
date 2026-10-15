-- Local inference (Ollama) is no longer an application provider. Any provider row of that kind (and its place in a business's routing order)
-- is removed so nothing can route to a local runtime. The CHECK constraint of ai_providers.kind in migration 027 still lists 'ollama'
-- (SQLite cannot alter a CHECK in place and the earlier migration is history); the application refuses the kind everywhere and no row can
-- remain, so the constraint is harmless. Providers of the other kinds, keys, orders and all customer data are untouched.
DELETE FROM ai_account_routing WHERE entry_key IN (SELECT 'provider:' || id FROM ai_providers WHERE kind = 'ollama');
DELETE FROM ai_providers WHERE kind = 'ollama';
