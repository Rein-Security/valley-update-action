# Valley Update Check

A GitHub Action that answers one question: **which Valley version should my valley run right now?**

It logs in to the Rein registry with the read-only credential you already have, follows the release pointer for your channel, and compares the result with the version you run today. It changes nothing in your cluster. You add one step after it that rolls the version out the way you already deploy: ArgoCD, a chart committed to Git, Pulumi, or plain Helm. See [`examples/`](examples/).

## Usage

```yaml
name: valley-auto-update
on:
  schedule: [{ cron: "0 3 * * *" }]   # nightly
  workflow_dispatch:

# Edit only this block to match your repo
env:
  CHANNEL: stable
  APP_FILE: argo/valley.yaml                  # this example: an ArgoCD Application
  VERSION_PATH: .spec.source.targetRevision   # where the chart version sits in that file

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Read the version you run today from your own config
      - id: current
        run: echo "version=$(yq "$VERSION_PATH" "$APP_FILE")" >> "$GITHUB_OUTPUT"

      # 2. Ask Rein which version you should run
      - id: valley
        uses: Rein-Security/valley-update-action@v1
        with:
          channel: ${{ env.CHANNEL }}
          current-version: ${{ steps.current.outputs.version }}
          registry-username: ${{ secrets.REIN_REGISTRY_USER }}
          registry-password: ${{ secrets.REIN_REGISTRY_PASSWORD }}

      # 3. Apply it your way. This example bumps the file and opens a pull request.
      - if: steps.valley.outputs.changed == 'true'
        env:
          TARGET: ${{ steps.valley.outputs.target-version }}
        run: yq -i "$VERSION_PATH = \"$TARGET\"" "$APP_FILE"

      - if: steps.valley.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          title: "chore: valley ${{ steps.valley.outputs.target-version }}"
          branch: valley-update
```

Most runs end at step 2 with `changed=false`. Every example in [`examples/`](examples/) follows the same rule: customer-specific paths and names sit in one `env:` block at the top, nothing else needs editing.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `channel` | no | `stable` | `stable` or `alpha`. Picks the chart (`valley` or `valley-alpha`) and the pointer it follows. Any version tag of that chart can be promoted, whatever its prerelease suffix. |
| `current-version` | yes | | The chart version you run today, e.g. `0.61.0`. Read it from your own config, see the examples. |
| `registry` | no | `hub.reinsec.app` | Rein registry host. |
| `registry-username` | yes | | Your registry username, `robot$<valleyId>`. Pull-only is enough. |
| `registry-password` | yes | | Your registry password. Store it as a repository secret. |
| `pull-chart` | no | `false` | Also download the chart `.tgz` when an update exists. For customers who keep the chart inside their Git repo. |
| `allow-major` | no | `false` | Let a new major version through. By default the run **fails** when the target has a different major version than `current-version`. See below. |

## Outputs

| Output | Example | Use it for |
| --- | --- | --- |
| `changed` | `true` | Gate your apply step: `if: steps.valley.outputs.changed == 'true'`. |
| `major-change` | `false` | `true` when the target is a new major version. Set even when the run fails on it. |
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

### Major versions are not applied automatically

A major version bump (for example `0.61.0` to `1.0.0`) can carry breaking changes or manual migration steps. When the target has a different major version than `current-version`, the action writes its outputs, prints an error, and **fails the job**, so your apply step never runs. The failed run is your signal to read the release notes. To let it through, set `allow-major: true` for that run and remove it afterwards.

## You may not need this

| You deploy with | What to do |
| --- | --- |
| **Flux** | Nothing to run. A `HelmRepository` of type `oci` plus a `HelmRelease` with a version range updates on its own. See [`examples/flux.yaml`](examples/flux.yaml). |
| **Renovate** | Nothing to run. Add a `hostRules` entry for the Rein registry and Renovate bumps the chart like any dependency. See [`examples/renovate.json`](examples/renovate.json). |
| ArgoCD, chart in Git, Pulumi, Helm | Use this action. Examples for each are in [`examples/`](examples/). If you vendor the chart into Git, keep your values **outside** the chart folder; the update replaces that folder. See [`examples/chart-in-git.yaml`](examples/chart-in-git.yaml). |

## Requirements

- Any runner that can run Node 24 actions. All GitHub-hosted runners can; a self-hosted runner needs actions/runner 2.327 or newer. No `helm`, `docker`, or other tools needed.
- Network access from the runner to the Rein registry.
- Your Rein registry credential stored as repository secrets. It is the same read-only credential your cluster uses to pull images.

## Security notes

- The action never writes to your cluster or your repository. Your apply step does, and you control it.
- Pin the action to a tag (`@v1`) or a commit SHA, as with any third-party action.
- The password and the bearer token are masked in logs. The action talks to the registry over plain HTTPS with Node's built-in `fetch`; there are no shell commands.

## Developing

A Node 24 JavaScript action. Source is in `src/`, the runner executes the bundle in `dist/`, so rebuild and commit `dist/` with every change.

```bash
npm ci
npm test            # unit + entrypoint tests against a mock registry, no credentials needed
npm run build       # bundles src/ into dist/ with ncc; commit the result
ACTION_ENTRY=dist/index.js npm test
```

CI runs the tests on every PR, fails if `dist/` is stale, and runs an integration test against `hub.reinsec.app` for branches in this repository. That job needs the repository secrets `HARBOR_ROBOT_USERNAME` and `HARBOR_ROBOT_PASSWORD`, a pull-only robot scoped to the `valley` project. Run logs are public, so the test deliberately targets the customer registry: it shows the current customer version and nothing internal. Releases are tags `v1.2.3`; the `release` workflow moves the floating `v1` tag.
