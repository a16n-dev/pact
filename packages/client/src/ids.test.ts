import { describe, it, expect } from 'vitest';
import { randomId } from './ids';

describe('randomId', () => {
  it('generates a URL-safe body of the requested length, free of separator chars', () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(randomId(4)).toMatch(/^[A-Za-z0-9]{4}$/);
    // Must never emit the `-`/`_` that would collide with the prefix separator.
    expect(randomId(200)).not.toMatch(/[-_]/);
  });
});
