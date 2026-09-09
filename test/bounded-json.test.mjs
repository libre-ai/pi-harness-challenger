import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readBoundedJsonResponse } from "../experiments/gondolin/bounded-json.mjs";
import {
  candidateInstallArguments,
  readSupplyChainPolicy,
  registryViewArguments,
  validateSupplyChainPolicy,
} from "../experiments/gondolin/deployment-controller.mjs";

const MAX_BYTES = 128 * 1024;

function jsonWithExactBytes(byteLength) {
  const prefix = '{"value":"';
  const suffix = '"}';
  return `${prefix}${"a".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

test("bounded JSON accepts responses below and exactly at the byte limit", async () => {
  for (const size of [64, MAX_BYTES]) {
    const body = jsonWithExactBytes(size);
    const response = new Response(body, {
      headers: {
        "content-length": String(size),
        "content-type": "application/json; charset=utf-8",
      },
    });
    const parsed = await readBoundedJsonResponse(response, { maxBytes: MAX_BYTES });
    assert.equal(parsed.value.length, size - 12);
  }
});

test("bounded JSON rejects declared and streamed overflow and cancels the stream", async (t) => {
  await t.test("declared overflow", async () => {
    const response = new Response("{}", {
      headers: {
        "content-length": String(MAX_BYTES + 1),
        "content-type": "application/json",
      },
    });
    await assert.rejects(readBoundedJsonResponse(response, { maxBytes: MAX_BYTES }), /release-descriptor-too-large/);
  });

  await t.test("streamed overflow", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BYTES));
        controller.enqueue(new Uint8Array([0x20]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, { headers: { "content-type": "application/json" } });
    await assert.rejects(readBoundedJsonResponse(response, { maxBytes: MAX_BYTES }), /release-descriptor-too-large/);
    assert.equal(cancelled, true);
  });
});

test("bounded JSON refuses media type, body, UTF-8, and JSON ambiguity", async (t) => {
  const cases = [
    ["media type", new Response("{}", { headers: { "content-type": "text/plain" } }), /release-descriptor-media-type-invalid/],
    ["missing body", new Response(null, { headers: { "content-type": "application/json" } }), /release-descriptor-body-missing/],
    ["fatal UTF-8", new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }), /release-descriptor-utf8-invalid/],
    ["invalid JSON", new Response("{", { headers: { "content-type": "application/json" } }), /release-descriptor-json-invalid/],
  ];
  for (const [name, response, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(readBoundedJsonResponse(response, { maxBytes: MAX_BYTES }), expected);
    });
  }
});

test("the supply-chain policy is exact, HTTPS-only, and honestly non-sovereign", () => {
  const root = new URL("..", import.meta.url).pathname;
  const policy = JSON.parse(readFileSync(join(root, "experiments", "gondolin", "supply-chain-policy.json"), "utf8"));
  assert.deepEqual(Object.keys(policy), [
    "version",
    "profile",
    "sovereigntyStatus",
    "releaseDescriptorUrl",
    "registryUrl",
  ]);
  assert.deepEqual(policy, {
    version: 1,
    profile: "upstream-exception",
    sovereigntyStatus: "not-sovereign",
    releaseDescriptorUrl: "https://pi.dev/api/latest-version",
    registryUrl: "https://registry.npmjs.org/",
  });
  assert.equal(new URL(policy.releaseDescriptorUrl).protocol, "https:");
  assert.equal(new URL(policy.registryUrl).protocol, "https:");
  assert.deepEqual(readSupplyChainPolicy(), policy);
  assert.throws(
    () => validateSupplyChainPolicy({ ...policy, registryUrl: "http://registry.invalid/" }),
    /supply-chain-policy-registry-url-invalid/,
  );
  assert.throws(
    () => validateSupplyChainPolicy({ ...policy, command: "npm install" }),
    /supply-chain-policy-schema-invalid/,
  );
});

test("npm supply commands pin the manifested registry instead of caller sentinels", () => {
  const policy = readSupplyChainPolicy();
  const callerRegistry = "https://attacker.invalid/registry/";
  const callerProxy = "https://proxy-secret.invalid/";
  const previousRegistry = process.env.NPM_CONFIG_REGISTRY;
  const previousProxy = process.env.HTTPS_PROXY;
  process.env.NPM_CONFIG_REGISTRY = callerRegistry;
  process.env.HTTPS_PROXY = callerProxy;
  try {
    const view = registryViewArguments(policy, "@earendil-works/pi-coding-agent", "1.2.3");
    const install = candidateInstallArguments(policy, "/private/candidate", {
      packageName: "@earendil-works/pi-coding-agent",
      version: "1.2.3",
    });
    for (const args of [view, install]) {
      const registryIndex = args.indexOf("--registry");
      assert.notEqual(registryIndex, -1);
      assert.equal(args[registryIndex + 1], policy.registryUrl);
      assert.equal(args.includes(callerRegistry), false);
      assert.equal(args.includes(callerProxy), false);
    }
  } finally {
    if (previousRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = previousRegistry;
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousProxy;
  }
});
