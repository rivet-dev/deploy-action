# Rivet Deploy Action — v3

Map branches to **existing Rivet Cloud clusters**. Optionally deploy every other branch to a **single Fly Machine** running the app with RivetKit's automatic local engine, like a dev machine. Unmapped branches are skipped when previews are disabled or no Fly token is configured.

## Setup

Add these GitHub Actions secrets:

- `RIVET_CLOUD_TOKEN`: a Rivet Cloud credential with cluster deployment access in your organization. An Engine admin token cannot deploy builds. The action uses the [Rivet CLI](https://rivet.dev/docs/cli/) and passes this secret through `RIVET_CLOUD_TOKEN`.
- `FLY_API_TOKEN`: a Fly organization token that can create, deploy, and delete preview apps. Only needed for Fly previews.

Use the published CLI with v3 support, for example `rivet-cli-version: '3.0.0'`.

**Known restart issue:** RivetKit `3.0.0` can mistake a reused PID from a previous VM boot for a still-running local Engine. The consumer test documents a temporary container startup workaround; the action does not apply it. Plain app startup remains `registry.start()`. A fixed RivetKit release is needed for an unmodified, restart-safe container.

Create `.github/workflows/rivet-deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main, staging]
  pull_request:
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:

concurrency:
  group: rivet-deploy-${{ github.head_ref || (github.event_name == 'delete' && github.event.ref) || github.ref_name }}
  cancel-in-progress: false

jobs:
  deploy:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      # Use the v3 release tag once published; a commit SHA also works.
      - uses: rivet-dev/deploy-action@v3
        with:
          rivet-token: ${{ secrets.RIVET_CLOUD_TOKEN }}
          rivet-cli-version: '3.0.0'
          rivet-org: my-org
          branch-clusters: |
            {
              "main": "production",
              "staging": { "cluster": "staging", "region": "us-east4", "pool": "default" }
            }
          fly-enabled: 'true'
          fly-token: ${{ secrets.FLY_API_TOKEN }}
          fly-org: my-fly-org
```

The mapping uses exact **source branch names**, including for pull requests. Each cluster may be mapped to only one branch. Specify a region when a cluster has more than one; otherwise Rivet selects its only region. Existing pool settings, including its allowlist, are preserved.

PR-close events delete the Fly app and its volume. They **never delete Cloud clusters**. Keep the Fly token configured for cleanup even if you later disable previews. Fork PRs and tag events are skipped. For push-only previews, also subscribe to the `delete` event to clean up deleted branches. Keep deployment and cleanup in the same concurrency group.

## Container requirements

Use RivetKit v3. The image must run your registry and serve your app's HTTP server on `0.0.0.0:$PORT` (default `8080`). `registry.start()` alone does not serve your app's HTTP endpoint. Use normal `setup({ use: … })` and `registry.start()`; no provider-specific runtime overrides are needed.

- **Cloud:** Rivet supplies the engine connection and pool configuration. Keep the image in production mode.
- **Fly:** the action sets `NODE_ENV=development` and `RIVETKIT_STORAGE_PATH=/data`. Let RivetKit start its engine normally. Keep its native and engine packages in the image; do not hardcode `startEngine: false` or bake remote Rivet credentials into it. The container user must be able to write `/data`.

The [counter example](examples/counter) uses the same code and Dockerfile on both providers, with `registry.start()` and no runtime overrides.

Only the app's HTTP port is public; the local engine stays inside the Machine. Browser clients should call your app's backend. The returned app URL is **not** `RIVET_ENDPOINT`.

Fly creates one Machine with a 20 GiB persistent volume. Increasing `fly-volume-size` grows the existing volume on redeploy; lowering it never shrinks or replaces the volume. RivetKit v3’s local engine reserves 4 GiB for its log; smaller-than-5 GiB volumes cannot start it. It stops when idle and starts on incoming HTTP requests. Actor data survives stops and image updates, but is removed on preview cleanup. Open connections can keep it awake; background work cannot wake a stopped Machine. Volume storage remains billable while stopped. See [Fly autostop](https://fly.io/docs/launch/autostop-autostart/) and [volumes](https://fly.io/docs/volumes/overview/).

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `branch-clusters` | `{}` | Branch → cluster mapping |
| `rivet-token`, `rivet-org` | — | Required for mapped Cloud deployments |
| `rivet-cli-version` | `latest` | CLI release with v3 cluster support; pin for reproducibility |
| `rivet-cli-path` | — | Use a preinstalled v3 CLI instead of downloading one |
| `docker-build-path` | `.` | Build context, relative to checkout |
| `dockerfile-path` | `Dockerfile` | Dockerfile, relative to checkout |
| `fly-enabled` | `false` | Enable previews for unmapped branches |
| `fly-token`, `fly-org` | — | Required for Fly deployment and cleanup |
| `fly-region` | `iad` | Preview region; keep stable across updates |
| `fly-port` | `8080` | App HTTP port |
| `fly-memory` | `1024` | Machine memory, MiB |
| `fly-volume-size` | `20` | Data volume size, GiB (minimum 5; grows existing volumes) |
| `github-token` | `${{ github.token }}` | PR status comments |

PR comments update in place with a status table and workflow logs. Ready deployments include an **Open preview** link. Skipped previews explain why; PR closure reports removal or retention of a mapped cluster. Cancellation reporting runs as a final action step and is best-effort if the runner is forcibly terminated.

Outputs: `status` (`ready`, `skipped`, `closed`), `provider` (`rivet`, `fly`), `url`, `build-id` (Cloud), and `fly-app` (Fly).

## Upgrading from v1

v3 uses branch-to-cluster mappings instead of creating namespaces. Replace `main-branch`, `prod-namespace`, `rivet-endpoint`, `runner-config`, and `compute-pool-config` with the mapping above. Configure cluster resources in Rivet. Keep using the v1 tag for the old namespace-based deployment flow.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run check
```
