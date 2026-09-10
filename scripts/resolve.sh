#!/usr/bin/env bash
#
# Resolves the Valley chart version a customer should run.
#
# Follows the channel pointer tag ("stable" or "alpha") in the Rein registry, finds the
# fixed semver tag that shares its digest, and compares it with the version the customer
# runs today. Talks plain OCI distribution API with curl, so a pull-only login is enough.
#
# Env in:  REGISTRY, CHANNEL, CURRENT_VERSION, REGISTRY_USERNAME, REGISTRY_PASSWORD
# Env opt: PROJECT (default valley), MAX_CANDIDATES (default 50), REGISTRY_SCHEME (default https, tests only)
# Out:     changed, target-version, target-digest, chart-ref (to $GITHUB_OUTPUT or stdout)

set -euo pipefail

: "${REGISTRY:?REGISTRY is required}"
: "${CHANNEL:?CHANNEL is required}"
: "${CURRENT_VERSION:?CURRENT_VERSION is required}"
: "${REGISTRY_USERNAME:?REGISTRY_USERNAME is required}"
: "${REGISTRY_PASSWORD:?REGISTRY_PASSWORD is required}"
PROJECT="${PROJECT:-valley}"
MAX_CANDIDATES="${MAX_CANDIDATES:-50}"
SCHEME="${REGISTRY_SCHEME:-https}"

# Map the channel to its chart, pointer tag, and accepted version shape
case "$CHANNEL" in
  stable) CHART="valley";       POINTER="stable"; SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$' ;;
  alpha)  CHART="valley-alpha"; POINTER="alpha";  SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$' ;;
  *) echo "::error::channel must be 'stable' or 'alpha', got '$CHANNEL'"; exit 1 ;;
esac
REPO="$PROJECT/$CHART"
ACCEPT="application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json"
HDRS="$(mktemp)"
trap 'rm -f "$HDRS"' EXIT

# Writes one key=value output for the action, or prints it when run outside GitHub
emit() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; else echo "$1=$2"; fi
}

# Fetches a pull-scoped bearer token using the registry's advertised auth realm
fetch_token() {
  local hdr realm service
  hdr=$(curl -sS -o /dev/null -D - "$SCHEME://$REGISTRY/v2/" | grep -i '^www-authenticate:' || true)
  realm=$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<<"$hdr")
  service=$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<<"$hdr")
  if [[ -z "$realm" ]]; then
    echo "::error::$REGISTRY did not offer bearer authentication on /v2/"; exit 1
  fi
  curl -sS -f -u "$REGISTRY_USERNAME:$REGISTRY_PASSWORD" "$realm?service=$service&scope=repository:$REPO:pull" | jq -r '.token // .access_token // empty'
}

# Prints the manifest digest for a tag, or nothing when the tag does not exist
digest_of() {
  local code
  code=$(curl -sS -o /dev/null -D "$HDRS" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT" "$SCHEME://$REGISTRY/v2/$REPO/manifests/$1")
  case "$code" in
    200) awk 'tolower($1)=="docker-content-digest:"{gsub("\r","",$2); print $2}' "$HDRS" ;;
    404) return 0 ;;
    401|403) echo "::error::$REGISTRY refused access to $REPO (HTTP $code). Check the registry username and password."; exit 1 ;;
    *) echo "::error::unexpected HTTP $code fetching $REPO:$1"; exit 1 ;;
  esac
}

# Lists every tag in the repository, following Link pagination
list_tags() {
  local url="$SCHEME://$REGISTRY/v2/$REPO/tags/list?n=100" body link
  while [[ -n "$url" ]]; do
    body=$(curl -sS -f -D "$HDRS" -H "Authorization: Bearer $TOKEN" "$url")
    jq -r '.tags[]?' <<<"$body"
    link=$(sed -n 's/^[Ll]ink: <\([^>]*\)>.*/\1/p' "$HDRS" | tr -d '\r')
    if [[ -z "$link" ]]; then url=""; elif [[ "$link" == /* ]]; then url="$SCHEME://$REGISTRY$link"; else url="$link"; fi
  done
}

# Authenticate once and keep the token out of the logs
TOKEN=$(fetch_token)
if [[ -z "$TOKEN" ]]; then
  echo "::error::could not obtain a registry token for $REPO. Check the registry username and password."; exit 1
fi
echo "::add-mask::$TOKEN"

# Follow the pointer tag to a digest
POINTER_DIGEST=$(digest_of "$POINTER")
if [[ -z "$POINTER_DIGEST" ]]; then
  echo "::error::no '$POINTER' pointer in $REGISTRY/$REPO. Rein has not promoted a version on this channel yet. Contact Rein support."; exit 1
fi

# Sorts versions newest first by padding each numeric part (works for X.Y.Z and X.Y.Z-alpha.N)
sort_versions_desc() {
  awk '{ n = split($0, p, /[^0-9]+/); printf "%08d%08d%08d%08d %s\n", p[1], p[2], p[3], (n >= 4 ? p[4] : 0), $0 }' | sort -r | cut -d' ' -f2
}

# Newest semver tags first, then find the one that shares the pointer's digest
CANDIDATES=()
while IFS= read -r t; do CANDIDATES+=("$t"); done < <(list_tags | grep -E "$SEMVER_RE" | sort_versions_desc | head -n "$MAX_CANDIDATES")
TARGET=""
for tag in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
  if [[ "$(digest_of "$tag")" == "$POINTER_DIGEST" ]]; then TARGET="$tag"; break; fi
done
if [[ -z "$TARGET" ]]; then
  echo "::error::'$POINTER' points at $POINTER_DIGEST but no version tag among the newest $MAX_CANDIDATES shares it. Contact Rein support."; exit 1
fi

# Compare with what the customer runs today
CURRENT="${CURRENT_VERSION#v}"
if [[ "$CURRENT" == "$TARGET" ]]; then CHANGED="false"; else CHANGED="true"; fi

emit changed "$CHANGED"
emit target-version "$TARGET"
emit target-digest "$POINTER_DIGEST"
emit chart-ref "oci://$REGISTRY/$REPO"

# Human-readable summary in the run page
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Valley update check"
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| Channel | \`$CHANNEL\` |"
    echo "| You run | \`$CURRENT\` |"
    echo "| You should run | \`$TARGET\` |"
    echo "| Update needed | **$CHANGED** |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
echo "channel=$CHANNEL current=$CURRENT target=$TARGET changed=$CHANGED"
