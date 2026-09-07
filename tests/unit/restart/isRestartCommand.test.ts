import { describe, it, expect } from 'vitest';
import { isRestartCommand } from '../../../src/restart/isRestartCommand';

describe('isRestartCommand', () => {
  it('matches configured keywords case-insensitively', () => {
    expect(isRestartCommand('restart')).toBe(true);
    expect(isRestartCommand('Restart')).toBe(true);
    expect(isRestartCommand('RESET')).toBe(true);
    expect(isRestartCommand('start over')).toBe(true);
  });

  it('tolerates trailing punctuation and surrounding whitespace', () => {
    expect(isRestartCommand('  restart!  ')).toBe(true);
    expect(isRestartCommand('reset.')).toBe(true);
    expect(isRestartCommand('reset?')).toBe(true);
  });

  it('does NOT match a keyword used naturally mid-sentence', () => {
    expect(isRestartCommand('can we restart the process next week?')).toBe(false);
    expect(isRestartCommand('I need to reset my expectations')).toBe(false);
  });

  it('returns false for unrelated messages', () => {
    expect(isRestartCommand('Hi, what are your hours?')).toBe(false);
  });

  it('returns false for empty/undefined input', () => {
    expect(isRestartCommand('')).toBe(false);
    expect(isRestartCommand(undefined)).toBe(false);
    expect(isRestartCommand(null)).toBe(false);
  });
});
