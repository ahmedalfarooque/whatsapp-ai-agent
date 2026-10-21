-- A provider's pause now records WHY and for HOW LONG it is real: the category of the failure, whether the end of the pause is a reset time the provider
-- itself stated (Retry-After, X-RateLimit-Reset, Google RetryInfo / daily reset) or only our own bounded backoff, how many failures in a row the route has
-- had (the backoff doubles up to a cap and starts over after a success or six quiet hours), and when the pause was set. The row now stays after the pause
-- ends (until a success clears it or it is older than a day) so the next failure continues the backoff and a recovering route is tested by ONE request at a time.
-- Additive columns with defaults: the previous build ignores them. Rollback: leave the columns in place.
ALTER TABLE ai_route_cooldowns ADD COLUMN category TEXT;
ALTER TABLE ai_route_cooldowns ADD COLUMN reset_known INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_route_cooldowns ADD COLUMN strikes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_route_cooldowns ADD COLUMN set_at_ms INTEGER;
