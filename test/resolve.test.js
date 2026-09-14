import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Registry, RegistryError } from "../src/registry.js";
import { CHANNELS, normalizeVersion, resolveTarget, sortVersionsDesc } from "../src/resolve.js";
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
    await assert.rejects(resolveTarget(registry, CHANNELS.alpha), (err) => err instanceof RegistryError && /no 'alpha' pointer/.test(err.message));
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
