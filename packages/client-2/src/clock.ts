export type Hlc = {
  wallMs: number;
  counter: number;
  node: string;
};

export const MAX_CLOCK_DRIFT_MS = 60_000;

const WALL_DIGITS = 13;
const COUNTER_DIGITS = 4;
const MAX_COUNTER = 16 ** COUNTER_DIGITS - 1;

export class ClockDriftError extends Error {
  constructor(clock: string) {
    super(`Clock ${clock} is more than ${MAX_CLOCK_DRIFT_MS / 1000}s ahead of local time`);
    this.name = 'ClockDriftError';
  }
}

/**
 * `<wallMs>-<counter>-<node>`: decimal wall time zero-padded to 13 digits,
 * hex counter padded to 4, then the node id. Fixed widths make plain string
 * comparison causal order.
 */
export function encodeHlc(hlc: Hlc): string {
  return `${String(hlc.wallMs).padStart(WALL_DIGITS, '0')}-${hlc.counter
    .toString(16)
    .padStart(COUNTER_DIGITS, '0')}-${hlc.node}`;
}

export function decodeHlc(encoded: string): Hlc {
  const wall = encoded.slice(0, WALL_DIGITS);
  const counter = encoded.slice(WALL_DIGITS + 1, WALL_DIGITS + 1 + COUNTER_DIGITS);
  const node = encoded.slice(WALL_DIGITS + 2 + COUNTER_DIGITS);
  if (
    encoded[WALL_DIGITS] !== '-' ||
    encoded[WALL_DIGITS + 1 + COUNTER_DIGITS] !== '-' ||
    !/^\d{13}$/.test(wall) ||
    !/^[0-9a-f]{4}$/.test(counter) ||
    node.length === 0
  ) {
    throw new Error(`Malformed clock: ${encoded}`);
  }
  return { wallMs: Number(wall), counter: parseInt(counter, 16), node };
}

export function compareClocks(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxClock(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareClocks(a, b) >= 0 ? a : b;
}

/** Wall time of a clock as an ISO timestamp, which is what `updatedAt` reads as. */
export function clockToIso(encoded: string): string {
  return new Date(decodeHlc(encoded).wallMs).toISOString();
}

/**
 * One instance per store: every local write takes `now()` and every clock
 * received from another writer goes through `receive()`, so clocks issued
 * here are always greater than any clock this store has seen.
 */
export class HybridClock {
  private readonly node: string;
  private readonly physical: () => number;
  private wallMs = 0;
  private counter = 0;

  constructor(node: string, physical: () => number = () => Date.now()) {
    this.node = node;
    this.physical = physical;
  }

  now(): string {
    const physical = this.physical();
    if (physical > this.wallMs) {
      this.wallMs = physical;
      this.counter = 0;
    } else {
      this.tick();
    }
    return encodeHlc({ wallMs: this.wallMs, counter: this.counter, node: this.node });
  }

  /** Throws `ClockDriftError` without advancing when the clock is beyond the drift bound. */
  receive(encoded: string): void {
    const remote = decodeHlc(encoded);
    const physical = this.physical();
    if (remote.wallMs - physical > MAX_CLOCK_DRIFT_MS) throw new ClockDriftError(encoded);
    if (physical > this.wallMs && physical > remote.wallMs) {
      this.wallMs = physical;
      this.counter = 0;
    } else if (remote.wallMs > this.wallMs) {
      this.wallMs = remote.wallMs;
      this.counter = remote.counter + 1;
    } else if (remote.wallMs === this.wallMs) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else {
      this.tick();
    }
    this.overflowGuard();
  }

  private tick(): void {
    this.counter += 1;
    this.overflowGuard();
  }

  private overflowGuard(): void {
    if (this.counter > MAX_COUNTER) {
      this.wallMs += 1;
      this.counter = 0;
    }
  }
}
