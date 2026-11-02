import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthedEnv, requireAuth } from '../auth/bearer';
import { badRequest } from '../lib/errors';
import { claimTask, releaseTask } from '../db/taskClaims';

const claimBodySchema = z.object({
  taskId: z.string().min(1).max(256),
  rev: z.string().min(1).max(64),
});

async function parseClaimBody(req: Request): Promise<z.infer<typeof claimBodySchema>> {
  const parsed = claimBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  return parsed.data;
}

export const taskRoutes = new Hono<AuthedEnv>();

taskRoutes.use('*', requireAuth);

taskRoutes.post('/claim', async (c) => {
  const { taskId, rev } = await parseClaimBody(c.req.raw);
  const token = c.get('token');
  return c.json(await claimTask(c.env.DB, token.app_id, token.id, taskId, rev));
});

taskRoutes.post('/release', async (c) => {
  const { taskId, rev } = await parseClaimBody(c.req.raw);
  const token = c.get('token');
  await releaseTask(c.env.DB, token.app_id, token.id, taskId, rev);
  return c.body(null, 204);
});
