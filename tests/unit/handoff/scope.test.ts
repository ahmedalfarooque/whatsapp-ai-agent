import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Notification delivery is a separate, later task. This guard keeps the handoff feature to its lifecycle: no new alert channel,
 * provider or dependency may creep in through it.
 */
const ROOT = path.join(__dirname, '..', '..', '..');
const FILES = [
  'src/handoff/intent.ts',
  'src/handoff/handoffRepo.ts',
  'src/handoff/staffReply.ts',
  'src/dashboard/handoffRoutes.ts',
  'src/whatsapp/staffSend.ts',
  'src/tools/requestHumanHandoff.ts',
];

describe('human handoff stays inside its scope', () => {
  it('adds no notification, SMS, call, push, e-mail or chat-alert code and no provider', () => {
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      expect(source, file).not.toMatch(/enqueueNotification|flushOutbox|notifyBusiness|registerOutboxSender|twilio|nodemailer|sendgrid|resend|web-push|webpush|telegram|vonage|messagebird|Notification\(|sms/i);
      // the only thing taken from the notifications folder is an error class used to recognise a disconnected number
      for (const line of source.split('\n').filter((l) => /from '.*notifications/.test(l))) expect(line, file).toContain('NotConnectedError');
    }
  });

  it('adds no dependency to the project', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
    for (const name of Object.keys(pkg.dependencies)) expect(name).not.toMatch(/twilio|nodemailer|sendgrid|web-push|telegram|vonage|messagebird|pusher|firebase/i);
  });

  it('the dashboard handoff pages say nothing about alerts being sent', () => {
    const page = fs.readFileSync(path.join(ROOT, 'dashboard', 'pages-automation.js'), 'utf-8');
    expect(page).toContain('Notifications are not part of this screen');
  });
});
