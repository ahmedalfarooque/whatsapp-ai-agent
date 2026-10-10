import { describe, expect, it } from 'vitest';
import { isAllowed, specFor } from '../../../src/dashboard/authorize';
import { FEATURES, presetPermissions, levelAtLeast, type AuthUser } from '../../../src/dashboard/permissions';

const base: AuthUser = {
  id: 1, username: 'x@example.com', email: 'x@example.com', displayName: null, role: 'user', isProtected: false, disabled: false,
  allAccounts: false, canConnection: false, canConfiguration: false, createdAt: '', lastLoginAt: null, createdBy: null,
};
const superAdmin: AuthUser = { ...base, id: 2, role: 'super_admin', isProtected: true, allAccounts: true };

describe('permission rule table', () => {
  it('maps methods to levels: reads need view, writes need edit, deletes need manage', () => {
    expect(specFor('GET', '/offers')).toEqual({ t: 'feature', feature: 'offers', level: undefined });
    expect(specFor('DELETE', '/offers/3')).toMatchObject({ t: 'feature', feature: 'offers' });
    expect(specFor('POST', '/templates/main_menu/preview')).toEqual({ t: 'feature', feature: 'menus', level: 'view' });
    expect(specFor('POST', '/customers/4/pause')).toEqual({ t: 'feature', feature: 'support', level: 'edit' });
  });

  it('closes anything that is not listed (deny by default)', () => {
    expect(specFor('GET', '/brand-new-endpoint')).toEqual({ t: 'super' });
    expect(isAllowed({ ...base, role: 'admin', allAccounts: true, canConnection: true, canConfiguration: true }, 'GET', '/brand-new-endpoint', 1)).toBe(false);
    expect(isAllowed(superAdmin, 'GET', '/brand-new-endpoint', 1)).toBe(true);
  });

  it('every feature in the catalogue is protected by at least one rule', () => {
    const covered = new Set<string>();
    for (const path of ['/overview', '/conversations', '/customers', '/requests', '/bookings', '/support-queue', '/offers', '/accounts/1/catalogues', '/documents', '/business-profile', '/templates', '/knowledge', '/notifications', '/automation/activity']) {
      const spec = specFor('GET', path);
      if (spec.t === 'feature') covered.add(spec.feature);
    }
    expect([...covered].sort()).toEqual(FEATURES.map((f) => f.key).sort());
  });

  it('presets: a "user" is read-only, a "manager" edits but never manages, and neither touches configuration', () => {
    const user = presetPermissions('user');
    const manager = presetPermissions('manager');
    expect(Object.values(user).every((l) => l === 'view')).toBe(true);
    expect(Object.values(manager).every((l) => l === 'edit')).toBe(true);
    expect(levelAtLeast(manager.offers, 'manage')).toBe(false);
    expect(levelAtLeast(manager.offers, 'edit')).toBe(true);
    expect(presetPermissions('custom')).toEqual({});
    expect(presetPermissions('admin')).toEqual({});
  });

  it('a disabled super admin has no special rights', () => {
    expect(isAllowed({ ...superAdmin, disabled: true, isProtected: false }, 'GET', '/system', 1)).toBe(false);
  });
});
