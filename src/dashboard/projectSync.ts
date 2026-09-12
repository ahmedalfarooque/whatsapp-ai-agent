import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/**
 * Read-only view of the .project-sync coordination state for the dashboard.
 * This ONLY reads the existing JSON files the coordination script itself
 * maintains — it never shells out, never writes, and never touches the
 * writer lock. Browser users cannot acquire, release, or otherwise affect
 * the lock through the dashboard.
 */
export interface ProjectSyncView {
  available: boolean;
  writer: { agent: string; session: string; task: string; startedAt?: string } | null;
  lastHandoffSummary: string | null;
  lastHandoffNextSteps: string | null;
  lastHandoffTests: string | null;
  lastHandoffPath: string | null;
  changedFileCount: number | null;
}

function syncDir(): string {
  return path.join(__dirname, '..', '..', '.project-sync');
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function getProjectSyncView(): ProjectSyncView {
  const dir = syncDir();

  if (!fs.existsSync(dir)) {
    return {
      available: false,
      writer: null,
      lastHandoffSummary: null,
      lastHandoffNextSteps: null,
      lastHandoffTests: null,
      lastHandoffPath: null,
      changedFileCount: null,
    };
  }

  const state = readJsonSafe<{
    summary?: string;
    nextSteps?: string;
    tests?: string;
    lastHandoff?: string;
    snapshot?: { files?: Record<string, string> };
  }>(path.join(dir, 'state.json'));

  const writerRaw = readJsonSafe<{ agent?: string; session?: string; task?: string; startedAt?: string }>(
    path.join(dir, 'writer.json'),
  );

  // writer.json persists the last-known writer even after release in some
  // coordination scripts — only treat it as an ACTIVE writer if the file
  // itself signals that (a session id + agent present is the minimum bar
  // this reader relies on; the authoritative lock check remains
  // `node scripts/project-sync.cjs check`, run server-side/CLI, never from
  // the browser).
  const writer =
    writerRaw && writerRaw.session && writerRaw.agent
      ? { agent: writerRaw.agent, session: writerRaw.session, task: writerRaw.task ?? '', startedAt: writerRaw.startedAt }
      : null;

  let changedFileCount: number | null = null;
  if (state?.lastHandoff) {
    const handoffPath = path.join(dir, state.lastHandoff);
    const handoff = readJsonSafe<{ changedFiles?: unknown[] }>(handoffPath);
    if (handoff && Array.isArray(handoff.changedFiles)) {
      changedFileCount = handoff.changedFiles.length;
    }
  }

  if (!state) {
    logger.warn('dashboard: .project-sync/state.json missing or unreadable');
  }

  return {
    available: true,
    writer,
    lastHandoffSummary: state?.summary ?? null,
    lastHandoffNextSteps: state?.nextSteps ?? null,
    lastHandoffTests: state?.tests ?? null,
    lastHandoffPath: state?.lastHandoff ?? null,
    changedFileCount,
  };
}
