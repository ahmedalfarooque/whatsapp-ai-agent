import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env';
import { runTool, type RunTool, type RunToolContext } from './safeExec';

export type { RunTool } from './safeExec';

/**
 * Representative frames and the audio track of a customer's video, taken with FFmpeg when it is installed (env.FFMPEG_PATH, else `ffmpeg` on PATH). The file is
 * UNTRUSTED, so: no shell (arguments are an array, see safeExec.ts) and a minimal environment without this application's secrets; the container type is checked
 * from the file's own signature BEFORE FFmpeg runs (an MP4/MOV/3GP or Matroska/WebM file only — never a playlist or script format that can point at other files or
 * addresses); FFmpeg itself is restricted to the `file` protocol and to those demuxers, its probing, memory and output size are bounded; the input is written under a
 * fixed name in a private temporary directory (also the process's working directory) that is ALWAYS removed; every run has a timeout and can be cancelled; the video,
 * the audio and the number of frames are capped, and what FFmpeg writes is checked before it is used. Without FFmpeg the result says so — nothing is extracted or invented.
 */
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // WhatsApp's own limit for a video message
export const VIDEO_FRAME_INTERVAL_SECONDS = 10;
export const MAX_VIDEO_FRAMES = 4;
export const MAX_VIDEO_AUDIO_SECONDS = 180;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Demuxers FFmpeg may use for a customer's video (the names FFmpeg itself reports): the MP4/QuickTime/3GP family and Matroska/WebM. */
export const ALLOWED_DEMUXERS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm';
const GLOBAL_GUARD = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-max_alloc', String(768 * 1024 * 1024)];
const INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', ALLOWED_DEMUXERS, '-probesize', '5000000', '-analyzeduration', '5000000'];

export type VideoContainer = 'mp4' | 'matroska';
/** The container a file really is, from its first bytes — not from the name or MIME type the sender gave. Null = not a supported video container. */
export function sniffVideoContainer(bytes: Buffer): VideoContainer | null {
  if (bytes.length >= 12) {
    const box = bytes.subarray(4, 8).toString('latin1');
    if (box === 'ftyp' || box === 'moov' || box === 'mdat' || box === 'wide' || box === 'free' || box === 'skip' || box === 'pnot') return 'mp4';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'matroska';
  return null;
}

export type VideoExtraction =
  | { ok: true; frames: Array<{ atSeconds: number; bytes: Buffer }>; audio: Buffer | null }
  | { ok: false; reason: 'ffmpeg_unavailable' | 'too_large' | 'empty' | 'unsupported_format' | 'failed' };

export interface ExtractVideoOptions { run?: RunTool; ffmpeg?: string; timeoutMs?: number; signal?: AbortSignal }

const isJpeg = (b: Buffer): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWav = (b: Buffer): boolean => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE';

export async function extractVideo(bytes: Buffer, options: ExtractVideoOptions = {}): Promise<VideoExtraction> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_VIDEO_BYTES) return { ok: false, reason: 'too_large' };
  if (!sniffVideoContainer(bytes)) return { ok: false, reason: 'unsupported_format' };
  const run = options.run ?? runTool;
  const bin = options.ffmpeg ?? (env.FFMPEG_PATH || 'ffmpeg');
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!(await run(bin, ['-hide_banner', '-version'], 10_000)).ok) return { ok: false, reason: 'ffmpeg_unavailable' };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-video-'));
  const context: RunToolContext = { cwd: dir, signal: options.signal };
  try {
    const input = path.join(dir, 'input.bin');
    await fs.writeFile(input, bytes, { mode: 0o600 });
    const audioFile = path.join(dir, 'audio.wav');
    await run(bin, [...GLOBAL_GUARD, ...INPUT_GUARD, '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', String(MAX_VIDEO_AUDIO_SECONDS), '-fs', String(MAX_AUDIO_BYTES), '-y', audioFile], timeoutMs, context);
    await run(bin, [...GLOBAL_GUARD, ...INPUT_GUARD, '-i', input, '-an', '-vf', `fps=1/${VIDEO_FRAME_INTERVAL_SECONDS},scale=768:-2`, '-frames:v', String(MAX_VIDEO_FRAMES), '-q:v', '5', '-y', path.join(dir, 'frame_%02d.jpg')], timeoutMs, context);
    const audio = await fs.readFile(audioFile).then((b) => (b.length > 1000 && b.length <= MAX_AUDIO_BYTES && isWav(b) ? b : null), () => null);
    const frames: Array<{ atSeconds: number; bytes: Buffer }> = [];
    const names = (await fs.readdir(dir)).filter((n) => /^frame_\d+\.jpg$/.test(n)).sort().slice(0, MAX_VIDEO_FRAMES);
    for (const [i, name] of names.entries()) {
      const frame = await fs.readFile(path.join(dir, name));
      if (frame.length <= MAX_FRAME_BYTES && isJpeg(frame)) frames.push({ atSeconds: i * VIDEO_FRAME_INTERVAL_SECONDS, bytes: frame });
    }
    if (frames.length === 0 && !audio) return { ok: false, reason: 'failed' };
    return { ok: true, frames, audio };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
