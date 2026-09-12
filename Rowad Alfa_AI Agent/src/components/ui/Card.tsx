import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
      whileHover={{ y: -4 }}
      className={`rounded-2xl border border-line bg-panel p-6 shadow-lg shadow-black/20 ${className}`}
    >
      {children}
    </motion.div>
  );
}
