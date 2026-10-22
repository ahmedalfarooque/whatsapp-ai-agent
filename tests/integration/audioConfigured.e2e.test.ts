import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { createProvider, providerModelsFor } from '../../src/llm/providerRepo';
import { audioConfigured } from '../../src/llm/audio';
import { updateBusinessSettings } from '../../src/config/businessSettings';

/** Voice notes (and the audio of a video) are transcribed when ANY audio route exists: the business's audio model, or an enabled provider that lists audio models (Gemini). */
describe('is an audio route configured', () => {
  let account: number;
  beforeEach(() => {
    getDb().prepare('DELETE FROM ai_providers').run();
    account = createAccount({ name: `Audio Co ${Math.random()}` }).id;
  });
  const gemini = (audioModels: string[], enabled = true) => createProvider({ name: 'Gemini', kind: 'openai_compatible', adapter: 'gemini', vendor: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaSyAudioConfiguredAudioConfigured0000', models: ['gemini-3.8-flash'], audioModels, enabled, freeConfirmed: true }, { accountId: null, updatedBy: 1 });

  it('no audio model anywhere: not configured (Groq lists none and takes no audio)', () => {
    createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_audioconfiguredaudioconfigured0000', models: ['openai/gpt-oss-20b'], freeConfirmed: true }, { accountId: null, updatedBy: 1 });
    expect(runWithAccount(account, () => audioConfigured())).toBe(false);
  });

  it('a Gemini provider serves audio and pictures with its own chat model even when none is listed for those tasks (native multimodal)', () => {
    const row = gemini([]);
    expect(runWithAccount(account, () => audioConfigured())).toBe(true);
    expect(providerModelsFor(row, 'audio')).toEqual(['gemini-3.8-flash']);
    expect(providerModelsFor(row, 'vision')).toEqual(['gemini-3.8-flash']);
    expect(providerModelsFor({ ...row, vision_models: 'gemini-x' }, 'vision')).toEqual(['gemini-x']); // a listed model wins
    expect(providerModelsFor({ ...row, vendor: 'groq' }, 'vision')).toEqual([]); // other vendors are never assumed to take pictures
  });

  it('an enabled provider listing audio models is enough, a disabled one is not', () => {
    const row = gemini(['gemini-3.8-flash']);
    expect(runWithAccount(account, () => audioConfigured())).toBe(true);
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').run(row.id);
    expect(runWithAccount(account, () => audioConfigured())).toBe(false);
  });

  it('the business audio model setting alone is enough', () => {
    runWithAccount(account, () => updateBusinessSettings({ openRouterAudioModel: 'some/audio-model' }));
    expect(runWithAccount(account, () => audioConfigured())).toBe(true);
    runWithAccount(account, () => updateBusinessSettings({ openRouterAudioModel: null }));
    expect(runWithAccount(account, () => audioConfigured())).toBe(false);
  });
});
