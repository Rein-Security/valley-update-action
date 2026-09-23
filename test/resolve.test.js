import assert from "node:assert/strict";
import { access, readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { isLoopback, Registry, RegistryError } from "../src/registry.js";
import { CHANNELS, compareVersions, isDowngrade, isMajorChange, normalizeVersion, resolveTarget, sortVersionsDesc } from "../src/resolve.js";
import { BAD_BLOB, BAD_HEADER, CHART_BYTES, MOCK_PASSWORD, MOCK_USER, startMockRegistry } from "./mock-registry.js";

let mock;
before(async () => { mock = await startMockRegistry(); });
after(async () => { await mock.close(); });

/**
 * Builds a client against the mock registry for the given channel.
 */
function client(channel, password = MOCK_PASSWORD) {
  return new Registry({ host: `127.0.0.1:${mock.port}`, repo: `valley/${channel.chart}`, username: MOCK_USER, password, scheme: "http" });
}

/**
 * Builds an https client whose fetch is replaced by `handler(url, init)`, and records every request it makes.
 */
function stubClient(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.authorization ?? null });
    return handler(new URL(String(url)), init);
  };
  return { registry: new Registry({ host: "registry.example.com", repo: "valley/valley", username: "u", password: "p", fetchImpl }), calls };
}

describe("sortVersionsDesc", () => {
  it("should order stable and alpha versions newest first", () => {
    assert.deepEqual(sortVersionsDesc(["0.9.0", "0.10.0", "0.10.0-alpha.2", "0.10.0-alpha.10"]), ["0.10.0", "0.10.0-alpha.10", "0.10.0-alpha.2", "0.9.0"]);
  });

  it("should apply semver rules to mixed numeric and alphanumeric prerelease identifiers", () => {
    // numeric identifiers sort before alphanumeric ones, and a longer equal prefix wins
    assert.deepEqual(sortVersionsDesc(["0.25.0-alpha.20260101", "0.25.0-alpha.0.rc1", "0.25.0-alpha.0", "0.25.0"]),
      ["0.25.0", "0.25.0-alpha.20260101", "0.25.0-alpha.0.rc1", "0.25.0-alpha.0"]);
    assert.equal(compareVersions("0.78.0-beta.x1", "0.84.0-alpha.20260101") < 0, true);
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
      assert.equal(channel.versionRe.test("0.61.0-beta.2"), true);
      assert.equal(channel.versionRe.test("0.61.0-alpha.20260101"), true);
      assert.equal(channel.versionRe.test("stable"), false);
    }
  });
});

describe("isDowngrade", () => {
  it("should flag a target older than current and nothing else", () => {
    assert.equal(isDowngrade("0.84.0-alpha.20260101", "0.78.0-beta.x1"), true);
    assert.equal(isDowngrade("0.61.0", "0.61.0-alpha.3"), true);
    assert.equal(isDowngrade("0.61.0", "0.62.0"), false);
    assert.equal(isDowngrade("0.61.0", "0.61.0"), false);
    // a numeric identifier sorts below an alphanumeric one in either direction
    assert.equal(isDowngrade("0.25.0-alpha.0.rc1", "0.25.0-alpha.20260101"), false);
    assert.equal(isDowngrade("0.25.0-alpha.20260101", "0.25.0-alpha.0.rc1"), true);
  });
});

describe("normalizeVersion", () => {
  it("should strip a leading v and whitespace", () => {
    assert.equal(normalizeVersion(" v0.61.0\n"), "0.61.0");
  });

  it("should reject values that are not versions, such as yq's null for a missing path", () => {
    for (const bad of ["null", "", "  ", "latest", "0.61", undefined]) {
      assert.throws(() => normalizeVersion(bad), /is not a version like 0\.61\.0/);
    }
  });
});

describe("Registry transport", () => {
  it("should only allow plain http for loopback hosts", () => {
    assert.equal(isLoopback("127.0.0.1:5000"), true);
    assert.equal(isLoopback("localhost"), true);
    assert.equal(isLoopback("registry.example.com"), false);
    assert.equal(isLoopback("127.0.0.1.example.com"), false);
    assert.throws(() => new Registry({ host: "registry.example.com", repo: "valley/valley", username: "u", password: "p", scheme: "http" }), /only https is supported/);
  });

  it("should refuse a token realm that is not https and never send credentials to it", async () => {
    const { registry, calls } = stubClient((url) => {
      if (url.pathname === "/v2/") return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="http://registry.example.com/service/token",service="x"' } });
      return Response.json({ token: "t" });
    });
    await assert.rejects(registry.login(), (err) => err instanceof RegistryError && /not https/.test(err.message));
    assert.equal(calls.length, 1);
  });

  it("should not follow pagination links to another host with the token", async () => {
    const { registry, calls } = stubClient((url) => {
      if (url.pathname.endsWith("/tags/list")) return Response.json({ tags: ["0.61.0"] }, { headers: { link: '<https://evil.example.net/v2/valley/valley/tags/list?last=x>; rel="next"' } });
      return new Response(null, { status: 404 });
    });
    registry.token = "secret-token";
    await assert.rejects(registry.listTags(), (err) => err instanceof RegistryError && /another host/.test(err.message));
    assert.equal(calls.some((c) => c.url.includes("evil.example.net")), false);
  });
});

describe("resolveTarget", () => {
  it("should return the version behind the stable pointer, not the highest tag", async () => {
    const registry = client(CHANNELS.stable);
    await registry.login();
    const target = await resolveTarget(registry, CHANNELS.stable);
    assert.equal(target.version, "0.61.0");
    assert.equal(target.digest, await registry.digestOf("0.61.0"));
    assert.match(target.digest, /^sha256:[0-9a-f]{64}$/);
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

  it("should reject a manifest whose digest header does not match its body", async () => {
    const registry = client(CHANNELS.stable);
    await registry.login();
    await assert.rejects(registry.digestOf(BAD_HEADER), (err) => err instanceof RegistryError && /integrity check/.test(err.message));
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

  it("should reject and delete a chart whose bytes do not match the layer digest", async () => {
    const registry = client(CHANNELS.stable);
    await registry.login();
    const dir = await mkdtemp(path.join(os.tmpdir(), "valley-test-"));
    await assert.rejects(registry.downloadChart(BAD_BLOB, dir), (err) => err instanceof RegistryError && /integrity check/.test(err.message));
    await assert.rejects(access(path.join(dir, `valley-${BAD_BLOB}.tgz`)));
  });
});
