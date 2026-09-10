# Valley Update Check

A GitHub Action that answers one question: **which Valley version should my valley run right now?**

It logs in to the Rein registry with the read-only credential you already have, follows the release pointer for your channel, and compares the result with the version you run today. It changes nothing in your cluster. You add one step after it that rolls the version out the way you already deploy: ArgoCD, a chart committed to Git, Pulumi, or plain Helm. See [`examples/`](examples/).

## Usage

```yaml
name: valley-auto-update
on:
  schedule: [{ cron: "0 3 * * *" }]   # nightly
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Read the version you run today from your own config (this example: an ArgoCD Application)
      - id: current
        run: echo "version=$(yq '.spec.source.targetRevision' argo/valley.yaml)" >> "$GITHUB_OUTPUT"

      # 2. Ask Rein which version you should run
      - id: valley
        uses: Rein-Security/valley-update-action@v1
        with:
          channel: stable
          current-version: ${{ steps.current.outputs.version }}
          registry-username: ${{ secrets.REIN_REGISTRY_USER }}
          registry-password: ${{ secrets.REIN_REGISTRY_PASSWORD }}

      # 3. Apply it your way. This example bumps the file and opens a pull request.
      - if: steps.valley.outputs.changed == 'true'
        run: yq -i '.spec.source.targetRevision = "${{ steps.valley.outputs.target-version }}"' argo/valley.yaml

      - if: steps.valley.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          title: "chore: valley ${{ steps.valley.outputs.target-version }}"
          branch: valley-update
```

Most runs end at step 2 with `changed=false`.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `channel` | no | `stable` | `stable` or `alpha`. Picks the chart (`valley` or `valley-alpha`) and the pointer it follows. |
| `current-version` | yes | | The chart version you run today, e.g. `0.61.0`. Read it from your own config, see the examples. |
| `registry` | no | `hub.reinsec.app` | Rein registry host. |
| `registry-username` | yes | | Your registry username, `robot$<valleyId>`. Pull-only is enough. |
| `registry-password` | yes | | Your registry password. Store it as a repository secret. |
| `pull-chart` | no | `false` | Also download the chart `.tgz` when an update exists. For customers who keep the chart inside their Git repo. Needs `helm` on the runner. |

## Outputs

| Output | Example | Use it for |
| --- | --- | --- |
| `changed` | `true` | Gate your apply step: `if: steps.valley.outputs.changed == 'true'`. |
| `target-version` | `0.61.0` | The number to write into your config. Always a fixed version, never `stable`. |
| `target-digest` | `sha256:…` | Audit trail of exactly which chart was resolved. |
| `chart-ref` | `oci://hub.reinsec.app/valley/valley` | Chart location for Helm and Pulumi. |
| `chart-file` | `/…/valley-0.61.0.tgz` | Only with `pull-chart: true` and `changed: true`. |

## How it decides

The Rein registry holds every version ever built, including internal ones. When Rein promotes a version for customers, it moves a pointer tag named `stable` (or `alpha`) onto that version. The action:

1. Reads the pointer and gets the digest it points at.
2. Lists version tags, newest first, and finds the one with the same digest.
3. Compares that fixed version with `current-version`.

The pointer is only read. What lands in your config is always a fixed version like `0.61.0`.

## You may not need this

| You deploy with | What to do |
| --- | --- |
| **Flux** | Nothing to run. A `HelmRepository` of type `oci` plus a `HelmRelease` with a version range updates on its own. See [`examples/flux.yaml`](examples/flux.yaml). |
| **Renovate** | Nothing to run. Add a `hostRules` entry for the Rein registry and Renovate bumps the chart like any dependency. See [`examples/renovate.json`](examples/renovate.json). |
| ArgoCD, chart in Git, Pulumi, Helm | Use this action. Examples for each are in [`examples/`](examples/). |

## Requirements

- A GitHub-hosted or self-hosted runner with `bash`, `curl`, `jq`. `helm` only if `pull-chart` is on. All are preinstalled on `ubuntu-latest`.
- Network access from the runner to the Rein registry.
- Your Rein registry credential stored as repository secrets. It is the same read-only credential your cluster uses to pull images.

## Security notes

- The action never writes to your cluster or your repository. Your apply step does, and you control it.
- Pin the action to a tag (`@v1`) or a commit SHA, as with any third-party action.
- The registry password is passed to `helm` over stdin and the bearer token is masked in logs.

## Developing

```bash
shellcheck scripts/*.sh
test/run.sh          # resolver logic against a local mock registry, no credentials needed
REGISTRY=hub.reinsec.dev CHANNEL=stable CURRENT_VERSION=0.0.1 REGISTRY_USERNAME='robot$…' REGISTRY_PASSWORD='…' scripts/resolve.sh
```

CI lints and runs the mock test on every PR and runs an integration test against `hub.reinsec.dev` for branches in this repository. It needs the repository secrets `HARBOR_DEV_ROBOT_USERNAME` and `HARBOR_DEV_ROBOT_PASSWORD`, a pull-only robot on the dev registry. Releases are tags `v1.2.3`; the `release` workflow moves the floating `v1` tag.
