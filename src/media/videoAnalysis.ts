import { analyzeImage, type ImageAnalysis, type AnalyzeImageInput } from '../llm/vision';
import { transcribeAudio, type AudioTranscription, type TranscribeAudioInput } from '../llm/audio';
import { videoAnalysisLine, videoContextLine, type VideoFindings } from '../llm/mediaContext';
import { extractVideo, MAX_VIDEO_BYTES, type VideoExtraction } from './videoFrames';

/**
 * A customer's video, examined for real or not at all: representative frames go to the vision model, the audio track to the transcription model (when the
 * business has one), and the answer is built ONLY from what those returned, with timestamps. A part that failed is listed as not examined; a video of which
 * nothing could be examined says so and nothing else — the assistant is never told it watched a video it did not.
 */
export const VIDEO_MIME_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm']);

export interface VideoAnalysisInput {
  mimeType: string;
  fileLength?: number | null;
  download: () => Promise<Buffer>;
  caption?: string | null;
  /** True when this business has an audio model configured (the audio track is transcribed only then). */
  transcribeSpeech: boolean;
  deadline?: number;
}
export interface VideoAnalysisDeps {
  extract: (bytes: Buffer) => Promise<VideoExtraction>;
  analyze: (input: AnalyzeImageInput) => Promise<ImageAnalysis>;
  transcribe: (input: TranscribeAudioInput) => Promise<AudioTranscription>;
}
const realDeps: VideoAnalysisDeps = { extract: (bytes) => extractVideo(bytes), analyze: analyzeImage, transcribe: transcribeAudio };
let activeDeps: VideoAnalysisDeps = realDeps;
/** Tests replace the tools (FFmpeg, the vision and audio models) with scripted ones; null restores the real ones. */
export function setVideoDepsForTests(deps: VideoAnalysisDeps | null): void { activeDeps = deps ?? realDeps; }

export interface VideoAnalysisResult {
  /** True only when at least one part (a frame or the speech) was really examined. */
  ok: boolean;
  /** The text stored beside the customer's message for the assistant. */
  line: string;
  /** A short staff-facing note. */
  note: string;
  reason?: string;
  transcript: { text: string; language: string | null } | null;
  frames: number;
}

const notAnalysed = (reason: string, why: string): VideoAnalysisResult => ({ ok: false, line: videoContextLine(why), note: `video not analysed (${reason})`, reason, transcript: null, frames: 0 });

export async function analyseVideo(input: VideoAnalysisInput, deps: VideoAnalysisDeps = activeDeps): Promise<VideoAnalysisResult> {
  const mime = input.mimeType.toLowerCase().split(';')[0]!.trim();
  if (!VIDEO_MIME_TYPES.has(mime)) return notAnalysed('unsupported_format', 'this video format cannot be read here');
  if (input.fileLength && input.fileLength > MAX_VIDEO_BYTES) return notAnalysed('too_large', 'the video is too large to examine');
  let bytes: Buffer;
  try { bytes = await input.download(); } catch { return notAnalysed('download_failed', 'the video could not be downloaded'); }
  const extracted = await deps.extract(bytes);
  if (!extracted.ok) {
    if (extracted.reason === 'ffmpeg_unavailable') return notAnalysed('ffmpeg_unavailable', 'videos are not analysed here (the frame and audio extraction tool is not installed)');
    return notAnalysed(extracted.reason, extracted.reason === 'too_large' ? 'the video is too large to examine' : 'no frames or audio could be taken from this video');
  }
  const findings: VideoFindings = { transcript: null, frames: [], notExamined: [] };
  for (const frame of extracted.frames) {
    if (input.deadline && Date.now() > input.deadline) { findings.notExamined.push(`the frame at ${frame.atSeconds}s (time ran out)`); continue; }
    const result = await deps.analyze({ mimeType: 'image/jpeg', fileLength: frame.bytes.length, download: async () => frame.bytes, caption: input.caption ?? null, deadline: input.deadline });
    if (result.ok) findings.frames.push({ atSeconds: frame.atSeconds, report: result.report });
    else findings.notExamined.push(`the frame at ${frame.atSeconds}s (${result.reason})`);
  }
  if (extracted.audio) {
    if (!input.transcribeSpeech) findings.notExamined.push('the spoken audio (no audio model is configured for this business)');
    else {
      const audio = extracted.audio;
      const heard = await deps.transcribe({ mimeType: 'audio/wav', fileLength: audio.length, download: async () => audio, deadline: input.deadline });
      if (heard.ok) findings.transcript = { text: heard.text, language: heard.language };
      else findings.notExamined.push(`the spoken audio (${heard.reason})`);
    }
  } else findings.notExamined.push('the spoken audio (the video has no readable audio track)');
  const examined = findings.frames.length > 0 || findings.transcript !== null;
  if (!examined) return { ...notAnalysed('nothing_examined', `nothing in it could be examined: ${findings.notExamined.join('; ')}`), reason: 'nothing_examined' };
  return {
    ok: true,
    line: videoAnalysisLine(findings),
    note: `video examined: ${findings.frames.length} frame(s)${findings.transcript ? ', speech transcribed' : ''}${findings.notExamined.length ? `, not examined: ${findings.notExamined.length}` : ''}`,
    transcript: findings.transcript,
    frames: findings.frames.length,
  };
}
