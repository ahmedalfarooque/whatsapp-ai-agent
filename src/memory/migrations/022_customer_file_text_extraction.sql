-- Text extraction for customer-supplied PDFs (additive only; nothing is rewritten or removed).
--
-- The original file is never touched. What was read from it lives in customer_files.extracted_text (added in 021) and is ALWAYS
-- unverified customer content: it is shown to staff, labelled as such, and is never given to the AI as policy or business knowledge.
-- These columns record how and when the extraction went, so a failure is visible and retryable instead of silent.
--   processing           'stored' (not attempted) | 'text_extracted' | 'extraction_failed' | 'unsupported'   (the 021 column, reused)
--   extracted_at         when the last attempt finished (success or failure)
--   extraction_error     why the last attempt failed (a short, path-free message), NULL after a success
--   extraction_pages     pages the reader reported
--   extraction_attempts  how many times it was tried (automatic first try + manual retries; capped in code)
ALTER TABLE customer_files ADD COLUMN extracted_at TEXT;
ALTER TABLE customer_files ADD COLUMN extraction_error TEXT;
ALTER TABLE customer_files ADD COLUMN extraction_pages INTEGER;
ALTER TABLE customer_files ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0;
