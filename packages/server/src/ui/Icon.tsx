import { jsx } from 'hono/jsx';
import type { IconNode } from 'lucide';

type IconProps = { icon: IconNode; size?: number; color?: string };

// Renders a lucide icon node (https://lucide.dev/guide/packages/lucide) as inline SVG.
export function Icon({ icon, size = 18, color = 'currentColor' }: IconProps) {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke={color}
      stroke-width='2'
      stroke-linecap='round'
      stroke-linejoin='round'
      aria-hidden='true'
    >
      {icon.map(([tag, attrs]) => jsx(tag, attrs))}
    </svg>
  );
}
