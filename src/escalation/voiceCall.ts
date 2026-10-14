/**
 * Can this system place an outbound AI voice call at ZERO cost, with the customer's consent? Honest answer today: NO.
 *
 * The WhatsApp transport is WhatsApp Web (Baileys, a linked device): it can send messages, but it cannot place a call over the SIM / mobile
 * network, and an unofficial linked device must not be driven to ring customers. Every telephony API (Twilio, Vonage, Telnyx, Plivo, ...)
 * charges per minute and per number, and a text-to-speech / speech-recognition voice agent adds model costs; the project forbids any paid
 * service. So the feature stays DISABLED: an escalation records the attempt as 'unavailable' with this exact reason, notifies staff, and
 * never calls anyone. If a verified zero-cost, authorized path ever exists, it is added HERE behind `available`, with a customer-consent check
 * and a configured number, and the rest of the system (records, no repeat calls) already supports it.
 */
export interface VoiceCallCapability {
  available: boolean;
  provider: string | null;
  blockers: string[];
  alternatives: string[];
}

export function voiceCallCapability(): VoiceCallCapability {
  return {
    available: false,
    provider: null,
    blockers: [
      'The WhatsApp connection is WhatsApp Web (a linked device): it cannot place SIM or mobile-network calls.',
      'Every telephony provider that can place a call from a server charges per minute and per number; no paid service is allowed.',
      'No customer consent to an automated voice call is recorded, and no verified zero-cost authorized call path is configured.',
    ],
    alternatives: [
      'Staff are alerted at once (dashboard bell and WhatsApp) and can call the customer from the dashboard (opens the phone dialler, no cost to the system).',
      'The customer already sees the business phone number and can call it directly.',
      'WhatsApp\'s own business calling (Cloud API) is a separate product with its own pricing; it is not used here.',
    ],
  };
}

export interface VoiceCallAttempt { status: 'unavailable' | 'skipped'; detail: string }

/** The one place that would place a call. Today it only reports why it did not: it never calls anyone. */
export function attemptVoiceCall(input: { hasValidNumber: boolean; hasConsent: boolean }): VoiceCallAttempt {
  const capability = voiceCallCapability();
  if (!capability.available) return { status: 'unavailable', detail: capability.blockers[0] ?? 'no zero-cost voice call path is available' };
  if (!input.hasValidNumber) return { status: 'skipped', detail: 'no valid configured number' };
  if (!input.hasConsent) return { status: 'skipped', detail: 'the customer has not consented to a call' };
  return { status: 'skipped', detail: 'no call adapter is implemented' };
}
