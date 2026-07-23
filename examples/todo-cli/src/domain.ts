import { z } from 'zod';
import { defineCollection, type StoreDomain } from '@a16n/pact-client';

// The whole domain: one collection. The schemas handed to the Store define
// which collections exist — this app has exactly one, `todos`, with ids
// like `td-x7k2m9qp4w`.
export const todos = defineCollection({
  name: 'todos',
  idPrefix: 'td',
  schema: (base) =>
    base.extend({
      title: z.string().min(1),
      done: z.boolean(),
      completedAt: z.iso.datetime().nullable(),
    }),
    migrations: {
        current: 1,
        migrations: [{
            from: 1,
            to: 2,
            up: (doc) => {
                doc.completed = doc.done
            }
        }]
    }
});

export const domain = { collections: [todos] } as const satisfies StoreDomain;
