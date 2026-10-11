import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyKnowledgeText, renderKnowledgeForPrompt, PLACEHOLDER_MARKER } from '../../../src/knowledge/quality';
import { loadKnowledgeBase } from '../../../src/knowledge/loader';
import { listKnowledgeFiles } from '../../../src/dashboard/knowledgeAdmin';

// The real files of the original business, as found in production: a test placeholder, example policies, an example booking file.
const FAQ_TEST_PLACEHOLDER = '# FAQ\n\nUpdated by a dashboard test.\n';
const POLICIES_EXAMPLE = '<!-- EXAMPLE / PLACEHOLDER CONTENT — replace with your real policies. -->\n\n# Policies (EXAMPLE)\n\n- **Cancellations:** Please give at least 24 hours notice to cancel or\n  reschedule an appointment.\n- **Payment:** Payment is due at the time of service.\n';
const BOOKING_EXAMPLE = '{\n  "_comment": "EXAMPLE / PLACEHOLDER — informational only. Actual booking duration comes from environment variables.",\n  "servicesRequiringBooking": ["Example Consultation","Example Deep Dive"]\n}\n';
const BUSINESS_REAL = '# About The Business\n\n**Name:** Rowad Alfa Auto Care\n**What we do:** Rowad Alfa Auto Care serves car audio, car accessories, and car care customers.\n**Phone:** +966 55 819 0545\n';
const SERVICES_HONEST_UNKNOWN = '# Services & Pricing\n\nRowad Alfa Auto Care offers services in three categories. Specific item-level services and prices have not been supplied yet.\n';
const GENERATED_PLACEHOLDER = `<!-- setup:begin v1 hash=aaaaaaaaaa -->\n${PLACEHOLDER_MARKER}\n## Policies\nNo policies have been provided for this business yet.\n<!-- setup:end -->\n`;

describe('classifyKnowledgeText', () => {
  it('flags test placeholders, example content and generated placeholders — and nothing real', () => {
    expect(classifyKnowledgeText('faq.md', FAQ_TEST_PLACEHOLDER)).toMatchObject({ quality: 'placeholder' });
    expect(classifyKnowledgeText('policies.md', POLICIES_EXAMPLE)).toMatchObject({ quality: 'example' });
    expect(classifyKnowledgeText('booking.json', BOOKING_EXAMPLE)).toMatchObject({ quality: 'example' });
    expect(classifyKnowledgeText('policies.md', GENERATED_PLACEHOLDER)).toMatchObject({ quality: 'placeholder' });
    expect(classifyKnowledgeText('business.md', BUSINESS_REAL).quality).toBe('verified');
    expect(classifyKnowledgeText('services.md', SERVICES_HONEST_UNKNOWN).quality).toBe('verified'); // an honest "not supplied yet" statement is not example text
  });

  it('only a template marking itself (comment or heading) counts as example: a sentence that says "example" does not', () => {
    const real = '# FAQ\n\nQ: Do you offer a free quote?\nA: Yes, for example for window tinting we quote on the spot after inspecting the car.\n';
    expect(classifyKnowledgeText('faq.md', real).quality).toBe('verified');
    expect(classifyKnowledgeText('faq.md', '# FAQ (EXAMPLE)\nQ: Do you offer a free quote? A: Yes, we quote on the spot.').quality).toBe('example');
  });

  it('valid JSON without an example comment is verified', () => {
    expect(classifyKnowledgeText('booking.json', '{"servicesRequiringBooking":["Colour consultation"]}').quality).toBe('verified');
  });
});

describe('what the assistant is given', () => {
  it('verified text passes through without markup comments; anything else is fenced with a NOT VERIFIED warning', () => {
    const real = renderKnowledgeForPrompt('business.md', `<!-- setup:begin v1 hash=bbbbbbbbbb -->\n${BUSINESS_REAL}<!-- setup:end -->`);
    expect(real).toContain('Rowad Alfa Auto Care');
    expect(real).not.toMatch(/<!--|NOT VERIFIED/);
    for (const [name, text] of [['faq.md', FAQ_TEST_PLACEHOLDER], ['policies.md', POLICIES_EXAMPLE], ['policies.md', GENERATED_PLACEHOLDER]] as const) {
      const rendered = renderKnowledgeForPrompt(name, text);
      expect(rendered.startsWith('[NOT VERIFIED')).toBe(true);
      expect(rendered).toMatch(/never state it to a customer/);
    }
  });

  describe('through the loader and the Knowledge list (one verdict for both)', () => {
    let dir: string;
    const saved = process.env.KNOWLEDGE_LEGACY_DIR;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-quality-'));
      process.env.KNOWLEDGE_LEGACY_DIR = dir;
      fs.writeFileSync(path.join(dir, 'business.md'), BUSINESS_REAL);
      fs.writeFileSync(path.join(dir, 'faq.md'), FAQ_TEST_PLACEHOLDER);
      fs.writeFileSync(path.join(dir, 'policies.md'), POLICIES_EXAMPLE);
      fs.writeFileSync(path.join(dir, 'booking.json'), BOOKING_EXAMPLE);
    });
    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.KNOWLEDGE_LEGACY_DIR;
      else process.env.KNOWLEDGE_LEGACY_DIR = saved;
    });

    it('the prompt text marks the example policies, the test FAQ and the example booking file as not verified, and keeps the real business file clean', () => {
      const kb = loadKnowledgeBase(dir);
      const by = Object.fromEntries(kb.sections.map((s) => [s.fileName, s.content]));
      expect(by['business.md']).not.toContain('NOT VERIFIED');
      expect(by['faq.md']).toContain('NOT VERIFIED');
      expect(by['policies.md']).toContain('NOT VERIFIED');
      expect(by['booking.json']).toContain('NOT VERIFIED');
      expect(kb.asPromptText).not.toContain('<!--');
    });

    it('the Knowledge list reports the same files as placeholders with the reason', () => {
      const files = Object.fromEntries(listKnowledgeFiles(1).map((f) => [f.name, f]));
      expect(files['business.md']).toMatchObject({ state: 'available', placeholder: false });
      expect(files['faq.md']).toMatchObject({ state: 'available', placeholder: true });
      expect(files['policies.md']).toMatchObject({ placeholder: true, placeholderReason: expect.stringContaining('example') });
      expect(files['booking.json']).toMatchObject({ placeholder: true });
      expect(files['services.md']).toMatchObject({ state: 'missing', placeholder: false });
    });
  });
});
