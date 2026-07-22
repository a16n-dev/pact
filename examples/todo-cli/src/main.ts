// A complete Pact client app: a local-first TODO list for your terminal.
//
// Everything works offline against a local JSON file. Point it at a pact
// server (`todo register`, `todo author`) and the same commands sync —
// none of the CRUD code below changes for that.
import { join } from 'node:path';
import { Store } from '@a16n/pact-client';
import { JsonFileAdapter } from './jsonFileAdapter'; // copied from examples/adapters
import { domain, todos } from './domain';

const HELP = `todo — a local-first TODO list (Pact example app)

Local usage (no server needed):
  todo add <title...>        add a todo
  todo list [--all]          open todos (--all includes completed)
  todo done <id>             complete a todo
  todo undo <id>             re-open a completed todo
  todo rm <id>               delete a todo (tombstoned, so the delete syncs)

Syncing (optional):
  todo register <url> <password> <appName> [clientName]
                             register this install with a pact server
  todo author <authorId>     claim an identity (e.g. us-alice) so writes sync
  todo sync                  push local changes, pull everyone else's
  todo status                registration, author, pending pushes, last sync

Data lives in .pact-todo.json (override with PACT_TODO_FILE).
Ids can be abbreviated to any unique tail, e.g. "todo done 4w" for td-x7k2m9qp4w.`;

const file = process.env.PACT_TODO_FILE ?? join(process.cwd(), '.pact-todo.json');
const store = await Store.create(new JsonFileAdapter(file), null, domain);
const list = store.collection('todos'); // typed from the schema in domain.ts

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Resolve a full id or any unique tail of one to a todo. */
async function resolve(idArg: string | undefined) {
  if (!idArg) fail('Missing id. Run "todo list" to see ids.');
  const all = await list.list();
  const matches = all.filter((t) => t.id === idArg || t.id.endsWith(idArg));
  if (matches.length === 0) fail(`No todo matches "${idArg}".`);
  if (matches.length > 1) fail(`"${idArg}" is ambiguous (${matches.map((t) => t.id).join(', ')}).`);
  return matches[0];
}

function print(todo: { id: string; title: string; done: boolean }): void {
  console.log(`${todo.done ? '[x]' : '[ ]'} ${todo.id}  ${todo.title}`);
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'add': {
      const title = args.join(' ').trim();
      if (!title) fail('Usage: todo add <title...>');
      const created = await list.create(todos.generateId(), {
        title,
        done: false,
        completedAt: null,
      });
      print(created);
      break;
    }

    case 'list':
    case undefined: {
      const all = (await list.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const shown = args.includes('--all') ? all : all.filter((t) => !t.done);
      if (shown.length === 0) console.log('Nothing to do. Add one: todo add <title>');
      for (const todo of shown) print(todo);
      break;
    }

    case 'done':
    case 'undo': {
      const todo = await resolve(args[0]);
      const done = command === 'done';
      print(
        await list.update(todo.id, {
          done,
          completedAt: done ? new Date().toISOString() : null,
        })
      );
      break;
    }

    case 'rm': {
      const todo = await resolve(args[0]);
      await list.delete(todo.id);
      console.log(`Deleted ${todo.id} (${todo.title})`);
      break;
    }

    case 'register': {
      const [url, password, appName, clientName] = args;
      if (!url || !password || !appName) {
        fail('Usage: todo register <url> <password> <appName> [clientName]');
      }
      const result = await store.registerClient(url, password, appName, clientName ?? 'todo-cli');
      if (!result.ok) fail(`Registration failed (${result.reason}).`);
      console.log('Registered. Now claim an identity: todo author <authorId>');
      break;
    }

    case 'author': {
      const authorId = args[0];
      if (!authorId) {
        console.log(`Current author: ${await store.getCurrentAuthor()}`);
        break;
      }
      await store.setAuthor(authorId);
      // Adopt anything written before the identity existed, so it can sync.
      await store.reassignLocalAuthor(authorId);
      console.log(`Writing as ${authorId}.`);
      break;
    }

    case 'sync': {
      if (!(await store.getClientRegistration()))
        fail('Not registered. Run "todo register" first.');
      await store.drainOutbox(); // retry anything queued while offline
      await store.pushAll();
      const pulled = await store.pull('todos');
      console.log(`Synced. ${pulled.length} change(s) pulled.`);
      break;
    }

    case 'status': {
      const registration = await store.getClientRegistration();
      console.log(`Data file:    ${file}`);
      console.log(`Author:       ${await store.getCurrentAuthor()}`);
      console.log(
        registration
          ? `Server:       ${registration.url} (app: ${registration.appName}, client: ${registration.name})`
          : 'Server:       not registered (local-only)'
      );
      if (registration) {
        console.log(`Pending push: ${await store.pendingPushCount()} doc(s)`);
        const syncedAt = await store.getLastSyncedAt(['todos']);
        console.log(`Last synced:  ${syncedAt ? syncedAt.toISOString() : 'never'}`);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.log(HELP);
      process.exit(1);
  }
} finally {
  store.dispose(); // close the realtime socket, if one opened
}
