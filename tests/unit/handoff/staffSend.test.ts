import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn() };
});

import { sendTextMessage } from '../../../src/whatsapp/client';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount, currentAccountId } from '../../../src/accounts/accountContext';
import { sendStaffText } from '../../../src/whatsapp/staffSend';
import { NotConnectedError } from '../../../src/notifications/outbox';
import { getConnection } from '../../../src/whatsapp/qrConnection';

/**
 * How a staff reply leaves: through the linked-device (QR/Baileys) socket of the SAME account, or the Cloud API for a Meta account.
 * No session is created, touched or re-paired by these tests (the QR object is only asked to send and refuses: it has no socket).
 */
let QR: number;
let META: number;

beforeAll(() => {
  getDb();
  QR = createAccount({ name: 'Staff Send QR', connectionMethod: 'qr' }).id;
  META = createAccount({ name: 'Staff Send Meta', connectionMethod: 'meta' }).id;
});

beforeEach(() => {
  vi.mocked(sendTextMessage).mockReset().mockImplementation(async () => ({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'graph-1' }] }));
});

describe('sendStaffText', () => {
  it('a QR account without a live socket refuses with NotConnectedError — it never pretends to send, and never starts a connection or a QR', async () => {
    await expect(sendStaffText(QR, { wa_id: '966500000001', reply_jid: null }, 'hello')).rejects.toBeInstanceOf(NotConnectedError);
    expect(getConnection(QR).status().phase).not.toBe('connected');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('a QR account sends through ITS OWN connection, to the address the customer last wrote from (an opaque @lid is kept as is)', async () => {
    const send = vi.spyOn(getConnection(QR), 'send').mockResolvedValue('baileys-id-1');
    const id = await sendStaffText(QR, { wa_id: '966500000001', reply_jid: '1234567890123@lid' }, 'hello');
    expect(id).toBe('baileys-id-1');
    expect(send).toHaveBeenCalledWith('1234567890123@lid', 'hello');
    await sendStaffText(QR, { wa_id: '966500000002', reply_jid: null }, 'hi'); // nothing better known: the phone address
    expect(send).toHaveBeenLastCalledWith('966500000002@s.whatsapp.net', 'hi');
    send.mockRestore();
  });

  it('another account\'s connection is never used', async () => {
    const own = vi.spyOn(getConnection(QR), 'send').mockResolvedValue('x');
    const legacy = vi.spyOn(getConnection(1), 'send').mockResolvedValue('y');
    await sendStaffText(QR, { wa_id: '966500000003', reply_jid: null }, 'hi');
    expect(own).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    own.mockRestore();
    legacy.mockRestore();
  });

  it('a Meta Cloud API account sends through the existing Graph sender, inside that account\'s context', async () => {
    let seenAccount = 0;
    vi.mocked(sendTextMessage).mockImplementation(async () => { seenAccount = currentAccountId(); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'graph-9' }] }; });
    const id = await runWithAccount(1, () => sendStaffText(META, { wa_id: '966500000004', reply_jid: null }, 'hello'));
    expect(id).toBe('graph-9');
    expect(sendTextMessage).toHaveBeenCalledWith('966500000004', 'hello');
    expect(seenAccount).toBe(META);
  });

  it('an unknown account is refused', async () => {
    await expect(sendStaffText(987654, { wa_id: '1', reply_jid: null }, 'x')).rejects.toThrow(/does not exist/);
  });
});
