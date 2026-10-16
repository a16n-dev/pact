const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
} as const;

export function AlertCircleIcon() {
  return (
    <svg {...base} stroke='var(--hz-red)'>
      <circle cx='12' cy='12' r='9' />
      <path d='M12 8v5' />
      <path d='M12 16.5v.01' />
    </svg>
  );
}

export function WarningIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} stroke='var(--hz-yellow)'>
      <path d='M12 3l9.5 17h-19z' />
      <path d='M12 10v4' />
      <path d='M12 17v.01' />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base} width={16} height={16}>
      <path d='M6 6l12 12M18 6L6 18' />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...base} width={16} height={16}>
      <rect x='9' y='9' width='11' height='11' rx='2' />
      <path d='M5 15V6a2 2 0 0 1 2-2h9' />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg {...base} width={20} height={20}>
      <path d='M8 7l-5 5 5 5' />
      <path d='M16 7l5 5-5 5' />
    </svg>
  );
}

export function UserIcon() {
  return (
    <svg {...base} width={20} height={20}>
      <circle cx='12' cy='8' r='4' />
      <path d='M4 21a8 8 0 0 1 16 0' />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg {...base}>
      <rect x='3' y='5' width='18' height='14' rx='2' />
      <circle cx='9' cy='10' r='1.5' />
      <path d='M21 16l-5-5-8 8' />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg {...base}>
      <path d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' />
      <path d='M14 3v5h5' />
    </svg>
  );
}
