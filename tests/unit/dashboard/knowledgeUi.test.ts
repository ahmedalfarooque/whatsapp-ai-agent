import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'dashboard', file), 'utf-8');
const app = read('app.js');
const shell = read('shell.js');

describe('knowledge page and AI pill tell the truth', () => {
  it('both scripts still compile', () => {
    expect(() => new vm.Script(app)).not.toThrow();
    expect(() => new vm.Script(shell)).not.toThrow();
  });

  it('the file status comes from the server state, never from mere existence', () => {
    expect(app).toContain('function knowledgeBadge(f)');
    for (const label of ["'Available'", "'Missing'", "'Not created'", "'Empty'", "'Invalid'", "'Placeholder'"]) expect(app).toContain(label);
    expect(app).not.toMatch(/f\.exists \? badge\('Available'/);
  });

  it('shows why a file is unusable (empty / invalid) and explains optional files', () => {
    expect(app).toContain('function knowledgeHint(f)');
    expect(app).toContain('f.problem');
  });

  it('the editor only opens empty for a file that does not exist: any other read failure must not offer an overwrite', () => {
    const editor = app.slice(app.indexOf("route(/^#\\/knowledge\\/(?<name>"));
    expect(editor).toContain('error.status !== 404');
    expect(editor).toMatch(/error\.status !== 404[\s\S]{0,300}return;/);
    expect(app).toContain('error.status = response.status');
  });

  it('the AI pill says whether the key was verified instead of "Real-time sync"', () => {
    expect(shell).not.toContain('Real-time sync');
    expect(shell).toContain("state.modelVerified ? 'Model verified' : state.verified ? 'Key verified' : 'Key not verified'");
  });
});
