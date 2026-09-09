import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildRecoveryEnvironment,
  homebrewRecoveryAnchor,
  inspectRuntimeBinding,
  promoteRuntimeBinding,
} from "../experiments/gondolin/runtime-binding.mjs";

function temporaryRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
    return;
  }
  chmodSync(path, 0o600);
}

function writeExecutable(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(path, 0o700);
}

async function activeBindingFixture() {
  const temporary = temporaryRoot("pi-runtime-binding-active-");
  const nodePath = join(temporary.root, "fixtures", "node-26.8.1");
  writeExecutable(nodePath);
  const binding = await promoteRuntimeBinding({
    deploymentRoot: temporary.root,
    canonicalNodePath: realpathSync(nodePath),
    nodeVersion: "v26.8.1",
    qualifiedAt: "2026-09-09T12:00:00.000Z",
    source: "homebrew",
    qualificationGate: async () => true,
  });
  return { ...temporary, binding, nodePath: realpathSync(nodePath) };
}

test("Homebrew recovery anchors accept only canonical Node keg paths", () => {
  assert.equal(
    homebrewRecoveryAnchor("/opt/homebrew/Cellar/node/26.8.1/bin/node"),
    "/opt/homebrew/opt/node/bin/node",
  );
  assert.equal(
    homebrewRecoveryAnchor("/usr/local/Cellar/node/24.7.0_1/bin/node"),
    "/usr/local/opt/node/bin/node",
  );

  for (const path of [
    "/opt/homebrew/bin/node",
    "/tmp/Cellar/node/26.8.1/bin/node",
    "/opt/homebrew/Cellar/node/../bin/node",
    "/opt/homebrew/Cellar/node/26.8.1/bin/node\nother",
  ]) {
    assert.throws(
      () => homebrewRecoveryAnchor(path),
      /node-runtime-layout-unsupported/,
      path,
    );
  }
});

test("the recovery environment excludes caller secrets and project state", () => {
  const environment = buildRecoveryEnvironment({
    deploymentRoot: "/Users/test/.local/share/pi-harness-challenger/gondolin-rpc/v3",
    home: "/Users/test",
  });

  assert.deepEqual(environment, {
    HOME: "/Users/test",
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    PI_GONDOLIN_DEPLOYMENT_ROOT: "/Users/test/.local/share/pi-harness-challenger/gondolin-rpc/v3",
    TMPDIR: "/Users/test/.local/share/pi-harness-challenger/gondolin-rpc/v3/tmp",
  });
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.PWD, undefined);
});

test("a qualified runtime binding is immutable and activated atomically", async () => {
  const { root, cleanup } = temporaryRoot("pi-runtime-binding-");
  try {
    const nodePath = join(root, "fixtures", "node-26.8.1");
    writeExecutable(nodePath);
    const node = realpathSync(nodePath);
    const seen = [];

    const binding = await promoteRuntimeBinding({
      deploymentRoot: root,
      canonicalNodePath: node,
      nodeVersion: "v26.8.1",
      qualifiedAt: "2026-09-09T12:00:00.000Z",
      source: "homebrew",
      qualificationGate: async (candidate) => {
        seen.push(candidate);
        return true;
      },
    });

    assert.deepEqual(seen, [node]);
    assert.equal(readlinkSync(join(root, "node-current")), `node-bindings/${binding.bindingId}`);
    assert.equal(readlinkSync(join(binding.bindingRoot, "node")), node);
    assert.equal(binding.active, true);
    assert.equal(
      inspectRuntimeBinding({ deploymentRoot: root, requireExecutable: true }).bindingId,
      binding.bindingId,
    );
    assert.equal(lstatSync(binding.bindingRoot).mode & 0o077, 0);
  } finally {
    cleanup();
  }
});

test("a failed qualification never changes the active runtime", async () => {
  const { root, cleanup } = temporaryRoot("pi-runtime-binding-refusal-");
  try {
    const activeNodePath = join(root, "fixtures", "node-26.7.0");
    const candidateNodePath = join(root, "fixtures", "node-26.8.1");
    writeExecutable(activeNodePath);
    writeExecutable(candidateNodePath);
    const activeNode = realpathSync(activeNodePath);
    const candidateNode = realpathSync(candidateNodePath);
    await promoteRuntimeBinding({
      deploymentRoot: root,
      canonicalNodePath: activeNode,
      nodeVersion: "v26.7.0",
      qualifiedAt: "2026-09-01T12:00:00.000Z",
      source: "install",
      qualificationGate: async () => true,
    });
    const before = readlinkSync(join(root, "node-current"));

    await assert.rejects(
      promoteRuntimeBinding({
        deploymentRoot: root,
        canonicalNodePath: candidateNode,
        nodeVersion: "v26.8.1",
        qualifiedAt: "2026-09-09T12:00:00.000Z",
        source: "homebrew-recovery",
        qualificationGate: async () => false,
      }),
      /node-runtime-qualification-refused/,
    );

    assert.equal(readlinkSync(join(root, "node-current")), before);
  } finally {
    cleanup();
  }
});

