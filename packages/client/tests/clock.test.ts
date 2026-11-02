import { describe, expect, it } from 'vitest';
import {
  ClockDriftError,
  HybridClock,
  clockToIso,
  compareClocks,
  decodeHlc,
  encodeHlc,
} from '../src/clock';

describe('HybridClock', () => {
  it('encodes to a fixed-width string that round-trips', () => {
    const encoded = encodeHlc({ wallMs: 1760590000123, counter: 255, node: 'abcDEF1234' });
    expect(encoded).toBe('1760590000123-00ff-abcDEF1234');
    expect(encoded.length).toBeLessThanOrEqual(64);
    expect(decodeHlc(encoded)).toEqual({ wallMs: 1760590000123, counter: 255, node: 'abcDEF1234' });
  });

  it('rejects malformed clocks', () => {
    expect(() => decodeHlc('nope')).toThrow(/Malformed/);
    expect(() => decodeHlc('1760590000123-zzzz-node')).toThrow(/Malformed/);
  });

  it('issues strictly increasing clocks even when wall time stalls', () => {
    let physical = 1_000;
    const clock = new HybridClock('n1', () => physical);
    const a = clock.now();
    const b = clock.now();
    physical = 999;
    const c = clock.now();
    physical = 2_000;
    const d = clock.now();
    expect(compareClocks(a, b)).toBeLessThan(0);
    expect(compareClocks(b, c)).toBeLessThan(0);
    expect(compareClocks(c, d)).toBeLessThan(0);
    expect(decodeHlc(d)).toMatchObject({ wallMs: 2_000, counter: 0 });
  });

  it('advances past a received clock from a faster node', () => {
    const local = new HybridClock('aaa', () => 1_000);
    const remote = new HybridClock('bbb', () => 5_000);
    const theirs = remote.now();
    local.receive(theirs);
    const mine = local.now();
    expect(compareClocks(mine, theirs)).toBeGreaterThan(0);
    expect(decodeHlc(mine)).toMatchObject({ wallMs: 5_000, counter: 2 });
  });

  it('breaks ties on the same wall time by counter', () => {
    const local = new HybridClock('aaa', () => 1_000);
    local.now();
    local.now();
    local.receive(encodeHlc({ wallMs: 1_000, counter: 7, node: 'bbb' }));
    expect(decodeHlc(local.now())).toMatchObject({ wallMs: 1_000, counter: 9 });
  });

  it('rejects clocks more than 60s ahead without advancing', () => {
    const local = new HybridClock('aaa', () => 1_000);
    expect(() =>
      local.receive(encodeHlc({ wallMs: 61_001 + 1_000, counter: 0, node: 'b' }))
    ).toThrow(ClockDriftError);
    expect(decodeHlc(local.now()).wallMs).toBe(1_000);
    local.receive(encodeHlc({ wallMs: 60_000 + 1_000, counter: 0, node: 'b' }));
    expect(decodeHlc(local.now()).wallMs).toBe(61_000);
  });

  it('sorts lexicographically in causal order across nodes', () => {
    const clocks = [
      encodeHlc({ wallMs: 2, counter: 0, node: 'a' }),
      encodeHlc({ wallMs: 1, counter: 16, node: 'a' }),
      encodeHlc({ wallMs: 1, counter: 2, node: 'z' }),
      encodeHlc({ wallMs: 1, counter: 2, node: 'b' }),
    ];
    expect([...clocks].sort(compareClocks)).toEqual([clocks[3], clocks[2], clocks[1], clocks[0]]);
  });

  it('maps a clock to the ISO time it was issued', () => {
    expect(clockToIso(encodeHlc({ wallMs: 0, counter: 3, node: 'a' }))).toBe(
      '1970-01-01T00:00:00.000Z'
    );
  });
});
