import { parseClock } from './decode';

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function formatDateTime(ms: number): string {
  return dateTimeFormat.format(new Date(ms));
}

export function formatClock(raw: string): string {
  const clock = parseClock(raw);
  return clock ? formatDateTime(clock.wallMs) : raw;
}

export function formatDate(ms: number): string {
  return dateFormat.format(new Date(ms));
}

export function formatRelative(ms: number, now = Date.now()): string {
  const elapsedMinutes = Math.round((now - ms) / 60_000);
  if (elapsedMinutes < 2) return 'Just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes} minutes ago`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return elapsedHours === 1 ? '1 hour ago' : `${elapsedHours} hours ago`;
  const elapsedDays = Math.round(elapsedHours / 24);
  if (elapsedDays === 1) return 'Yesterday';
  if (elapsedDays < 14) return `${elapsedDays} days ago`;
  return formatDate(ms);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB');
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}
