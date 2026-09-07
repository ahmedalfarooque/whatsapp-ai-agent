import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadKnowledgeBase } from '../../../src/knowledge/loader';

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures', 'knowledge');

describe('loadKnowledgeBase', () => {
  it('loads markdown and json files into prompt-ready text', () => {
    const kb = loadKnowledgeBase(FIXTURES_DIR);
    expect(kb.sections.map((s) => s.fileName).sort()).toEqual(['pricing.json', 'services.md']);
    expect(kb.asPromptText).toContain('Test Consultation');
    expect(kb.asPromptText).toContain('"consultation": 50');
  });

  it('returns an empty knowledge base for a non-existent directory (no crash)', () => {
    const kb = loadKnowledgeBase(path.join(FIXTURES_DIR, 'does-not-exist'));
    expect(kb.sections).toEqual([]);
    expect(kb.asPromptText).toBe('');
  });
});
