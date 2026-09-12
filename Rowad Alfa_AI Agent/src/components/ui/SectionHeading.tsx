import { motion } from 'framer-motion';

export function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="max-w-2xl"
    >
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent2">{eyebrow}</p>
      <h2 className="mt-3 font-display text-3xl font-bold text-ink sm:text-4xl">{title}</h2>
      {description && <p className="mt-4 text-muted">{description}</p>}
    </motion.div>
  );
}
