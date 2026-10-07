import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { knowledgeDirForAccount as resolveKnowledgeDir } from '../knowledge/paths';

export { KNOWLEDGE_ROOT } from '../knowledge/paths';

/**
 * Hard allowlist of editable knowledge files — the ONLY files the dashboard
 * will ever read content from or write to. No arbitrary path, extension, or
 * traversal is ever accepted, regardless of what a request asks for.
 */
export const EDITABLE_KNOWLEDGE_FILES = [
  'business.md',
  'services.md',
  'policies.md',
  'faq.md',
  'ai-knowledge.md',
  'booking.json',
] as const;

export type EditableKnowledgeFile = (typeof EDITABLE_KNOWLEDGE_FILES)[number];

const MAX_FILE_SIZE_BYTES = 200_000; // 200KB — generous for hand-written business text, not a data dump

export function isEditableKnowledgeFile(name: string): name is EditableKnowledgeFile {
  return (EDITABLE_KNOWLEDGE_FILES as readonly string[]).includes(name);
}

/** Where a business's knowledge files live (see src/knowledge/paths.ts); invalid ids become a 400 for the dashboard. */
export function knowledgeDirForAccount(accountId: number = currentAccountId()): string {
  try {
    return resolveKnowledgeDir(accountId);
  } catch {
    throw new KnowledgeFileError('invalid account', 400);
  }
}

function backupDir(accountId: number): string {
  return path.join(knowledgeDirForAccount(accountId), '.backups');
}

export interface KnowledgeFileInfo {
  name: string;
  exists: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export function listKnowledgeFiles(accountId: number = currentAccountId()): KnowledgeFileInfo[] {
  const dir = knowledgeDirForAccount(accountId);
  return EDITABLE_KNOWLEDGE_FILES.map((name) => {
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      return { name, exists: true, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    } catch {
      return { name, exists: false, sizeBytes: null, modifiedAt: null };
    }
  });
}

export class KnowledgeFileError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'KnowledgeFileError';
  }
}

/** Reads one allowlisted knowledge file's content. Throws KnowledgeFileError for anything not on the allowlist. */
export function readKnowledgeFile(name: string, accountId: number = currentAccountId()): { name: string; content: string } {
  if (!isEditableKnowledgeFile(name)) {
    throw new KnowledgeFileError('unknown or unsupported knowledge file', 400);
  }
  const filePath = path.join(knowledgeDirForAccount(accountId), name);
  if (!fs.existsSync(filePath)) {
    throw new KnowledgeFileError('knowledge file does not exist yet', 404);
  }
  return { name, content: fs.readFileSync(filePath, 'utf-8') };
}

/**
 * Safely overwrites one allowlisted knowledge file:
 *   - rejects anything not on the allowlist (no path traversal, no arbitrary
 *     extension, no absolute paths — the filename is matched verbatim
 *     against a fixed list, never interpolated into a path from user input)
 *   - enforces a size limit
 *   - validates JSON files actually parse before writing
 *   - copies the existing file to a timestamped backup before replacing it
 *   - writes atomically (write to a temp file, then rename) so a crash
 *     mid-write can never leave a corrupted/partial file in place
 */
export function writeKnowledgeFile(name: string, content: string, accountId: number = currentAccountId()): { name: string; backedUpAs: string | null } {
  if (!isEditableKnowledgeFile(name)) {
    throw new KnowledgeFileError('unknown or unsupported knowledge file', 400);
  }
  if (typeof content !== 'string') {
    throw new KnowledgeFileError('content must be a string', 400);
  }
  const byteSize = Buffer.byteLength(content, 'utf-8');
  if (byteSize > MAX_FILE_SIZE_BYTES) {
    throw new KnowledgeFileError(`content exceeds the ${MAX_FILE_SIZE_BYTES} byte limit`, 400);
  }
  if (name.endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch {
      throw new KnowledgeFileError('content is not valid JSON', 400);
    }
  }

  const dir = knowledgeDirForAccount(accountId);
  const filePath = path.join(dir, name);
  // Defense in depth: even though `name` is already checked against the
  // allowlist above, confirm the resolved path never escapes the knowledge
  // directory before touching the filesystem.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new KnowledgeFileError('resolved path escapes the knowledge directory', 400);
  }
  fs.mkdirSync(dir, { recursive: true }); // a new account's directory is created on first save

  let backedUpAs: string | null = null;
  if (fs.existsSync(filePath)) {
    fs.mkdirSync(backupDir(accountId), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${name}.${stamp}.bak`;
    fs.copyFileSync(filePath, path.join(backupDir(accountId), backupName));
    backedUpAs = backupName;
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath); // atomic on the same filesystem

  logger.info({ name, backedUpAs, byteSize, account: accountId }, 'dashboard: knowledge file saved');
  return { name, backedUpAs };
}
