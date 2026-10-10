import { describe, expect, it } from 'vitest';
import { detectHumanHandoffIntent, normalizeIntentText } from '../../../src/handoff/intent';

const asks = (text: string, inGuidedFlow = false) => detectHumanHandoffIntent(text, { inGuidedFlow }).requested;

describe('human handoff intent — customers who ask for a real person', () => {
  it.each([
    // the phrases from the brief
    'I want to speak to a human.',
    'Connect me to an agent',
    'Let me talk to someone',
    'I need a real person',
    'موظف',
    'أريد التحدث إلى موظف',
    'أبغى أكلم شخص',
    'خدمة العملاء',
    'أريد التحدث إلى شخص حقيقي',
    // other natural English
    'can I speak with a real person please',
    'could I talk to somebody from your team',
    'please transfer me to a human agent',
    'I would like to speak to a representative',
    'Get me a human',
    'give me a real person',
    'I need customer service',
    'put me through to a manager',
    "I'd like to talk to your manager",
    'is there a real person I can talk to?',
    "I don't want to talk to a robot",
    "I don't want a bot, I want a human",
    "I'm tired of talking to a bot, let me speak to someone",
    'human please',
    'real person',
    'live agent',
    'I really need to speak to someone about my invoice, this is urgent',
    'Hello, I need to talk to a person at the office about my contract',
    // other natural Arabic (Gulf, Egyptian, MSA)
    'ابغى اكلم موظف',
    'ابي اتكلم مع شخص',
    'أبي أتواصل مع موظف خدمة العملاء',
    'عايز اكلم حد',
    'عاوز اتكلم مع موظف',
    'اريد التحدث مع شخص حقيقي من فضلك',
    'ممكن اكلم احد من الفريق؟',
    'حولني الى موظف',
    'وصلني بمسؤول',
    'لا اريد التحدث الى بوت اريد موظف',
    'اريد انسان وليس روبوت',
    'محتاج اتكلم مع انسان',
    'شخص حقيقي',
    'موظف من فضلك',
  ])('asks for a person: %s', (text) => {
    expect(asks(text), text).toBe(true);
  });

  it('the exact keywords keep working exactly as before, even inside a guided flow', () => {
    for (const word of ['agent', 'human', 'support', 'staff', 'manager', 'موظف', 'خدمة العملاء', 'شكوى']) {
      expect(detectHumanHandoffIntent(word, { inGuidedFlow: true })).toMatchObject({ requested: true, confidence: 'exact' });
    }
    expect(detectHumanHandoffIntent('Agent!')).toMatchObject({ requested: true });
  });

  it('reports which rule decided, and a high confidence for sentences', () => {
    expect(detectHumanHandoffIntent('I need a real person')).toMatchObject({ confidence: 'high', rule: expect.stringMatching(/^en:/) });
    expect(detectHumanHandoffIntent('ابغى اكلم موظف')).toMatchObject({ confidence: 'high', rule: expect.stringMatching(/^ar:/) });
  });
});

describe('human handoff intent — false positives it must NOT produce', () => {
  it.each([
    // talking ABOUT people or staff
    'Your staff were very helpful, thank you',
    'The agent who helped me yesterday was great',
    'I want to thank the manager for the excellent service',
    'The employee at the branch was rude',
    'Is Ahmed the manager of the Jeddah office?',
    'Does your team work on Fridays?',
    'What is the name of the contact person?',
    'He wants to speak to a manager',
    'my brother needs a human resources job',
    'I want to apply for a job as an agent',
    // a service request that merely contains the words
    'I need someone to manage my property',
    'I need a real estate agent to sell my villa',
    'I am looking for an insurance agent',
    'We need a person to value the building',
    'I want to hire a property manager',
    'talk about your staff policy',
    // negated
    "I don't need an agent",
    'I do not want to speak to a human, the bot is fine',
    'no need to connect me to anyone',
    'I will never talk to a manager about this',
    // ordinary questions and menu answers
    'What are your opening hours?',
    'how much does the consultation cost',
    'I want a consultation about ownership structuring',
    'I would like to book an appointment next Sunday',
    'send me the offers',
    'Can I get the price list?',
    'hello',
    '2',
    '',
    // Arabic
    'الموظف كان محترم جدا',
    'اريد ان اشكر الموظف على مساعدته',
    'هل الموظف احمد موجود؟',
    'ما هي ساعات عمل الموظفين',
    'اريد شخص يدير عقاري',
    'اريد استشارة بخصوص هيكلة الملكية',
    'ابغى اعرف الاسعار',
    'لا اريد التحدث مع موظف',
    'اريد التقديم على وظيفة موظف',
    'شكرا لكم',
  ])('does not ask for a person: %s', (text) => {
    expect(asks(text), text).toBe(false);
  });

  it('inside a guided flow only the exact keywords count, so an answer is never mistaken for a request', () => {
    expect(asks('I want to talk to a person about my villa', true)).toBe(false);
    expect(asks('اريد التحدث الى موظف', true)).toBe(false);
    expect(asks('Layla Hassan', true)).toBe(false);
    expect(asks('I want to talk to a person about my villa', false)).toBe(true);
  });

  it('handles empty, whitespace, very long and odd input without throwing', () => {
    expect(asks('   ')).toBe(false);
    expect(asks(undefined as unknown as string)).toBe(false);
    expect(asks('a '.repeat(500))).toBe(false);
    expect(asks('🙂🙂🙂')).toBe(false);
    expect(asks('<script>alert(1)</script> human')).toBe(false);
  });
});

describe('normalizeIntentText', () => {
  it('unifies Arabic letter variants, drops diacritics and punctuation, and removes apostrophes', () => {
    expect(normalizeIntentText('أُريدُ التَّحدُّثَ إلى مُوَظَّفٍ!')).toBe('اريد التحدث الي موظف');
    expect(normalizeIntentText("I don't   want — a bot.")).toBe('i dont want a bot');
    expect(normalizeIntentText('خدمة العملاء؟')).toBe('خدمه العملاء');
  });
});
