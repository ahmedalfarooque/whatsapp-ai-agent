type IconName = 'speaker' | 'wrench' | 'screen' | 'sparkles' | 'car' | 'phone' | 'pin' | 'instagram';

const paths: Record<IconName, string> = {
  speaker:
    'M9 18V6l8-3v18l-8-3Zm-6-9h4v6H3V9Zm16-2a5 5 0 0 1 0 10',
  wrench:
    'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4L15 12l-3-3 2.7-2.7Z',
  screen: 'M4 5h16v11H4zM9 20h6M12 16v4',
  sparkles: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3ZM19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7L19 15Z',
  car: 'M4 16V9l2-4h12l2 4v7M2 16h20M6 16v2M18 16v2M6.5 12.5h11',
  phone: 'M4 5c0 8.3 6.7 15 15 15l2-4-5-2-1.5 1.5A11.4 11.4 0 0 1 9 10.5L10.5 9 8.5 4 4 5Z',
  pin: 'M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11ZM12 13a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z',
  instagram: 'M4 4h16v16H4zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM16.5 7.5h.01',
};

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
