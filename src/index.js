import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { isLoopback, Registry } from "./registry.js";
import { CHANNELS, isDowngrade, isMajorChange, normalizeVersion, resolveTarget } from "./resolve.js";

const PROJECT = "valley";

/**
 * Reads the action inputs, resolves the target version, and writes outputs and a run summary.
 */
export async function run() {
  // Inputs
  const channelName = core.getInput("channel") || "stable";
  const channel = CHANNELS[channelName];
  if (!channel) throw new Error(`channel must be one of ${Object.keys(CHANNELS).join(", ")}, got '${channelName}'`);
  const host = core.getInput("registry") || "hub.reinsec.app";
  const current = normalizeVersion(core.getInput("current-version", { required: true }));
  const username = core.getInput("registry-username", { required: true });
  const password = core.getInput("registry-password", { required: true });
  const pullChart = core.getBooleanInput("pull-chart");
  const allowMajor = core.getBooleanInput("allow-major");
  const allowDowngrade = core.getBooleanInput("allow-downgrade");
  core.setSecret(password);

  // Resolve
  // Plain http only for the local test registry, never for a real host
  const scheme = process.env.VALLEY_REGISTRY_SCHEME === "http" && isLoopback(host) ? "http" : "https";
  const registry = new Registry({ host, repo: `${PROJECT}/${channel.chart}`, username, password, scheme });
  core.setSecret(await registry.login());
  const target = await resolveTarget(registry, channel);
  const changed = target.version !== current;
  const major = changed && isMajorChange(current, target.version);
  const downgrade = changed && isDowngrade(current, target.version);

  // Outputs, written before the major guard so a failed run still shows what it found
  core.setOutput("changed", String(changed));
  core.setOutput("target-version", target.version);
  core.setOutput("target-digest", target.digest);
  core.setOutput("chart-ref", `oci://${host}/${registry.repo}`);
  core.setOutput("major-change", String(major));
  core.setOutput("downgrade", String(downgrade));

  // Moving backwards is almost always a promotion mistake on Rein's side; refuse it unless the customer opted in
  if (downgrade && !allowDowngrade) {
    throw new Error(`Valley ${target.version} is older than the ${current} you run. The promoted version moved backwards, so this action will not hand it to your apply step. If you really want to roll back, set allow-downgrade: true.`);
  }
  // A major version is a breaking change; refuse it unless the customer opted in
  if (major && !allowMajor) {
    throw new Error(`Valley ${target.version} is a new major version (you run ${current}). Major upgrades may need manual steps, so this action will not hand it to your apply step. Read the release notes at https://github.com/Rein-Security/valley-update-action/releases, then set allow-major: true to proceed.`);
  }
  if (pullChart && changed) {
    const file = await registry.downloadChart(target.version, path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "valley-chart"));
    core.setOutput("chart-file", file);
    core.info(`downloaded ${file}`);
  }

  // Run summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading("Valley update check", 3)
      .addTable([
        ["Channel", `\`${channelName}\``],
        ["You run", `\`${current}\``],
        ["You should run", `\`${target.version}\``],
        ["Update needed", `**${changed}**`],
        ["Major change", `${major}`],
        ["Downgrade", `${downgrade}`],
      ])
      .write();
  }
  core.info(`channel=${channelName} current=${current} target=${target.version} changed=${changed}`);
}

run().catch((err) => core.setFailed(err.message));
