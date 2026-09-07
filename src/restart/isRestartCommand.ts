import { env } from '../config/env';

/**
 * Matches a restart/reset command robustly but conservatively: the message
 * must, after trimming/lowercasing punctuation, consist of ONLY a configured
 * keyword (optionally with simple punctuation) — never fires on a keyword
 * used naturally mid-sentence ("can we restart the process next week?").
 */
export function isRestartCommand(text: string | undefined | null): boolean {
  if (!text) return false;

  const normalized = text
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim();

  return env.RESTART_KEYWORDS.includes(normalized);
}