test("runtime binding inputs fail closed before creating deployment state", async () => {
  assert.throws(
    () => buildRecoveryEnvironment({ deploymentRoot: "relative", home: "/Users/test" }),
    /node-runtime-path-invalid/,
  );
  assert.throws(
    () => buildRecoveryEnvironment({ deploymentRoot: "/private/deployment", home: "/Users/test\nother" }),
    /node-runtime-path-invalid/,
  );

  const { root, cleanup } = temporaryRoot("pi-runtime-binding-inputs-");
  try {
    const nodePath = join(root, "fixtures", "node");
    writeExecutable(nodePath);
    const canonicalNodePath = realpathSync(nodePath);
    const baseline = {
      deploymentRoot: root,
      canonicalNodePath,
      nodeVersion: "v26.8.1",
      qualifiedAt: "2026-09-09T12:00:00.000Z",
      source: "homebrew",
      qualificationGate: async () => true,
    };
    const invalidCases = [
      [{ ...baseline, nodeVersion: "26.8.1" }, /node-runtime-version-invalid/],
      [{ ...baseline, qualifiedAt: "2026-09-09" }, /node-runtime-qualified-at-invalid/],
      [{ ...baseline, source: "path" }, /node-runtime-source-invalid/],
      [{ ...baseline, qualificationGate: null }, /node-runtime-qualification-gate-missing/],
    ];
    for (const [input, expected] of invalidCases) {
      await assert.rejects(promoteRuntimeBinding(input), expected);
    }

    chmodSync(nodePath, 0o600);
    await assert.rejects(
      promoteRuntimeBinding(baseline),
      /node-runtime-executable-unsafe/,
    );
    chmodSync(nodePath, 0o700);
    const nodeAlias = join(root, "fixtures", "node-alias");
    symlinkSync(nodePath, nodeAlias);
    await assert.rejects(
      promoteRuntimeBinding({ ...baseline, canonicalNodePath: nodeAlias }),
      /node-runtime-executable-unsafe/,
    );
  } finally {
    cleanup();
  }
});

test("runtime binding inspection refuses mutable or malformed active state", async () => {
  const mutations = [
    {
      name: "public binding directory",
      mutate: ({ binding }) => chmodSync(binding.bindingRoot, 0o755),
      expected: /node-runtime-binding-directory-unsafe/,
    },
    {
      name: "public metadata",
      mutate: ({ binding }) => {
        chmodSync(binding.bindingRoot, 0o700);
        chmodSync(join(binding.bindingRoot, "binding.json"), 0o644);
      },
      expected: /node-runtime-binding-file-unsafe/,
    },
    {
      name: "regular node entry",
      mutate: ({ binding }) => {
        chmodSync(binding.bindingRoot, 0o700);
        unlinkSync(join(binding.bindingRoot, "node"));
        writeFileSync(join(binding.bindingRoot, "node"), "not-a-link\n", { mode: 0o600 });
      },
      expected: /node-runtime-binding-node-unsafe/,
    },
    {
      name: "changed manifest",
      mutate: ({ binding }) => {
        chmodSync(binding.bindingRoot, 0o700);
        chmodSync(join(binding.bindingRoot, "binding.sha256"), 0o600);
        writeFileSync(join(binding.bindingRoot, "binding.sha256"), "tampered\n");
      },
      expected: /node-runtime-binding-manifest-mismatch/,
    },
    {
      name: "unsafe current target",
      mutate: ({ root }) => {
        unlinkSync(join(root, "node-current"));
        symlinkSync("../outside", join(root, "node-current"));
      },
      expected: /node-runtime-current-unsafe/,
    },
    {
      name: "regular current entry",
      mutate: ({ root }) => {
        unlinkSync(join(root, "node-current"));
        writeFileSync(join(root, "node-current"), "not-a-link\n", { mode: 0o600 });
      },
      expected: /node-runtime-current-unsafe/,
    },
  ];

  for (const mutation of mutations) {
    const fixture = await activeBindingFixture();
    try {
      mutation.mutate(fixture);
      assert.throws(
        () => inspectRuntimeBinding({ deploymentRoot: fixture.root, requireExecutable: true }),
        mutation.expected,
        mutation.name,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("a broken historical binding remains inspectable but cannot execute", async () => {
  const fixture = await activeBindingFixture();
  try {
    unlinkSync(fixture.nodePath);
    const evidence = inspectRuntimeBinding({
      deploymentRoot: fixture.root,
      requireExecutable: false,
    });
    assert.equal(evidence.nodeVersion, "v26.8.1");
    assert.throws(
      () => inspectRuntimeBinding({ deploymentRoot: fixture.root, requireExecutable: true }),
      /ENOENT/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("the same Homebrew runtime can be requalified as a distinct immutable generation", async () => {
  const fixture = await activeBindingFixture();
  try {
    const previousBindingId = fixture.binding.bindingId;
    const nextInput = {
      deploymentRoot: fixture.root,
      canonicalNodePath: fixture.nodePath,
      nodeVersion: "v26.8.1",
      qualifiedAt: "2026-09-10T12:00:00.000Z",
      source: "homebrew-recovery",
      qualificationGate: async () => true,
    };
    const next = await promoteRuntimeBinding(nextInput);

    assert.notEqual(next.bindingId, previousBindingId);
    assert.equal(existsSync(join(fixture.root, "node-bindings", previousBindingId)), true);
    assert.equal(readlinkSync(join(fixture.root, "node-current")), `node-bindings/${next.bindingId}`);
    await assert.rejects(
      promoteRuntimeBinding(nextInput),
      /node-runtime-binding-exists/,
    );
  } finally {
    fixture.cleanup();
  }
});
