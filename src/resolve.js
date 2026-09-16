import { RegistryError } from "./registry.js";

/**
 * Release channels: which chart to look at. A channel is a chart repository; every semver tag in it
 * may name the artifact behind the pointer. The prerelease suffix only says which environment built
 * the chart (dev: -alpha.<epoch>, staging: -preview.<epoch>, prod: none), so it is not a channel
 * marker. Whatever the chart, the promoted version carries the tag "stable"; its digest identifies it.
 */
const SEMVER_TAG = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PROMOTED_TAG = "stable";
export const CHANNELS = {
  stable: { chart: "valley", pointer: PROMOTED_TAG, versionRe: SEMVER_TAG },
  alpha: { chart: "valley-alpha", pointer: PROMOTED_TAG, versionRe: SEMVER_TAG },
};

const DEFAULT_MAX_CANDIDATES = 50;

/**
 * Splits a version into { core: [X, Y, Z], pre: N | null } for X.Y.Z and X.Y.Z-<label>.N.
 */
export function versionKey(version) {
  const [corePart, prePart] = version.split("-", 2);
  const core = corePart.split(".").map(Number);
  const pre = prePart ? Number(prePart.split(".").pop()) : null;
  return { core, pre };
}

/**
 * Returns the versions sorted newest first; a release sorts above its own prereleases, as in semver.
 */
export function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) => {
    const ka = versionKey(a);
    const kb = versionKey(b);
    for (let i = 0; i < 3; i++) {
      const diff = (kb.core[i] ?? 0) - (ka.core[i] ?? 0);
      if (diff !== 0) return diff;
    }
    if (ka.pre === null || kb.pre === null) return (ka.pre === null ? 0 : 1) - (kb.pre === null ? 0 : 1);
    return kb.pre - ka.pre;
  });
}

/**
 * Trims whitespace and a leading "v" from a customer-supplied version.
 */
export function normalizeVersion(version) {
  return String(version).trim().replace(/^v/, "");
}

/**
 * Returns true when moving from `current` to `target` changes the major version.
 */
export function isMajorChange(current, target) {
  return versionKey(current).core[0] !== versionKey(target).core[0];
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
