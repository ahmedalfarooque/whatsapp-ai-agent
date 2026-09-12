/** Original, generated visual compositions — never a copy of an Instagram
 * photo (Plan §10 / §15). Pure SVG/gradient art, parameterized by a seed
 * so different sections get visually distinct but consistent artwork. */
const palettes = [
  ['#3B82F6', '#22D3EE'],
  ['#22D3EE', '#3B82F6'],
  ['#EF4444', '#3B82F6'],
  ['#3B82F6', '#8B5CF6'],
];

export function VisualConcept({ seed = 0, className = '' }: { seed?: number; className?: string }) {
  const [from, to] = palettes[seed % palettes.length];
  const gradId = `vc-grad-${seed}`;
  const glowId = `vc-glow-${seed}`;

  return (
    <svg
      viewBox="0 0 400 300"
      className={`h-full w-full ${className}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={from} stopOpacity="0.55" />
          <stop offset="100%" stopColor={to} stopOpacity="0.15" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="30%" r="70%">
          <stop offset="0%" stopColor={to} stopOpacity="0.5" />
          <stop offset="100%" stopColor={to} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="300" fill="#0B0D12" />
      <rect width="400" height="300" fill={`url(#${glowId})`} />
      <g opacity="0.9">
        <path
          d={`M ${20 + seed * 15} 220 Q 120 ${140 - seed * 10} 220 190 T 380 ${160 + seed * 8}`}
          stroke={`url(#${gradId})`}
          strokeWidth="60"
          fill="none"
          strokeLinecap="round"
        />
      </g>
      <g stroke={to} strokeOpacity="0.35" strokeWidth="1">
        {Array.from({ length: 6 }).map((_, i) => (
          <line key={i} x1={0} y1={40 + i * 40} x2={400} y2={40 + i * 40} />
        ))}
      </g>
      <circle cx={90 + seed * 30} cy={90} r="26" fill="none" stroke={from} strokeWidth="2" opacity="0.6" />
      <circle cx={90 + seed * 30} cy={90} r="10" fill={from} opacity="0.8" />
    </svg>
  );
}
