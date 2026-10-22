# Media processing: what is protected, and what only the host can protect

Customers send videos, scanned PDFs and documents. They are **untrusted input** handed to tools (FFmpeg, poppler's `pdftoppm`) and parsers that have had security bugs.

## What the code does (src/media)
* **No shell, ever.** `safeExec.ts` starts the tool directly with an argument array; nothing the customer wrote becomes part of a command line.
* **Minimal environment.** The tool receives `PATH`, locale/temp variables and little else. The API keys, `DASHBOARD_MASTER_KEY`, `DATABASE_PATH` and every other variable of the application are *not* passed on, so a compromised tool cannot read them from its environment.
* **Private working directory.** Each job runs inside its own temporary directory (also the process's working directory) that is always removed, with a hard timeout (SIGKILL) and an optional cancel signal.
* **Type checked from the bytes**, not from the file name or MIME type the sender gave: a video must start like an MP4/QuickTime/3GP or Matroska/WebM container, a scanned PDF with `%PDF-`. Playlists, concat scripts, SDP files and renamed files are refused **before** the tool runs.
* **FFmpeg is restricted** to the `file` protocol and to the MP4-family and Matroska/WebM demuxers (`-protocol_whitelist`, `-format_whitelist`), with bounded probing (`-probesize`, `-analyzeduration`), memory (`-max_alloc`) and output size (`-fs`, frame and track caps).
* **Output is verified** before use: frames must be JPEG, the audio WAV, pages PNG, each under a size cap.
* **Honest failure.** A file that cannot be read is reported as not read; the assistant never answers from content it did not see.
* **Scanned PDFs** are transcribed by the vision model (an explicit "copy the text exactly" prompt). There is no OCR engine: the result is labelled as a model transcription that can contain mistakes, partly legible pages are marked, unreadable pages are listed as not read.

## What code cannot do (host requirements)
A protocol whitelist is not a sandbox. To contain a bug in a media tool itself:
1. Run the service as an **unprivileged user** that cannot read other users' files; keep `.env` and the database readable only by that user.
2. Prefer a **container or systemd sandbox** with no outbound network for the media tools (e.g. `PrivateNetwork=yes` for a separate worker, or an egress rule), a read-only application directory, and memory / CPU limits (`MemoryMax=`, `CPUQuota=`).
3. Keep FFmpeg and poppler **patched**. `FFMPEG_PATH` / `PDFTOPPM_PATH` accept a plain path only.

## Verified and not verified
The argument construction, environment stripping, signature checks, cleanup and timeouts are covered by automated tests (`tests/unit/media`). The tests replace FFmpeg and pdftoppm with scripted runners, so the *real* effect of the FFmpeg options on a given FFmpeg build must be confirmed once on the server with a real video (a normal MP4 must still be read) before relying on it.
