#!/usr/bin/env bash
#
# Runs resolve.sh against the mock registry and checks its outputs.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=18765
python3 test/mock_registry.py "$PORT" & MOCK=$!
trap 'kill $MOCK' EXIT
sleep 1

export REGISTRY="127.0.0.1:$PORT" REGISTRY_SCHEME=http REGISTRY_USERNAME='robot$abc' REGISTRY_PASSWORD='s3cret'
fail() { echo "FAIL: $*"; exit 1; }

# Outdated customer: expect the pointer's fixed version, not the highest tag
out=$(CHANNEL=stable CURRENT_VERSION=0.60.0 scripts/resolve.sh)
grep -q '^target-version=0.61.0$' <<<"$out" || fail "expected target 0.61.0, got: $out"
grep -q '^changed=true$' <<<"$out" || fail "expected changed=true"
grep -q '^chart-ref=oci://127.0.0.1:'"$PORT"'/valley/valley$' <<<"$out" || fail "bad chart-ref"

# Up to date, with a leading v
out=$(CHANNEL=stable CURRENT_VERSION=v0.61.0 scripts/resolve.sh)
grep -q '^changed=false$' <<<"$out" || fail "expected changed=false"

# Wrong password is a clear error
if CHANNEL=stable CURRENT_VERSION=0.61.0 REGISTRY_PASSWORD=wrong scripts/resolve.sh 2>/dev/null; then fail "expected auth failure"; fi

# No pointer on the alpha channel is a clear error
if out=$(CHANNEL=alpha CURRENT_VERSION=0.61.0 scripts/resolve.sh 2>&1); then fail "expected missing pointer failure"; fi
grep -q "no 'alpha' pointer" <<<"$out" || fail "unexpected alpha error: $out"

echo "all resolve.sh tests passed"
