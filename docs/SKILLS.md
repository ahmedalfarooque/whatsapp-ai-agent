# Skills: services the AI assistant can offer customers

A **skill** is a short, reviewed instruction file that tells the assistant how to handle one kind of customer request (a quotation request, a complaint, a catalogue lookup). Skills belong to the **application** (the repository's `skills/` folder), and each **business** switches them on or off for itself. This is not the same thing as the skills used by Claude Code to develop the project.

## What a skill is (and is not)
* A Markdown file `skills/<id>/SKILL.md`: a header between two `---` lines, then plain instructions. See `skills/quote-request-helper/SKILL.md`.
* **Data, never code.** Nothing in it is executed, imported or evaluated. It can only ask for tools from a short read-only list (`search_catalogues`, `web_search`, `check_availability`, `search_real_estate_projects`, `request_human_handoff`). Tools that change something or reach a customer on their own (booking, saving a lead, sending a brochure) **cannot** be granted to a skill.
* Header keys: `name`, `description` (required); `triggers` (phrases that may select it automatically), `tools`, `requires_feature` (`catalogues` or `real_estate`), `default_enabled` (default `false`), `version`.
* The id is the directory name (`a-z`, digits, hyphens). A file that does not validate is reported on the Skills page and is not available.

## Where it comes from
Only the one trusted directory: `skills/` beside the application, or the directory named by `SKILLS_DIR`. Links are never followed, nothing outside that directory is read, and nothing is loaded from the database, an upload or a customer message. Adding a skill = adding a reviewed file through Git and releasing it like any other change.

## Using it (dashboard)
**Skills** (sidebar, under Knowledge & AI). Needs the *AI knowledge & settings* permission: **view** to see, **edit** to switch a skill on or off. Each business has its own switches; switching one on never affects another business. Details show what the skill does, what it may use, the exact instructions, and recent use. A skill that needs an add-on the business does not have shows as *Not available* and cannot be switched on.

## How it takes part in a conversation
Decided **before** the model is called, from the customer's text, with no extra model call:
1. **Explicit**: a message starting with `/<skill-id>` (or `#<skill-id>`) of a skill the business has switched on.
2. **Automatic**: a message containing a trigger phrase of exactly **one** switched-on skill (Arabic letter variants and punctuation are folded). If two skills match equally, neither is used.
3. Otherwise nothing changes: the assistant answers exactly as before. A skill that is off, missing or needs a missing add-on is never selected; asking for it by name makes the assistant say the service is not available.

Only the selected skill's instructions enter the prompt, and while it is active the assistant is offered **only the tools that skill lists** (plus the hand-over to a person). The agent loop enforces this on the server: a tool outside the list is refused even if the model asks for it. The instructions never override the assistant's honesty and fact rules.

## Safety and audit
* Duplicate WhatsApp deliveries are discarded before the AI turn (the webhook event claim), so a skill never runs twice for one message.
* Each use writes one audit row (`skill_runs`): skill, how chosen, result, tools used, a short reason code. It never stores the customer's text, the answer or an error message.
* A provider failure ends the turn with the normal neutral fallback; the run is recorded as failed.

## Storage and release
Migration `034_skills.sql` adds `account_skills` (a business's choice) and `skill_runs`. Additive; an older build ignores both. Deleting a business removes its rows. The `skills/` folder is copied into the Docker image.
