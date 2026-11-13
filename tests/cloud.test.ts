import { expect, test } from 'bun:test';
import { deployCloud } from '../src/cloud';
import { readConfig } from '../src/config';
import type { Run } from '../src/process';
const config = readConfig({
  GITHUB_REPOSITORY: 'example/app', GITHUB_REF_NAME: 'main',
  DOCKER_BUILD_PATH: 'path with spaces', RIVET_CLOUD_TOKEN: 'synthetic-token',
  RIVET_ORG: 'test-org', RIVET_CLI_VERSION: '3.0.0-preview.3',
}, {});

test('Cloud delegates upload and rollout to the v3 CLI, then reads the app URL', async () => {
  const calls: string[][] = [];
  const command: Run = async (program, args, options) => {
    expect(program).toBe('bun');
    expect(args.slice(0, 4)).toEqual(['x', '--package', '@rivetkit/cli@3.0.0-preview.3', 'rivet']);
    expect(args).not.toContain('synthetic-token');
    expect(options?.env?.RIVET_CLOUD_TOKEN).toBe('synthetic-token');
    const call = args.slice(4);
    calls.push(call);
    if (call.includes('--help')) return '--cluster --build-context';
    expect(call).toContain('test-org');
    expect(call).toContain('production');
    if (call[1].endsWith('/regions')) return JSON.stringify({ items: [{ region: 'test-region' }] });
    if (call[0] === 'deploy') {
      expect(call).toContain('test-region');
      expect(call).toContain('api');
      expect(call[call.indexOf('--build-context') + 1]).toEndWith('path with spaces');
      expect(call).toContain('--yes');
      expect(call).not.toContain('--namespace');
      return 'Docker build progress\ntest-build\n';
    }
    expect(call[1]).toBe('/v2/clusters/{cluster}/regions/test-region/runner-pools/api');
    return JSON.stringify({ build_id: 'test-build', endpoints: { public: 'https://app.example.test' } });
  };
  expect(await deployCloud(config, { cluster: 'production', pool: 'api' }, command)).toEqual({ buildId: 'test-build', url: 'https://app.example.test' });
  expect(calls.filter((c) => c[0] === 'deploy' && !c.includes('--help'))).toHaveLength(1);
  expect(calls.filter((c) => c[0] === 'api').every((c) => !c.includes('-X'))).toBe(true);
});

test('published namespace CLI fails before any Cloud mutation', async () => {
  let calls = 0;
  await expect(deployCloud(config, { cluster: 'production' }, async () => {
    calls++; return 'deploy --namespace --project';
  })).rejects.toThrow('cannot deploy v3 clusters');
  expect(calls).toBe(1);
});

test('ambiguous or nonexistent regions fail before deploying', async () => {
  for (const target of [{ cluster: 'production' }, { cluster: 'production', region: 'missing' }]) {
    await expect(deployCloud(config, target, async (_program, args) => {
      if (args.includes('--help')) return '--cluster --build-context';
      expect(args).toContain('api');
      return JSON.stringify({ items: [{ region: 'one' }, { region: 'two' }] });
    })).rejects.toThrow('mapped region');
  }
});

test('preinstalled CLI bypasses package installation and a failed rollout is not retried', async () => {
  let deploys = 0;
  await expect(deployCloud({ ...config, cliPath: '/tools/rivet' }, { cluster: 'production' }, async (program, args) => {
    expect(program).toBe('/tools/rivet');
    if (args.includes('--help')) return '--cluster --build-context';
    if (args[0] === 'api') return JSON.stringify({ items: [{ region: 'one' }] });
    deploys++;
    throw new Error('rollout failed');
  })).rejects.toThrow('rollout failed');
  expect(deploys).toBe(1);
});

test('missing deployment credentials fail without starting the CLI', async () => {
  await expect(deployCloud({ ...config, cloudToken: '', githubOidc: false }, { cluster: 'production' }, async () => { throw new Error('must not start'); })).rejects.toThrow('Cloud deployment credential');
});

test('without rivet-token the CLI exchanges the GitHub OIDC token', async () => {
  const { buildId } = await deployCloud({ ...config, cloudToken: '', githubOidc: true }, { cluster: 'production' }, async (_program, args, options) => {
    expect(options?.env?.RIVET_CLOUD_TOKEN).toBe('');
    if (args.includes('--help')) return '--cluster --build-context';
    if (args.includes('/v2/clusters/{cluster}/regions')) return JSON.stringify({ items: [{ region: 'one' }] });
    if (args.includes('deploy')) return 'test-build\n';
    return JSON.stringify({ build_id: 'test-build', endpoints: { public: 'https://app.example.test' } });
  });
  expect(buildId).toBe('test-build');
});

test('concurrent pool changes cannot produce a misleading success URL', async () => {
  await expect(deployCloud(config, { cluster: 'production' }, async (_program, args) => {
    if (args.includes('--help')) return '--cluster --build-context';
    if (args.includes('/v2/clusters/{cluster}/regions')) return JSON.stringify({ items: [{ region: 'one' }] });
    if (args.includes('deploy')) return 'test-build\n';
    return JSON.stringify({ build_id: 'different-build', endpoints: { public: 'https://app.example.test' } });
  })).rejects.toThrow('pool changed');
});
