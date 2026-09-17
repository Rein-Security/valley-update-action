import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { MOCK_PASSWORD, MOCK_USER, startMockRegistry } from "./mock-registry.js";

const exec = promisify(execFile);
const ENTRY = process.env.ACTION_ENTRY ?? "src/index.js";

let mock;
before(async () => { mock = await startMockRegistry(); });
after(async () => { await mock.close(); });

/**
 * Runs the action entrypoint the way the runner does: inputs as INPUT_* env vars, outputs in GITHUB_OUTPUT. Returns { outputs, stdout, code }.
 */
async function runAction(inputs) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "valley-action-"));
  const outputFile = path.join(dir, "output");
  await writeFile(outputFile, "");
  const env = { ...process.env, GITHUB_OUTPUT: outputFile, RUNNER_TEMP: dir, INPUT_REGISTRY: `127.0.0.1:${mock.port}`, INPUT_CHANNEL: "stable", "INPUT_REGISTRY-USERNAME": MOCK_USER, "INPUT_REGISTRY-PASSWORD": MOCK_PASSWORD, "INPUT_PULL-CHART": "false", "INPUT_ALLOW-MAJOR": "false", "INPUT_ALLOW-DOWNGRADE": "false" };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  delete env.GITHUB_STEP_SUMMARY;

  let stdout = "";
  let code = 0;
  try {
    ({ stdout } = await exec(process.execPath, [ENTRY], { env, cwd: process.cwd() }));
  } catch (err) {
    stdout = err.stdout ?? "";
    code = err.code ?? 1;
  }

  // GITHUB_OUTPUT uses heredoc-style blocks: name<<delim\nvalue\ndelim
  const outputs = {};
  for (const m of (await readFile(outputFile, "utf8")).matchAll(/^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  return { outputs, stdout, code };
}

// The action only speaks https to real registries; the mock is plain http
process.env.VALLEY_REGISTRY_SCHEME = "http";

describe("action entrypoint", () => {
  it("should report an update for an outdated customer", async () => {
    const { outputs, code } = await runAction({ "current-version": "0.60.0", "pull-chart": "true" });
    assert.equal(code, 0);
    assert.equal(outputs["changed"], "true");
    assert.equal(outputs["target-version"], "0.61.0");
    assert.equal(outputs["chart-ref"], `oci://127.0.0.1:${mock.port}/valley/valley`);
    assert.match(outputs["chart-file"], /valley-0\.61\.0\.tgz$/);
  });

  it("should report no update when already on the target, ignoring a leading v", async () => {
    const { outputs, code } = await runAction({ "current-version": "v0.61.0" });
    assert.equal(code, 0);
    assert.equal(outputs["changed"], "false");
    assert.equal(outputs["chart-file"], undefined);
  });

  // 1.0.0 -> 0.61.0 is also a downgrade, so that guard is switched off to exercise the major one alone
  it("should fail on a major version change and still write outputs", async () => {
    const { outputs, stdout, code } = await runAction({ "current-version": "1.0.0", "allow-downgrade": "true" });
    assert.equal(code, 1);
    assert.match(stdout, /::error::Valley 0\.61\.0 is a new major version \(you run 1\.0\.0\)/);
    assert.equal(outputs["major-change"], "true");
    assert.equal(outputs["target-version"], "0.61.0");
  });

  it("should let a major version through with allow-major", async () => {
    const { outputs, code } = await runAction({
      "current-version": "1.0.0",
      "allow-major": "true",
      "allow-downgrade": "true",
    });
    assert.equal(code, 0);
    assert.equal(outputs["changed"], "true");
    assert.equal(outputs["major-change"], "true");
  });

  it("should fail on a downgrade and still write outputs", async () => {
    const { outputs, stdout, code } = await runAction({ "current-version": "0.62.0" });
    assert.equal(code, 1);
    assert.match(stdout, /::error::Valley 0\.61\.0 is older than the 0\.62\.0 you run/);
    assert.equal(outputs["downgrade"], "true");
    assert.equal(outputs["target-version"], "0.61.0");
  });

  it("should let a downgrade through with allow-downgrade", async () => {
    const { outputs, code } = await runAction({ "current-version": "0.62.0", "allow-downgrade": "true" });
    assert.equal(code, 0);
    assert.equal(outputs["changed"], "true");
    assert.equal(outputs["downgrade"], "true");
  });

  it("should fail with a clear message on a wrong password", async () => {
    const { stdout, code } = await runAction({ "current-version": "0.61.0", "registry-password": "wrong" });
    assert.equal(code, 1);
    assert.match(stdout, /::error::.*rejected the credentials/);
  });
});
