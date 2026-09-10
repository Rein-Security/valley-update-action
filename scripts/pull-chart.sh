#!/usr/bin/env bash
#
# Downloads the target Valley chart .tgz into the runner's temp dir with helm.
#
# Env in: REGISTRY, REGISTRY_USERNAME, REGISTRY_PASSWORD, CHART_REF, TARGET_VERSION
# Out:    chart-file (to $GITHUB_OUTPUT or stdout)

set -euo pipefail

: "${REGISTRY:?}" "${REGISTRY_USERNAME:?}" "${REGISTRY_PASSWORD:?}" "${CHART_REF:?}" "${TARGET_VERSION:?}"

# helm is preinstalled on GitHub-hosted runners; self-hosted runners must add it
if ! command -v helm >/dev/null 2>&1; then
  echo "::error::helm is not installed on this runner. Add azure/setup-helm before this action or set pull-chart to false."; exit 1
fi

DEST="${RUNNER_TEMP:-/tmp}/valley-chart"
mkdir -p "$DEST"

# Log in with the password on stdin so it never appears in the process list
printf '%s' "$REGISTRY_PASSWORD" | helm registry login "$REGISTRY" --username "$REGISTRY_USERNAME" --password-stdin >/dev/null
helm pull "$CHART_REF" --version "$TARGET_VERSION" --destination "$DEST" >/dev/null
helm registry logout "$REGISTRY" >/dev/null 2>&1 || true

FILE=$(find "$DEST" -maxdepth 1 -name "*-$TARGET_VERSION.tgz" | head -n 1)
if [[ -z "$FILE" ]]; then echo "::error::helm pull finished but no *-$TARGET_VERSION.tgz found in $DEST"; exit 1; fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "chart-file=$FILE" >> "$GITHUB_OUTPUT"; else echo "chart-file=$FILE"; fi
echo "downloaded $FILE"
