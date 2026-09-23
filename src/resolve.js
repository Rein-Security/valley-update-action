import { RegistryError } from "./registry.js";

/**
 * Release channels: which chart to look at. A channel is a chart repository, and any version tag in it
 * can be the promoted one, whatever its prerelease suffix. The promoted version carries the tag
 * "stable"; its digest identifies it.
 */
const SEMVER_TAG = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PROMOTED_TAG = "stable";
export const CHANNELS = {
  stable: { chart: "valley", pointer: PROMOTED_TAG, versionRe: SEMVER_TAG },
  alpha: { chart: "valley-alpha", pointer: PROMOTED_TAG, versionRe: SEMVER_TAG },
};

const DEFAULT_MAX_CANDIDATES = 50;

/**
 * Splits a version into { core: [X, Y, Z], pre: [identifiers...] }. Prerelease identifiers stay as
 * strings so "0.rc1" and "20260101" both survive; compareIdentifiers applies the semver rules.
 */
export function versionKey(version) {
  const [corePart, ...preParts] = version.split("-");
  const pre = preParts.length ? preParts.join("-").split(".") : null;
  return { core: corePart.split(".").map(Number), pre };
}

/**
 * Semver prerelease identifier order: numeric identifiers compare numerically and sort before
 * alphanumeric ones, which compare lexically.
 */
function compareIdentifiers(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver comparison: negative when a is older than b. A release sorts above its own prereleases,
 * and prereleases compare identifier by identifier, a shorter list losing to a longer equal prefix.
 */
export function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i++) {
    const diff = (ka.core[i] ?? 0) - (kb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (ka.pre === null || kb.pre === null) return (ka.pre === null ? 1 : 0) - (kb.pre === null ? 1 : 0);
  for (let i = 0; i < Math.max(ka.pre.length, kb.pre.length); i++) {
    if (ka.pre[i] === undefined) return -1;
    if (kb.pre[i] === undefined) return 1;
    const diff = compareIdentifiers(ka.pre[i], kb.pre[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Returns the versions sorted newest first.
 */
export function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) => compareVersions(b, a));
}

/**
 * Trims whitespace and a leading "v" from a customer-supplied version and checks it is a semver version.
 */
export function normalizeVersion(version) {
  const normalized = String(version ?? "").trim().replace(/^v/, "");
  if (!SEMVER_TAG.test(normalized)) {
    throw new Error(`current-version '${version}' is not a version like 0.61.0. Check the step that reads it from your config: yq prints 'null' when the path does not exist.`);
  }
  return normalized;
}

/**
 * Returns true when moving from `current` to `target` changes the major version.
 */
export function isMajorChange(current, target) {
  return versionKey(current).core[0] !== versionKey(target).core[0];
}

/**
 * Returns true when `target` is an older version than `current` (same rules as sortVersionsDesc).
 */
export function isDowngrade(current, target) {
  return compareVersions(target, current) < 0;
}

/**
 * Follows the channel pointer to the fixed version behind it and returns { version, digest }.
 */
export async function resolveTarget(registry, channel, { maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  // The pointer tells us which digest Rein promoted
  const pointerDigest = await registry.digestOf(channel.pointer);
  if (!pointerDigest) {
    throw new RegistryError(`no '${channel.pointer}' pointer in ${registry.host}/${registry.repo}. Rein has not promoted a version on this channel yet. Contact Rein support.`);
  }

  // Walk version tags newest first until one shares that digest
  const candidates = sortVersionsDesc((await registry.listTags()).filter((t) => channel.versionRe.test(t))).slice(0, maxCandidates);
  for (const tag of candidates) {
    if ((await registry.digestOf(tag)) === pointerDigest) return { version: tag, digest: pointerDigest };
  }
  throw new RegistryError(`'${channel.pointer}' points at ${pointerDigest} but no version tag among the newest ${maxCandidates} shares it. Contact Rein support.`);
}
