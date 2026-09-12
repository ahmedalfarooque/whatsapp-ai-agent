import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../../src/memory/db';
import {
  getBusinessSettings,
  getBusinessSettingsOverrides,
  updateBusinessSettings,
  BusinessSettingsValidationError,
  businessSettingsInputSchema,
} from '../../../src/config/businessSettings';

function resetRow() {
  getDb().prepare('UPDATE business_settings SET business_name = NULL, business_timezone = NULL, business_hours_start = NULL, business_hours_end = NULL, business_days = NULL, booking_duration_minutes = NULL, booking_buffer_minutes = NULL, restart_keywords = NULL, conversation_history_limit = NULL, welcome_message = NULL, fallback_message = NULL, cancellation_policy = NULL, human_escalation_info = NULL, supported_languages = NULL WHERE id = 1').run();
}

describe('businessSettings', () => {
  beforeEach(() => {
    resetRow();
  });

  it('falls back to env defaults when no override row values exist', () => {
    const settings = getBusinessSettings();
    expect(settings.businessName).toBe(process.env.BUSINESS_NAME);
    expect(settings.businessTimezone).toBe(process.env.BUSINESS_TIMEZONE);
  });

  it('reports every field as not-overridden when the row is all-NULL', () => {
    const overrides = getBusinessSettingsOverrides();
    expect(Object.values(overrides).every((v) => v === false)).toBe(true);
  });

  it('prefers a DB value over env once set', () => {
    updateBusinessSettings({ businessName: 'Overridden Name' });
    expect(getBusinessSettings().businessName).toBe('Overridden Name');
    expect(getBusinessSettingsOverrides().businessName).toBe(true);
  });

  it('rejects an invalid IANA timezone and writes nothing', () => {
    expect(() => updateBusinessSettings({ businessTimezone: 'Not/Real' })).toThrow(BusinessSettingsValidationError);
    expect(getBusinessSettingsOverrides().businessTimezone).toBe(false);
  });

  it('rejects malformed HH:mm hours', () => {
    expect(() => updateBusinessSettings({ businessHoursStart: '9am' })).toThrow(BusinessSettingsValidationError);
  });

  it('rejects a non-positive booking duration', () => {
    expect(() => updateBusinessSettings({ bookingDurationMinutes: 0 })).toThrow(BusinessSettingsValidationError);
    expect(() => updateBusinessSettings({ bookingDurationMinutes: -5 })).toThrow(BusinessSettingsValidationError);
  });

  it('persists a valid patch and reflects it immediately with no restart', () => {
    updateBusinessSettings({ bookingDurationMinutes: 45, restartKeywords: 'stop, cancel' });
    const settings = getBusinessSettings();
    expect(settings.bookingDurationMinutes).toBe(45);
    expect(settings.restartKeywords).toEqual(['stop', 'cancel']);
  });

  it('resets a field back to the env fallback when explicitly set to null', () => {
    updateBusinessSettings({ businessName: 'Temporary Override' });
    expect(getBusinessSettingsOverrides().businessName).toBe(true);
    updateBusinessSettings({ businessName: null });
    expect(getBusinessSettingsOverrides().businessName).toBe(false);
    expect(getBusinessSettings().businessName).toBe(process.env.BUSINESS_NAME);
  });

  it('the settings schema never contains a field shaped like a secret', () => {
    const fieldNames = Object.keys(businessSettingsInputSchema.shape);
    for (const name of fieldNames) {
      expect(name).not.toMatch(/secret|token|api[_-]?key|password/i);
    }
  });
});
