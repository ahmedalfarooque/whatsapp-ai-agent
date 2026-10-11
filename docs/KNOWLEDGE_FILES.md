# Knowledge files and AI provider status

## Where the files live

Every business reads **only its own** knowledge folder:

| Account | Folder |
|---|---|
| 1 (the original business) | `knowledge/` (override: `KNOWLEDGE_LEGACY_DIR`) |
| every other account | `knowledge/accounts/<id>/` (override: `KNOWLEDGE_ACCOUNTS_DIR`) |

The assistant is given the business profile, current offers, uploaded documents and catalogues, **and** every `.md` / `.json` file of
its own folder. Nothing is shared between accounts. The test suite points both overrides at throw-away folders, so `npm test` never
touches the real files.

## What the Knowledge page reports

The status is the file's real state on the server, not just "exists":

| Status | Meaning |
|---|---|
| Available | the file exists and is usable |
| Missing | a core file (`business.md`, `services.md`, `policies.md`, `faq.md`) does not exist |
| Not created | an optional file (`ai-knowledge.md`, `booking.json`) does not exist — not a defect |
| Empty | the file exists but holds nothing |
| Invalid | a JSON file that does not parse (the assistant skips it); the reason is shown |
| Placeholder | the file exists but only says that nothing was provided yet — it still needs real content |

`booking.json` is optional reference text. Appointment behaviour is configured in Business Information and Automation.

## Creating missing files (operator tool)

```bash
node dist/setup/repairKnowledgeCli.js 2            # dry run: prints exactly what would be created
node dist/setup/repairKnowledgeCli.js --apply 2    # writes it
```

Take a backup first. The tool builds the files from the account's **own** stored profile, links and documents (the same grounded
generator as Analyze & Generate, rules only) and:

- never touches a file that already holds text;
- never copies anything between accounts;
- never writes platform process wording (appointments, quotations, hand-over) into `policies.md`;
- creates `services.md`, `faq.md` and `policies.md` as explicit *placeholders* when nothing is stored for them — they say nothing was
  provided and tell the assistant not to state or guess prices, services or policies;
- creates nothing at all for a business with no stored information.

Placeholders are generated blocks: running Analyze & Generate (merge) later replaces an untouched one with real content.

## AI provider status (the pill in the top bar)

The pill is decided by a live, cached check of the saved OpenRouter key (`GET /api/v1/auth/key`, cached 5 minutes, 1 minute after a
failure). The verdict is tied to a one-way fingerprint of the key, so saving a different key discards it at once. Reply history is only
a secondary signal, and failures older than the key's last save are ignored.

| Pill | Meaning |
|---|---|
| AI active — Key verified | OpenRouter accepted the key |
| AI active — Key not verified | a key is saved but OpenRouter could not be reached just now |
| AI key rejected | OpenRouter answered 401/403 |
| AI provider busy | OpenRouter answered 429 |
| AI replies failing | the key is valid but the latest AI reply failed (model/provider error) |
| AI needs a key / AI off / Test mode | no usable key / switch off / mock providers |

A verified key does not prove the **model** works: the key and the model are separate. If replies fail with a valid key, check the
model under AI Configuration and the account's OpenRouter privacy / data-policy settings.
