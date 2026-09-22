import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Registry, RegistryError } from "../src/registry.js";
import { CHANNELS, compareVersions, isDowngrade, isMajorChange, normalizeVersion, resolveTarget, sortVersionsDesc } from "../src/resolve.js";
import { CHART_BYTES, MOCK_PASSWORD, MOCK_USER, startMockRegistry } from "./mock-registry.js";

let mock;
before(async () => { mock = await startMockRegistry(); });
after(async () => { await mock.close(); });

/**
 * Builds a client against the mock registry for the given channel.
 */
function client(channel, password = MOCK_PASSWORD) {
  return new Registry({ host: `127.0.0.1:${mock.port}`, repo: `valley/${channel.chart}`, username: MOCK_USER, password, scheme: "http" });
}

describe("sortVersionsDesc", () => {
  it("should order stable and alpha versions newest first", () => {
    assert.deepEqual(sortVersionsDesc(["0.9.0", "0.10.0", "0.10.0-alpha.2", "0.10.0-alpha.10"]), ["0.10.0", "0.10.0-alpha.10", "0.10.0-alpha.2", "0.9.0"]);
  });

  it("should apply semver rules to mixed prerelease identifiers such as the dev and PR builds", () => {
    // numeric identifiers sort before alphanumeric ones, and a longer equal prefix wins
    assert.deepEqual(sortVersionsDesc(["0.25.0-alpha.1788691710", "0.25.0-alpha.0.pr1510", "0.25.0-alpha.0", "0.25.0"]),
      ["0.25.0", "0.25.0-alpha.1788691710", "0.25.0-alpha.0.pr1510", "0.25.0-alpha.0"]);
    assert.equal(compareVersions("0.78.0-preview.plat399", "0.84.0-alpha.1788986579") < 0, true);
  });
});

describe("isMajorChange", () => {
  it("should flag only a change of the first version number", () => {
    assert.equal(isMajorChange("0.61.0", "1.0.0"), true);
    assert.equal(isMajorChange("1.2.3", "1.9.0"), false);
    assert.equal(isMajorChange("0.60.0", "0.61.0-alpha.2"), false);
  });
});

describe("CHANNELS", () => {
  it("should accept any semver tag on both channels, reject the pointer name, and point at stable everywhere", () => {
    for (const channel of [CHANNELS.stable, CHANNELS.alpha]) {
      assert.equal(channel.pointer, "stable");
      assert.equal(channel.versionRe.test("0.61.0"), true);
      assert.equal(channel.versionRe.test("0.61.0-preview.1788371032"), true);
      assert.equal(channel.versionRe.test("0.61.0-alpha.1788986579"), true);
      assert.equal(channel.versionRe.test("stable"), false);
    }
  });
});

describe("isDowngrade", () => {
  it("should flag a target older than current and nothing else", () => {
    assert.equal(isDowngrade("0.84.0-alpha.1788986579", "0.78.0-preview.plat399"), true);
    assert.equal(isDowngrade("0.61.0", "0.61.0-alpha.3"), true);
    assert.equal(isDowngrade("0.61.0", "0.62.0"), false);
    assert.equal(isDowngrade("0.61.0", "0.61.0"), false);
    // what the e2e valley runs vs the dev build before it: neither comparison may misfire on "pr1510"
    assert.equal(isDowngrade("0.25.0-alpha.0.pr1510", "0.25.0-alpha.1788691710"), false);
    assert.equal(isDowngrade("0.25.0-alpha.1788691710", "0.25.0-alpha.0.pr1510"), true);
  });
});

describe("normalizeVersion", () => {
  it("should strip a leading v and whitespace", () => {
    assert.equal(normalizeVersion(" v0.61.0\n"), "0.61.0");
  });
});

describe("resolveTarget", () => {
  it("should return the version behind the stable pointer, not the highest tag", async () => {
    const registry = client(CHANNELS.stable);
    await registry.login();
    const target = await resolveTarget(registry, CHANNELS.stable);
    assert.deepEqual(target, { version: "0.61.0", digest: "sha256:aaa" });
  });

  it("should list tags across pages", async () => {
    const registry = client(CHANNELS.stable);
    await registry.login();
    assert.equal((await registry.listTags()).length, 7);
  });

  it("should fail clearly on a wrong password", async () => {
    await assert.rejects(client(CHANNELS.stable, "wrong").login(), (err) => err instanceof RegistryError && /rejected the credentials/.test(err.message));
  });

  it("should fail clearly when the channel has no pointer", async () => {
    const registry = client(CHANNELS.alpha);
    await registry.login();
    await assert.rejects(resolveTarget(registry, CHANNELS.alpha), (err) => err instanceof RegistryError && /no 'stable' pointer in .*valley\/valley-alpha/.test(err.message));
  });
});

describe("downloadChart", () => {
  it("should write the chart layer under the helm file name", async () => {
    const registry = client(CHANNELS.stable);
    await registry.login();
    const dir = await mkdtemp(path.join(os.tmpdir(), "valley-test-"));
    const file = await registry.downloadChart("0.61.0", dir);
    assert.equal(path.basename(file), "valley-0.61.0.tgz");
    assert.deepEqual(await readFile(file), CHART_BYTES);
  });
});
