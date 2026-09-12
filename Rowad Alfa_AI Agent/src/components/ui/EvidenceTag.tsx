import type { Evidence } from '../../data/types';

/** Makes the observed-vs-inferred distinction from the plan visible in the
 * UI itself, rather than only in code comments. */
export function EvidenceTag({ evidence }: { evidence: Evidence }) {
  return evidence === 'observed' ? (
    <span title="Directly seen on the business's public Instagram profile" className="text-[10px] font-mono uppercase tracking-wide text-accent2/80">
      · from Instagram
    </span>
  ) : (
    <span title="A reasonable design inference, not independently verified" className="text-[10px] font-mono uppercase tracking-wide text-muted">
      · inferred
    </span>
  );
}
