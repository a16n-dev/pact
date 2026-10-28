//   pnpm setup --domain sync.example.com
//
// Safe to re-run; each step skips what already exists. With CLOUDFLARE_API_TOKEN set (Account
// Settings: Read, Turnstile: Edit) the Turnstile widget is created through the API; wrangler's
// own OAuth token can't, which is also why Access is left to the dashboard.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const D1_NAME = 'pact';
const R2_NAME = 'pact-blobs';
const CONFIG_PATH = new URL('../wrangler.jsonc', import.meta.url);

const { values: args } = parseArgs({
  options: {
    domain: { type: 'string' },
  },
});

const rl = createInterface({ input: stdin, output: stdout });

async function askOptional(question: string): Promise<string> {
  return (await rl.question(`${question} `)).trim();
}

async function ask(question: string, fallback?: string): Promise<string> {
  if (fallback) return fallback;
  let answer = '';
  while (!answer) answer = await askOptional(question);
  return answer;
}

function wrangler(cmdArgs: string[], input?: string): string {
  return execFileSync('pnpm', ['exec', 'wrangler', ...cmdArgs], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
  });
}

function step(title: string): void {
  console.log(`\n▸ ${title}`);
}

let config = readFileSync(CONFIG_PATH, 'utf8');

function setConfigValue(key: string, value: string): void {
  const pattern = new RegExp(`("${key}":\\s*)"[^"]*"`);
  if (!pattern.test(config)) throw new Error(`wrangler.jsonc has no "${key}" entry`);
  config = config.replace(pattern, `$1${JSON.stringify(value)}`);
}

function configValue(key: string): string {
  return config.match(new RegExp(`"${key}":\\s*"([^"]*)"`))?.[1] ?? '';
}

function saveConfig(): void {
  writeFileSync(CONFIG_PATH, config);
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN;

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json()) as { success: boolean; result: T; errors: { message: string }[] };
  if (!json.success) throw new Error(`${path}: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.result;
}

async function accountId(): Promise<string> {
  const whoami = wrangler(['whoami']);
  const id = whoami.match(/\b([0-9a-f]{32})\b/)?.[1];
  if (!id) throw new Error('Not logged in. Run `pnpm exec wrangler login` first.');
  return id;
}

function ensureD1(): string {
  step('D1 database');
  const existing = (
    JSON.parse(wrangler(['d1', 'list', '--json'])) as { uuid: string; name: string }[]
  ).find((db) => db.name === D1_NAME);
  if (existing) {
    console.log(`  ${D1_NAME} already exists (${existing.uuid})`);
    return existing.uuid;
  }
  const output = wrangler(['d1', 'create', D1_NAME]);
  const id = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  if (!id) throw new Error(`Couldn't find the database ID in wrangler's output:\n${output}`);
  console.log(`  created ${D1_NAME} (${id})`);
  return id;
}

function ensureR2(): void {
  step('R2 bucket');
  if (wrangler(['r2', 'bucket', 'list']).includes(`name:           ${R2_NAME}\n`)) {
    console.log(`  ${R2_NAME} already exists`);
    return;
  }
  wrangler(['r2', 'bucket', 'create', R2_NAME]);
  console.log(`  created ${R2_NAME}`);
}

async function ensureTurnstile(domain: string, account: string): Promise<string | null> {
  step('Turnstile');
  if (configValue('TURNSTILE_SITE_KEY')) {
    console.log('  site key already configured; keeping the existing secret');
    return null;
  }
  if (apiToken) {
    const widget = await api<{ sitekey: string; secret: string }>(
      `/accounts/${account}/challenges/widgets`,
      {
        method: 'POST',
        body: { name: 'pact', domains: [domain], mode: 'managed' },
      }
    );
    setConfigValue('TURNSTILE_SITE_KEY', widget.sitekey);
    console.log('  created a managed widget');
    return widget.secret;
  }
  console.log(
    `  Open https://dash.cloudflare.com/${account}/turnstile and add a widget for ${domain}.`
  );
  setConfigValue('TURNSTILE_SITE_KEY', await ask('  Site key:'));
  return ask('  Secret key:');
}

async function ensureAccess(domain: string, account: string): Promise<void> {
  step('Cloudflare Access');
  if (configValue('ACCESS_AUD')) {
    console.log('  already configured');
    return;
  }
  console.log(
    `  Open https://one.dash.cloudflare.com/${account}/access/apps and add a self-hosted application for ${domain}/admin with a policy for your email.`
  );
  setConfigValue(
    'ACCESS_TEAM_DOMAIN',
    await ask('  Team domain (like team.cloudflareaccess.com):')
  );
  setConfigValue('ACCESS_AUD', await ask('  Application Audience (AUD) tag:'));
}

async function ensureAiGateway(account: string): Promise<string | null> {
  step('AI Gateway');
  setConfigValue('CLOUDFLARE_ACCOUNT_ID', account);
  if (configValue('AI_GATEWAY_ID')) {
    console.log('  already configured; keeping the existing token');
    return null;
  }
  console.log(
    `  Open https://dash.cloudflare.com/${account}/ai/ai-gateway, pick or create the gateway apps will use, and set up Unified Billing or provider keys on it.`
  );
  console.log(
    '  Then create an API token with the "AI Gateway: Run" permission, or leave the ID blank to skip AI.'
  );
  const gatewayId = await askOptional('  Gateway ID (like default):');
  if (!gatewayId) return null;
  setConfigValue('AI_GATEWAY_ID', gatewayId);
  return ask('  API token:');
}

function setRoute(domain: string): void {
  if (config.includes('"custom_domain": true')) return;
  config = config.replace(
    /\s*\/\/ "routes": \[\{ "pattern": "[^"]*", "custom_domain": true \}\],\n\s*\/\/ "workers_dev": false,/,
    `\n  "routes": [{ "pattern": ${JSON.stringify(domain)}, "custom_domain": true }],\n  "workers_dev": false,`
  );
}

try {
  const domain = await ask('Domain for the server (like sync.example.com):', args.domain);
  const account = await accountId();

  setConfigValue('database_id', ensureD1());
  ensureR2();
  setRoute(domain);
  const turnstileSecret = await ensureTurnstile(domain, account);
  await ensureAccess(domain, account);
  const aiGatewayToken = await ensureAiGateway(account);
  saveConfig();

  step('Migrations');
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);

  step('Deploy');
  wrangler(['deploy']);

  if (turnstileSecret) {
    step('Turnstile secret');
    wrangler(['secret', 'put', 'TURNSTILE_SECRET'], turnstileSecret);
  }
  if (aiGatewayToken) {
    step('AI Gateway token');
    wrangler(['secret', 'put', 'AI_GATEWAY_TOKEN'], aiGatewayToken);
  }

  console.log(`\nDone. Open https://${domain}/admin to create your first app and user.`);
} finally {
  rl.close();
}
