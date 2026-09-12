import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

export function PageShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-6xl px-5 py-16">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent2">{eyebrow}</p>
        <h1 className="mt-3 font-display text-4xl font-bold sm:text-5xl">{title}</h1>
        <p className="mt-4 max-w-2xl text-muted">{description}</p>
      </motion.div>
      <div className="mt-12">{children}</div>
    </main>
  );
}
