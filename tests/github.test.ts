import { afterEach, expect, spyOn, test } from 'bun:test';
import { readConfig } from '../src/config';
import { renderStatus, status, type StatusState } from '../src/github';
import { main } from '../src/index';
import { Fly } from '../src/fly';

const config = readConfig({ GITHUB_REPOSITORY: 'example/app', GITHUB_EVENT_NAME: 'pull_request', GITHUB_TOKEN: 'synthetic-token' }, {
  action: 'opened', pull_request: { number: 42, head: { ref: 'feature', repo: { full_name: 'example/app' } } },
});
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('every status uses the same table and only deploying identifies the provider', () => {
  const states: StatusState[] = ['deploying', 'ready', 'failed', 'skipped', 'removing', 'closed', 'cleanup-failed', 'cancelled'];
  for (const state of states) {
    const body = renderStatus(config, state, { provider: 'fly', url: 'https://preview.example.com', removed: true }, '123');
    expect(body).toContain('| Project | Preview | Status | Actions |');
    expect(body).toContain('| app | PR #42 |');
    expect(body).toContain('[Logs](https://github.com/example/app/actions/runs/123)');
    expect(body.includes('[Open preview]')).toBe(state === 'ready');
    expect(body.includes('(Fly)')).toBe(state === 'deploying');
    expect(body).not.toContain('Fly.io');
    expect(body).not.toContain('namespace');
  }
  expect(renderStatus(config, 'deploying', { provider: 'rivet' })).toContain('Deploying… (Rivet)');
  expect(renderStatus(config, 'closed', { removed: true })).toContain('Preview removed');
  const retained = renderStatus(config, 'closed', { removed: true, retained: true });
  expect(retained).toContain('PR closed');
  expect(retained).toContain('The mapped cluster is retained.');
  expect(retained).not.toContain('Preview removed');
});

test('comment escapes table content and never exposes URL credentials', () => {
  const body = renderStatus({ ...config, repo: 'example/a|<b>' }, 'ready', { url: 'https://user:secret@preview.example.com', reason: '<script>|bad\ntext' });
  expect(body).not.toContain('secret');
  expect(body).not.toContain('<script>');
  expect(body).toContain('a&#124;&lt;b&gt;');
});

function comments(marker = '<!-- rivet-deploy-v3 -->') {
  const bodies: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return Response.json([
      { id: 1, body: marker, user: { login: 'someone', type: 'User' } },
      { id: 2, body: marker, user: { login: 'github-actions[bot]', type: 'Bot' } },
    ]);
    expect(String(input)).toEndWith('/issues/comments/2');
    expect(init.method).toBe('PATCH');
    bodies.push(JSON.parse(init.body as string).body);
    return Response.json({ id: 2 });
  }) as typeof fetch;
  return bodies;
}

test('updates the old bot comment instead of creating a duplicate', async () => {
  const bodies = comments('<!-- rivet-preview-status -->');
  await status(config, 'ready');
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain('✅ Ready');
});

test('missing token skips an enabled preview and explains why in the comment', async () => {
  const bodies = comments();
  await main({ ...config, flyEnabled: true });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain('⏭️ Skipped');
  expect(bodies[0]).toContain('Preview deployments are not enabled.');
});

test('cleanup failure replaces removing status and never reports removal success', async () => {
  const bodies = comments();
  const cleanup = spyOn(Fly.prototype, 'cleanup').mockRejectedValue(new Error('synthetic failure'));
  try {
    await expect(main({ ...config, action: 'closed', flyEnabled: true, flyToken: 'synthetic-token', flyOrg: 'example' })).rejects.toThrow('synthetic failure');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('Removing preview…');
    expect(bodies[1]).toContain('Preview removal failed');
    expect(bodies[1]).not.toContain('Preview removed');
  } finally { cleanup.mockRestore(); }
});
