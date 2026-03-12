# Rivet Preview Namespace Action

Creates Rivet namespaces for preview deployments.

## Inputs

| Input | Required | Default | Description |
|:------|:---------|:--------|:------------|
| `rivet-token` | Yes | - | Rivet Cloud API token |
| `rivet-endpoint` | No | `https://api.rivet.dev` | Rivet Engine API endpoint |
| `github-token` | No | `${{ github.token }}` | GitHub token for PR comments |
| `main-branch` | No | `main` | Main branch name for production deployments |
| `docker-root` | No | `.` | Docker build context directory |
| `dockerfile-path` | No | `Dockerfile` | Dockerfile location relative to repo root |
| `managed-pool-config` | No | `{ }` | JSON property overrides for managed pool configuration |

## Setup

1. Get your Rivet token from [Rivet Dashboard](https://dashboard.rivet.dev) > Settings > Advanced > Manual Client Configuration

2. Add secret to your repository:
   ```bash
   gh secret set RIVET_CLOUD_TOKEN
   ```

3. Create `.github/workflows/rivet-preview.yml`:
   ```yaml
   name: Rivet Preview

   on:
     pull_request:
       types: [opened, synchronize, reopened, closed]
     push:
       branches: [main]

   concurrency:
     group: rivet-preview-${{ github.event.pull_request.number || github.ref }}
     cancel-in-progress: true

   jobs:
     rivet-preview:
       runs-on: ubuntu-latest
       permissions:
         pull-requests: write
       steps:
         - uses: rivet-dev/preview-namespace-action@v1
           with:
             rivet-token: ${{ secrets.RIVET_CLOUD_TOKEN }}
   ```

## How It Works

When a PR is opened or updated:

1. The action creates a Rivet namespace for the PR (or reuses an existing one)
2. The Dockerfile is built
3. The image is uploaded to Rivet's docker registry
4. A runner pool using the image is created in the new namespace

When a PR is closed, the action archives the corresponding Rivet namespace to keep your project tidy.
