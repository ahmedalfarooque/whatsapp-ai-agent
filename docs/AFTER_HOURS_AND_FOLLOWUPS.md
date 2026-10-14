# After hours, follow-up requests, reminders and customer media

Everything here applies to **every business** (the original one and every account created later) and is configured **per business**. Nothing is
hard-coded for a particular account; a new account inherits the shared defaults the moment it is created.

## Where it is configured

Business setup → the business → **Business information**:

| Setting | Column (`business_settings`) | Default |
| --- | --- | --- |
| Opens / Closes / Open on / Friday hours / Time zone | `business_hours_*`, `business_days`, `friday_hours_*`, `business_timezone` | not configured (nothing is claimed) |
| Different hours per day / split shifts | `weekly_hours` (JSON `{"1":[["09:00","13:00"],["16:00","21:00"]],…,"7":[]}`) | null = derived from the simple hours |
| Holidays and exceptional closures | `closures` (JSON `[{"from":"2026-12-25","to":…,"label":…}]`) | none |
| Tell customers the business is closed + follow-up choices | `after_hours_enabled` | on |
| Offer "call us now" while open | `direct_call_enabled` (uses `contact_phone`) | on |
| Callback window | `callback_window_minutes` | 30 |
| Reminder lead / repeat / attempts | `reminder_lead_minutes`, `reminder_repeat_minutes`, `reminder_max_attempts` | 0 / 5 / 3 |
| Response-time promise | `response_time_promise` | none (never promised unless set) |
| Appointment / enquiry types | table `account_appointment_types` | Consultation, Service enquiry, Product enquiry, Quotation discussion |
| Audio model for voice notes | `open_router_audio_model` (Providers page → Audio model) | none = voice notes are not transcribed |

The schedule engine is `src/setup/hours.ts` (`isOpenAt`, `nextOpening`, `openIntervalsOn`, closures); hours that were never entered give `null`
answers and the assistant is told to state nothing about opening hours or whether the business is open.

## What the customer experiences outside working hours

Once per conversation window (6 h, persisted in `customers.after_hours_notified_at`, so a restart does not repeat it), right after the
customer's message has been handled normally (menu or assistant answer — ordinary questions are never blocked):

1. `after_hours_notice`: "{business} is currently closed", the opening hours, the next opening ("tomorrow at 9:00 AM"), the response-time
   promise if configured.
2. `followup_menu` (closed) / `followup_menu_open` (open, adds "Call us now: {phone}"):
   1. Request a phone callback → appointment type → saved "as soon as staff are available"
   2. Request a WhatsApp message from staff → appointment type → saved; the customer is told a message was *requested*, never that it was sent
   3. Contact me as soon as staff are available → contact method → appointment type → saved
   4. Choose a callback / appointment time → contact method → type → time (`tomorrow 10am`, `الأحد 5 مساءً`, `2026-10-20 17:30`) → validated
      against the schedule (closed times are refused with the next opening; unreadable text is re-asked) → confirmed with the window
   5. Location, offers and services (self-service; the assistant still answers free text)
   6. Cancel an existing request → the customer's own open requests, numbered → cancelled, reminders stopped
   7. (open only) Call us now with the business phone until closing

   Free text in this menu goes to the assistant; "menu" returns to the main menu; "cancel" from anywhere lists the open requests.
   Every confirmation is sent only **after** the row exists (`followup_requests`); a save failure says so and offers the phone.

Templates (all editable per business in the Manual Reply Editor): `after_hours_notice`, `followup_menu`, `followup_menu_open`,
`followup_method_prompt`, `followup_type_prompt`, `followup_time_prompt`, `followup_time_invalid`, `followup_time_closed`,
`followup_confirm_scheduled`, `followup_confirm_asap_open`, `followup_confirm_asap_closed`, `followup_confirm_whatsapp`,
`followup_cancel_list`, `followup_cancel_none`, `followup_cancelled`, `followup_save_failed`, `followup_direct_call`, `followup_invalid_option`,
and the staff texts `followup_staff_alert|reminder|overdue|eligible`. New placeholders: `{next_open} {when} {method} {type} {types} {requests} {window} {promise}`.

### The assistant answers 24/7; the hours decide the notice and the hand-off (2026-10-14)

Business hours never switch the assistant off: a question at 23:00 gets its answer first (the prompt carries `BUSINESS STATUS NOW: CLOSED
(reopens …)` so the model says so when relevant), then the closed notice and the choices once per window. The hours decide two things only:

