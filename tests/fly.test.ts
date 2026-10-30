import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { readConfig, previewName } from '../src/config';
import { Fly } from '../src/fly';
import type { Run } from '../src/process';
const config = readConfig({ GITHUB_REPOSITORY: 'example/app', GITHUB_REF_NAME: 'feature', FLY_API_TOKEN: 'synthetic-token', FLY_ORG: 'test-org' }, {});
const app = previewName(config.repo, config.branch);

test('deploy creates one dev Machine with durable local storage and safe argument passing', async () => {
  const requests: string[] = [];
  let deployed = false;
  const request = (async (url: string | URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push(`${init.method} ${path}`);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-token');
    if (path === `/v1/apps/${app}`) return new Response(null, { status: 404 });
    if (path === '/v1/apps') return Response.json({ id: 'app' });
    if (path.endsWith('/machines')) return Response.json(deployed ? [{ id: 'one', state: 'started', region: 'iad' }] : []);
    return Response.json([]);
  }) as (url: string, init: RequestInit) => Promise<Response>;
  const command: Run = async (program, args, options) => {
    expect(program).toBe('flyctl');
    expect(args).toContain('--ha=false');
    expect(args[args.indexOf('--strategy') + 1]).toBe('rolling');
    expect(args).not.toContain('synthetic-token');
    expect(options?.env?.FLY_API_TOKEN).toBe('synthetic-token');
    const data = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
    expect(data.env.NODE_ENV).toBe('development');
    expect(data.env).not.toHaveProperty('RIVET_ENDPOINT');
    expect(data.env.RIVETKIT_STORAGE_PATH).toBe('/data');
    expect(data.http_service).toMatchObject({ auto_stop_machines: 'stop', auto_start_machines: true, min_machines_running: 0 });
    expect(data.mounts).toHaveLength(1);
    deployed = true;
    return '';
  };
  expect(await new Fly(config, command, request).deploy()).toBe(`https://${app}.fly.dev`);
  expect(requests.filter((r) => r === 'POST /v1/apps')).toHaveLength(1);
});

test('redeploy refuses multiple Machines instead of risking two local engines', async () => {
  let ran = false;
  const request = (async (url: string) => Response.json(url.endsWith('/machines')
    ? [{ id: 'one', state: 'started', region: 'iad' }, { id: 'two', state: 'stopped', region: 'iad' }]
    : { name: app, organization: { slug: 'test-org' } })) as (url: string, init: RequestInit) => Promise<Response>;
  await expect(new Fly(config, async () => { ran = true; return ''; }, request).deploy()).rejects.toThrow('at most one');
  expect(ran).toBe(false);
});

test('cleanup is idempotent for absent previews and cannot trust comment targets', async () => {
  let ran = false;
  await new Fly(config, async () => { ran = true; return ''; }, (async () => new Response(null, { status: 404 })) as (url: string, init: RequestInit) => Promise<Response>).cleanup();
  expect(ran).toBe(false);
  await new Fly(config, async (_program, args) => {
    expect(args).toEqual(['apps', 'destroy', app, '--yes']); return '';
  }, (async () => Response.json({ name: app, organization: { slug: 'test-org' } })) as (url: string, init: RequestInit) => Promise<Response>).cleanup();
});

test('auth failures never masquerade as missing apps', async () => {
  let ran = false;
  await expect(new Fly(config, async () => { ran = true; return ''; }, (async () => new Response(null, { status: 401 })) as (url: string, init: RequestInit) => Promise<Response>).deploy()).rejects.toThrow('401');
  expect(ran).toBe(false);
});

test('cleanup refuses an app from another organization', async () => {
  await expect(new Fly(config, async () => { throw new Error('must not delete'); }, (async () => Response.json({ name: app, organization: { slug: 'other' } })) as (url: string, init: RequestInit) => Promise<Response>).cleanup()).rejects.toThrow('different Fly organization');
});

test('redeploy grows existing storage before updating the Machine and never shrinks it', async () => {
  for (const size of [10, 20, 30]) {
    const commands: string[][] = [];
    const request = async (url: string) => Response.json(url.endsWith('/machines')
      ? [{ id: 'one', state: 'started', region: 'iad' }]
      : url.endsWith('/volumes')
        ? [{ id: 'existing-volume', name: 'rivet_data', region: 'iad', state: 'created', size_gb: size }]
        : { name: app, organization: { slug: 'test-org' } });
    await new Fly(config, async (_program, args) => { commands.push(args); return ''; }, request).deploy();
    if (size < 20) expect(commands[0]).toEqual(['volumes', 'extend', 'existing-volume', '--app', app, '--size', '20', '--yes']);
    else expect(commands).toHaveLength(1);
    expect(commands.at(-1)?.[0]).toBe('deploy');
  }
});
