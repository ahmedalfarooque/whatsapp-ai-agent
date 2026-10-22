import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Representative frames and the audio track of a customer's video, taken with FFmpeg when it is installed (FFMPEG_PATH, else `ffmpeg` on PATH). No shell is
 * involved (arguments are an array), the input is written under a fixed name in a private temporary directory that is ALWAYS removed, every run has a timeout,
 * and the video, the audio and the number of frames are capped. Without FFmpeg the result says so — nothing is extracted or invented.
 */
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // WhatsApp's own limit for a video message
export const VIDEO_FRAME_INTERVAL_SECONDS = 10;
export const MAX_VIDEO_FRAMES = 4;
export const MAX_VIDEO_AUDIO_SECONDS = 180;

export type RunTool = (bin: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean }>;
const defaultRun: RunTool = (bin, args, timeoutMs) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (error) => resolve({ ok: !error }));
});

export type VideoExtraction =
  | { ok: true; frames: Array<{ atSeconds: number; bytes: Buffer }>; audio: Buffer | null }
  | { ok: false; reason: 'ffmpeg_unavailable' | 'too_large' | 'empty' | 'failed' };

export interface ExtractVideoOptions { run?: RunTool; ffmpeg?: string; timeoutMs?: number }

export async function extractVideo(bytes: Buffer, options: ExtractVideoOptions = {}): Promise<VideoExtraction> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_VIDEO_BYTES) return { ok: false, reason: 'too_large' };
  const run = options.run ?? defaultRun;
  const bin = options.ffmpeg ?? (process.env.FFMPEG_PATH?.trim() || 'ffmpeg');
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!(await run(bin, ['-hide_banner', '-version'], 10_000)).ok) return { ok: false, reason: 'ffmpeg_unavailable' };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-video-'));
  try {
    const input = path.join(dir, 'input.bin');
    await fs.writeFile(input, bytes, { mode: 0o600 });
    const audioFile = path.join(dir, 'audio.wav');
    await run(bin, ['-nostdin', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', String(MAX_VIDEO_AUDIO_SECONDS), '-y', audioFile], timeoutMs);
    await run(bin, ['-nostdin', '-v', 'error', '-i', input, '-an', '-vf', `fps=1/${VIDEO_FRAME_INTERVAL_SECONDS},scale=768:-2`, '-frames:v', String(MAX_VIDEO_FRAMES), '-q:v', '5', '-y', path.join(dir, 'frame_%02d.jpg')], timeoutMs);
    const audio = await fs.readFile(audioFile).then((b) => (b.length > 1000 ? b : null), () => null);
    const frames: Array<{ atSeconds: number; bytes: Buffer }> = [];
    const names = (await fs.readdir(dir)).filter((n) => /^frame_\d+\.jpg$/.test(n)).sort().slice(0, MAX_VIDEO_FRAMES);
    for (const [i, name] of names.entries()) frames.push({ atSeconds: i * VIDEO_FRAME_INTERVAL_SECONDS, bytes: await fs.readFile(path.join(dir, name)) });
    if (frames.length === 0 && !audio) return { ok: false, reason: 'failed' };
    return { ok: true, frames, audio };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
