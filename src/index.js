import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { Registry } from "./registry.js";
import { CHANNELS, normalizeVersion, resolveTarget } from "./resolve.js";

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
  core.setSecret(password);

  // Resolve
  const scheme = process.env.VALLEY_REGISTRY_SCHEME ?? "https"; // http only for the test mock
  const registry = new Registry({ host, repo: `${PROJECT}/${channel.chart}`, username, password, scheme });
  core.setSecret(await registry.login());
  const target = await resolveTarget(registry, channel);
  const changed = target.version !== current;

  // Outputs
  core.setOutput("changed", String(changed));
  core.setOutput("target-version", target.version);
  core.setOutput("target-digest", target.digest);
  core.setOutput("chart-ref", `oci://${host}/${registry.repo}`);
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
      ])
      .write();
  }
  core.info(`channel=${channelName} current=${current} target=${target.version} changed=${changed}`);
}

run().catch((err) => core.setFailed(err.message));
