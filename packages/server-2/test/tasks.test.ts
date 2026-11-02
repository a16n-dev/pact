import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { api, seedApp } from './helpers';
import { mintApiToken } from '../src/db/tokens';
import { LIMITS } from '../src/lib/limits';

type Claim = { claimed: boolean; expiresAt: number };

async function claim(token: string, taskId: string, rev: string): Promise<Claim> {
  const res = await api('/tasks/claim', token, { method: 'POST', json: { taskId, rev } });
  expect(res.status).toBe(200);
  return (await res.json()) as Claim;
}

async function release(token: string, taskId: string, rev: string): Promise<void> {
  const res = await api('/tasks/release', token, { method: 'POST', json: { taskId, rev } });
  expect(res.status).toBe(204);
}

describe('task claims', () => {
  let a: string;
  let b: string;
  beforeEach(async () => {
    a = (await seedApp('app-a')).token;
    b = (await mintApiToken(env.DB, 'app-a', 'second device')).token;
  });

  it('gives the claim to the first writer and refuses others until it expires', async () => {
    const first = await claim(a, 'parse:s1', 'r1');
    expect(first.claimed).toBe(true);
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect(await claim(b, 'parse:s1', 'r1')).toEqual({
      claimed: false,
      expiresAt: first.expiresAt,
    });
  });

  it('renews for the holder', async () => {
    const first = await claim(a, 'parse:s1', 'r1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await claim(a, 'parse:s1', 'r1');
    expect(renewed.claimed).toBe(true);
    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
  });

  it('lets another writer take an expired claim', async () => {
    await claim(a, 'parse:s1', 'r1');
    await env.DB.prepare('UPDATE task_claims SET expires_at = ?1')
      .bind(Date.now() - 1)
      .run();
    expect((await claim(b, 'parse:s1', 'r1')).claimed).toBe(true);
    expect((await claim(a, 'parse:s1', 'r1')).claimed).toBe(false);
  });

  it('hands a newer rev the claim at once and never gives it back to an older one', async () => {
    await claim(a, 'parse:s1', 'r1');
    expect((await claim(b, 'parse:s1', 'r2')).claimed).toBe(true);
    await env.DB.prepare('UPDATE task_claims SET expires_at = ?1')
      .bind(Date.now() - 1)
      .run();
    expect((await claim(a, 'parse:s1', 'r1')).claimed).toBe(false);
  });

  it('frees the claim on release, but only for the holder of that rev', async () => {
    await claim(a, 'parse:s1', 'r1');
    await release(b, 'parse:s1', 'r1');
    expect((await claim(b, 'parse:s1', 'r1')).claimed).toBe(false);
    await release(a, 'parse:s1', 'r1');
    expect((await claim(b, 'parse:s1', 'r1')).claimed).toBe(true);
  });

  it('keeps claims apart per app', async () => {
    const other = (await seedApp('app-b')).token;
    await claim(a, 'parse:s1', 'r1');
    expect((await claim(other, 'parse:s1', 'r1')).claimed).toBe(true);
  });

  it('sets the expiry from the server', async () => {
    const before = Date.now();
    const { expiresAt } = await claim(a, 'parse:s1', 'r1');
    expect(expiresAt).toBeGreaterThanOrEqual(before + LIMITS.taskClaimTtlMs);
  });

  it('validates the body and requires a token', async () => {
    expect((await api('/tasks/claim', null, { method: 'POST', json: {} })).status).toBe(401);
    const bad = await api('/tasks/claim', a, { method: 'POST', json: { taskId: '', rev: 'r1' } });
    expect(bad.status).toBe(400);
    const long = await api('/tasks/claim', a, {
      method: 'POST',
      json: { taskId: 't', rev: 'r'.repeat(65) },
    });
    expect(long.status).toBe(400);
  });
});
