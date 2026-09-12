import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface ButtonProps {
  children: ReactNode;
  to?: string;
  href?: string;
  variant?: 'primary' | 'secondary';
}

export function Button({ children, to, href, variant = 'primary' }: ButtonProps) {
  const classes =
    variant === 'primary'
      ? 'bg-accent-gradient text-base font-semibold hover:opacity-90'
      : 'border border-line text-ink hover:border-accent/60 hover:text-accent2';

  const base = `inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm transition ${classes}`;

  if (to) {
    return (
      <Link to={to} className={base}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={base}>
        {children}
      </a>
    );
  }
  return <button className={base}>{children}</button>;
}
