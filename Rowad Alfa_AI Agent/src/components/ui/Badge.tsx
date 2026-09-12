import type { ReactNode } from 'react';

export function Badge({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'offer' | 'muted' }) {
  const toneClasses = {
    accent: 'bg-accent/15 text-accent2 border-accent/30',
    offer: 'bg-offer/15 text-offer border-offer/40',
    muted: 'bg-panel2 text-muted border-line',
  }[tone];

  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-mono uppercase tracking-wide ${toneClasses}`}>
      {children}
    </span>
  );
}
