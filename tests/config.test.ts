import { describe, expect, test } from 'bun:test';
import { parseClusters, plan, previewName, readConfig } from '../src/config';
const env = { GITHUB_REPOSITORY: 'example/app', GITHUB_REF_NAME: 'feature', GITHUB_EVENT_NAME: 'push' };

describe('deployment selection', () => {
  test('mapped branches win over enabled Fly previews', () => {
    const c = readConfig({ ...env, BRANCH_CLUSTERS: '{"feature":{"cluster":"staging","region":"test-region","pool":"api"}}', FLY_ENABLED: 'true' }, {});
    expect(plan(c)).toEqual({ kind: 'cloud', target: { cluster: 'staging', region: 'test-region', pool: 'api' } });
  });
  test('unmapped branches skip without credentials or Docker', () => {
    expect(plan(readConfig(env, {})).kind).toBe('skip');
    expect(plan(readConfig({ ...env, FLY_ENABLED: 'true', FLY_API_TOKEN: 'synthetic-token' }, {}))).toEqual({ kind: 'fly' });
  });
  test('PR uses head branch, not merge ref or base branch', () => {
    const c = readConfig({ ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_NAME: '12/merge', BRANCH_CLUSTERS: '{"feature":"staging"}' }, {
      action: 'synchronize', pull_request: { number: 12, head: { ref: 'feature', repo: { full_name: env.GITHUB_REPOSITORY } } },
    });
    expect(plan(c)).toEqual({ kind: 'cloud', target: { cluster: 'staging' } });
  });
  test('fork PR cannot deploy even if its name maps to production', () => {
    const c = readConfig({ ...env, GITHUB_EVENT_NAME: 'pull_request', BRANCH_CLUSTERS: '{"main":"production"}' }, {
      action: 'opened', pull_request: { number: 1, head: { ref: 'main', repo: { full_name: 'fork/app' } } },
    });
    expect(plan(c).kind).toBe('skip');
  });
  test('close and delete clean up even after Fly is disabled or mapping changes', () => {
    const c = readConfig({ ...env, GITHUB_EVENT_NAME: 'pull_request', BRANCH_CLUSTERS: '{"feature":"staging"}' }, {
      action: 'closed', pull_request: { number: 12, head: { ref: 'feature', repo: { full_name: env.GITHUB_REPOSITORY } } },
    });
    expect(plan(c)).toEqual({ kind: 'cleanup' });
    const deleted = readConfig({ ...env, GITHUB_EVENT_NAME: 'delete' }, { ref_type: 'branch', ref: 'feature' });
    expect(deleted.branch).toBe(c.branch);
    expect(plan(deleted)).toEqual({ kind: 'cleanup' });
  });
  test('tags and pull_request_target are never deployed', () => {
    expect(plan(readConfig({ ...env, FLY_ENABLED: 'true', GITHUB_REF_TYPE: 'tag' }, {})).kind).toBe('skip');
    expect(plan(readConfig({ ...env, FLY_ENABLED: 'true', GITHUB_EVENT_NAME: 'pull_request_target' }, {})).kind).toBe('skip');
  });
  test('bad configuration fails instead of falling back to the wrong provider', () => {
    for (const value of ['null', '[]', '{', '{"main":{}}', '{"main":{"cluster":"prod","namespace":"x"}}', '{"main":"prod","staging":"prod"}']) expect(() => parseClusters(value)).toThrow();
    expect(() => readConfig({ ...env, FLY_ENABLED: 'yes' }, {})).toThrow();
    expect(() => readConfig({ ...env, FLY_PORT: '8080oops' }, {})).toThrow();
  });
  test('prototype-like branch names are exact map keys', () => {
    expect(plan(readConfig({ ...env, GITHUB_REF_NAME: 'toString' }, {})).kind).toBe('skip');
    expect(parseClusters('{"__proto__":"test"}').__proto__).toEqual({ cluster: 'test' });
  });
  test('preview names isolate repositories and case-sensitive branches', () => {
    const name = previewName('example/app', 'feature/A');
    expect(name).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
    expect(name).toBe(previewName('example/app', 'feature/A'));
    expect(name).not.toBe(previewName('example/app', 'feature/a'));
    expect(name).not.toBe(previewName('other/app', 'feature/A'));
  });
});