* **Asking for a person while closed** ("agent", the menu's "Talk to staff", or the assistant's own hand-off tool) no longer parks the
  customer on a silent staff hold until morning. The customer gets `human_support_closed` ("no one is available right now … back
  {next_open} … the team has been notified") and the follow-up menu; the team gets ONE persistent notification per customer per window
  (`staff_notifications.kind = handoff_after_hours`, number masked); the assistant keeps answering questions. While OPEN the real hand-off is
  unchanged: `human_support`, the hold, staff reply by hand (`out_of_hours` is only sent if the business happens to be closed).
* **The assistant cannot answer** (provider down, credit exhausted, every model refused — see `docs/AI_ASSISTANT.md`): never "something went
  wrong" and never silence. The LOCAL automated reply is sent — `assistant_unavailable_closed` (with `{next_open}`) or
  `assistant_unavailable_open` — plus the follow-up menu, and the menu state waits for a choice; further failures within 10 minutes get the
  short `assistant_unavailable_again` reminder of the choices instead of a repeated closure notice. These texts say they are automated and
  state no business fact beyond the configured hours / next opening. Every choice (callback now, callback at a time, staff WhatsApp message,
  cancel, main menu) completes without any AI call. Only a customer inside a guided request (or with no language yet) still gets the neutral
  `fallback_error`.
* **Duplicates**: a repeated webhook delivery is dropped by the message-id claim; a customer's identical request (same method, same time /
  ASAP, same type) within two minutes returns the existing row — one request, one staff alert, one reminder job.

Legacy note: the old once-only "closed notice forced on every AI failure" path is gone; the notice after a successful answer is unchanged.

## Request lifecycle (`followup_requests`, `src/followups/`)

`pending` (as soon as staff are available, business closed; `eligible_at` = next opening) → `eligible` (actionable now) → `assigned` (a staff
member took it, or opened the dialler) → `completed` | `cancelled`; `scheduled` (agreed time) → `overdue` once the callback window passed
without an outcome. Rescheduling updates the **same** row (never a duplicate active task), cancels its jobs and schedules new ones; cancelling
(customer on WhatsApp, or staff) stops the jobs and closes the notifications. Every change is in `followup_events`. All transitions and the
call window are enforced on the server (`followupService.ts`); the UI only mirrors `actions`/`call` from the API.

**Call customer** = `POST /api/dashboard/followups/:id/call`: allowed only inside the window (`callWindow`), returns a validated `tel:+<E.164>`
URL for the device's ordinary dialler (never a WhatsApp call), records `call_opened` and assigns the request. Opening the dialler is **not** an
outcome: staff record it with Complete (reached / no answer / voicemail / …). A customer known only by a privacy id has no dialable number.

Before the agreed time the action is disabled ("waiting"); from the agreed time for `callback_window_minutes`; afterwards the request is
`overdue` and must be rescheduled or closed with an outcome.

## Staff notifications and reminders

* `staff_notifications` (persistent, per business, optionally per staff member): new request, request ready (business opened), reminder at the
  agreed time (repeated every `reminder_repeat_minutes`, at most `reminder_max_attempts`), overdue. Shown by the dashboard **bell** (polled every
  20 s) and resolved automatically on completion / cancellation / rescheduling, so stale alerts never ring. A notification with `ring` sounds a
  tone (Web Audio) and, when the person allowed it, a system notification — **only while the dashboard is open in a browser**. With the browser
  closed, the channel is the existing WhatsApp staff alert (`notification_outbox`, kind `staff_followup`, to the staff number or the linked number).
* Reminders are rows in `scheduled_jobs` (`src/jobs/scheduler.ts`): durable, idempotent by dedupe key, run every 15 s and shortly after boot,
  re-queued if a crash interrupted them, retried 3 times then marked failed (visible in `GET /followups/:id`).
* The Human Support Queue page shows the follow-up requests (actionable now / scheduled / overdue / completed) with Open conversation, Call
  customer, Reply on WhatsApp, Take it, Complete, Reschedule, Cancel.

## Customer media

| Customer sends | What happens |
| --- | --- |
| Text | answered as before |
| Picture | vision model (`open_router_vision_model`) reads the actual bytes; identification before advice; no guessed model (Camry stays Camry) |
| Voice note / audio | transcribed by the business's audio model when one is configured (`open_router_audio_model`, OpenRouter `input_audio`); the transcript is the customer's message, answered in the spoken language. No model configured → the honest acknowledgement, no transcription claimed |
| PDF with a text layer, DOCX, XLSX, PPTX, TXT/CSV/MD/JSON | text extracted in-process (`src/media/textExtractors.ts`; Office files read as XML inside their ZIP, nothing executed), the first 12 000 characters shown to the assistant as `[DOCUMENT TEXT …]`, answered from it |
| Scanned PDF, DOC/PPT, other files | **not** read (no OCR here): the assistant is told `[DOCUMENT NOT READ …]` and tells the customer what could not be read and what to send instead |
| Video | **not** analysed (no frame/audio extraction here): the assistant says it cannot watch videos and asks for a description or a photo |

Extracted text and transcripts are customer content, never instructions (stated in the prompt and in each context line). Processing status,
model, size and duration are recorded in the activity detail ("voice note transcribed in 2.1 s (model, ar)", "docx read in 0.1 s (1 234 chars)").

## Reply language (shared policy, `src/llm/language.ts`)

1. the language detected in the customer's latest text — or the voice-note transcript / the readable text of their file;
2. else the language the customer selected from the menu;
3. else English.
A business may still set `ai_reply_language` as a deliberate override. Nothing else locks a conversation to one language.
