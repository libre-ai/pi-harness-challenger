import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditPiPackageLicenses,
  renderLaunchAgentPlist,
  renderStableLauncherWrapper,
  renderStablePiWrapper,
  verifyCandidatePackage,
} from "../experiments/gondolin/deployment-controller.mjs";
import {
  acquireUpdateLock,
  buildCriticalManifest,
  classifyUpdateRequest,
  compareVersions,
  parseLatestRelease,
  promoteCandidate,
  releaseIdFor,
  rollbackRelease,
  verifyCriticalManifest,
} from "../experiments/gondolin/release-manager.mjs";

function temporaryRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function resolvedLink(path) {
  return readlinkSync(path);
}

test("les cibles update séparant Pi des catalogues et extensions sont explicites", () => {
  const selfCases = [
    ["update"],
    ["update", "pi"],
    ["update", "self"],
    ["update", "--self"],
    ["update", "--self", "--force"],
    ["update", "--all"],
  ];
  for (const args of selfCases) {
    assert.equal(classifyUpdateRequest(args).kind, "self", args.join(" "));
  }
  assert.deepEqual(classifyUpdateRequest(["update", "--all"]), {
    kind: "self",
    force: false,
    updateExtensions: true,
  });
  assert.deepEqual(classifyUpdateRequest(["update", "--self", "--force"]), {
    kind: "self",
    force: true,
    updateExtensions: false,
  });

  const delegatedCases = [
    ["update", "--models"],
    ["update", "--extensions"],
    ["update", "--extension", "npm:example"],
    ["update", "npm:example"],
  ];
  for (const args of delegatedCases) {
    assert.deepEqual(classifyUpdateRequest(args), { kind: "delegate" }, args.join(" "));
  }
  assert.deepEqual(classifyUpdateRequest(["update", "--unknown"]), { kind: "refuse" });
  assert.deepEqual(classifyUpdateRequest(["update", "--self", "--models"]), { kind: "refuse" });
  assert.deepEqual(classifyUpdateRequest(["--version"]), { kind: "execute" });
});

test("la release distante exige le package autorisé, une version exacte et une intégrité npm", () => {
  const release = parseLatestRelease(
    { ok: true, version: "0.82.1", packageName: "@earendil-works/pi-coding-agent" },
    "sha512-test-integrity",
  );
  assert.deepEqual(release, {
    packageName: "@earendil-works/pi-coding-agent",
    version: "0.82.1",
    integrity: "sha512-test-integrity",
  });
  assert.match(releaseIdFor(release), /^0\.82\.1-[a-f0-9]{12}$/);

  assert.throws(
    () => parseLatestRelease({ ok: true, version: "0.82.1", packageName: "attacker" }, "sha512-test"),
    /release-package-refused/,
  );
  assert.throws(
    () => parseLatestRelease({ ok: true, version: "latest", packageName: "@earendil-works\/pi-coding-agent" }, "sha512-test"),
    /release-version-invalid/,
  );
  assert.throws(
    () => parseLatestRelease({ ok: true, version: "0.82.1", packageName: "@earendil-works/pi-coding-agent" }, ""),
    /release-integrity-invalid/,
  );
  assert.equal(compareVersions("0.82.1", "0.80.10"), 1);
  assert.equal(compareVersions("0.82.1", "0.82.1"), 0);
  assert.equal(compareVersions("0.80.10", "0.82.1"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.83.0-beta.10", "0.83.0-beta.2"), 1);
  assert.equal(compareVersions("0.83.0-beta.1", "0.83.0-beta.alpha"), -1);
  assert.equal(compareVersions("0.83.0-beta.1", "0.83.0-beta.1.0"), -1);
});

test("la candidate installée doit correspondre exactement à la version et à l’intégrité npm", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-package-");
  try {
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.82.1",
      bin: { pi: "dist/cli.js" },
    })}\n`);
    writeFileSync(join(packageRoot, "dist", "cli.js"), "cli\n");
    writeFileSync(join(packageRoot, "dist", "rpc-entry.js"), "rpc\n");
    writeFileSync(join(packageRoot, "npm-shrinkwrap.json"), `${JSON.stringify({
      packages: {
        "": { license: "MIT" },
        "node_modules/permissive": { version: "1.0.0", license: "BlueOak-1.0.0" },
      },
    })}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
      packages: {
        "node_modules/@earendil-works/pi-coding-agent": {
          version: "0.82.1",
          integrity: "sha512-test-integrity",
        },
      },
    })}\n`);

    const release = {
      packageName: "@earendil-works/pi-coding-agent",
      version: "0.82.1",
      integrity: "sha512-test-integrity",
    };
    assert.equal(verifyCandidatePackage(root, release), packageRoot);
    assert.deepEqual(auditPiPackageLicenses(packageRoot), {
      packageCount: 2,
      licenses: { "BlueOak-1.0.0": 1, MIT: 1 },
      passes: true,
    });
    assert.throws(
      () => verifyCandidatePackage(root, { ...release, integrity: "sha512-other" }),
      /candidate-integrity-mismatch/,
    );
  } finally {
    cleanup();
  }
});

test("le job launchd appelle uniquement le contrôleur déployé avec des sorties neutralisées", () => {
  const plist = renderLaunchAgentPlist({
    home: "/Users/test&user",
    deploymentRoot: "/Users/test&user/.local/share/pi<guard>",
    piWrapperPath: "/Users/test&user/.local/share/pi<guard>/pi",
  });
  assert.match(plist, /dev\.pi-gondolin\.transactional-update/);
  assert.match(plist, /pi&lt;guard&gt;\/pi/);
  assert.doesNotMatch(plist, /\/opt\/node\/bin\/node/);
  assert.doesNotMatch(plist, /update-local\.mjs/);
  assert.match(plist, /<string>update<\/string>/);
  assert.match(plist, /\/dev\/null/);
  assert.match(plist, /test&amp;user/);
  assert.match(plist, /pi&lt;guard&gt;/);
  assert.doesNotMatch(plist, /StandardOutPath>[\s\S]*\.log/);
});

test("les wrappers stables réparent seulement un binding Node cassé", () => {
  const deploymentRoot = "/Users/test/deployment";
  const nodePath = `${deploymentRoot}/node-current/node`;
  const nodeRecoveryPath = "/opt/homebrew/opt/node/bin/node";
  const launcherPath = `${deploymentRoot}/controller/runtime/experiments/gondolin/safe-rpc-launcher.mjs`;
  const piWrapper = renderStablePiWrapper({
    deploymentRoot,
    nodePath,
    nodeRecoveryPath,
    launcherPath,
  });
  const launcherWrapper = renderStableLauncherWrapper({
    deploymentRoot,
    nodePath,
    nodeRecoveryPath,
    launcherPath,
  });

  for (const wrapper of [piWrapper, launcherWrapper]) {
    assert.match(wrapper, /NODE='\/Users\/test\/deployment\/node-current\/node'/);
    assert.match(wrapper, /RECOVERY_NODE='\/opt\/homebrew\/opt\/node\/bin\/node'/);
    assert.match(wrapper, /if \[ ! -x "\$NODE" \]; then/);
    assert.match(wrapper, /\/usr\/bin\/env -i/);
    assert.match(wrapper, /runtime-repin/);
    assert.doesNotMatch(wrapper, /Cellar\/node/);
    assert.doesNotMatch(wrapper, /OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  }
  assert.equal((piWrapper.match(/controller\.sha256/g) ?? []).length, 1);
  assert.equal((launcherWrapper.match(/controller\.sha256/g) ?? []).length, 1);
});

test("launchd réutilise le wrapper Pi stable sans pinner Node", () => {
  const plist = renderLaunchAgentPlist({
    home: "/Users/test&user",
    deploymentRoot: "/Users/test&user/.local/share/pi<guard>",
    piWrapperPath: "/Users/test&user/.local/share/pi<guard>/pi",
  });

  assert.match(plist, /<string>\/Users\/test&amp;user\/\.local\/share\/pi&lt;guard&gt;\/pi<\/string>/);
  assert.match(plist, /<string>update<\/string>/);
  assert.doesNotMatch(plist, /Cellar\/node|opt\/node\/bin\/node|update-local\.mjs/);
  assert.doesNotMatch(plist, /StandardOutPath>[\s\S]*\.log/);
});

test("l’audit des dépendances Pi refuse les licences interdites ou inconnues", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-license-");
  try {
    writeFileSync(join(root, "npm-shrinkwrap.json"), `${JSON.stringify({
      packages: {
        "": { license: "MIT" },
        "node_modules/forbidden": { version: "1.0.0", license: "AGPL-3.0" },
      },
    })}\n`);
    assert.throws(() => auditPiPackageLicenses(root), /candidate-license-refused/);
  } finally {
    cleanup();
  }
});

test("le verrou update est privé, exclusif et refuse les symlinks", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-lock-");
  try {
    const release = acquireUpdateLock(root);
    assert.throws(() => acquireUpdateLock(root), /update-lock-active/);
    release();
    const secondRelease = acquireUpdateLock(root);
    secondRelease();

    const target = join(root, "lock-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, "update.lock"));
    assert.throws(() => acquireUpdateLock(root), /update-lock-unsafe/);
  } finally {
    cleanup();
  }
});

test("le manifeste critique refuse les chemins hors release, les symlinks et la dérive", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-manifest-");
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "cli.js"), "cli\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    const manifestPath = join(root, "critical.sha256");
    buildCriticalManifest(root, ["dist/cli.js", "package.json"], manifestPath);
    assert.equal(verifyCriticalManifest(root, manifestPath), true);
    assert.match(readFileSync(manifestPath, "utf8"), /dist\/cli\.js/);

    writeFileSync(join(root, "dist", "cli.js"), "tampered\n");
    assert.equal(verifyCriticalManifest(root, manifestPath), false);
    assert.throws(() => buildCriticalManifest(root, ["../outside"], manifestPath), /manifest-path-invalid/);

    writeFileSync(join(root, "real"), "value\n");
    symlinkSync(join(root, "real"), join(root, "linked"));
    assert.throws(() => buildCriticalManifest(root, ["linked"], manifestPath), /manifest-file-unsafe/);
  } finally {
    cleanup();
  }
});

test("une candidate qualifiée est activée atomiquement et conserve la précédente", async () => {
  const { root, cleanup } = temporaryRoot("pi-updater-promote-");
  try {
    const releases = join(root, "releases");
    const candidates = join(root, "candidates");
    const baseline = join(releases, "0.80.10-baseline");
    const candidate = join(candidates, "candidate-new");
    mkdirSync(baseline, { recursive: true, mode: 0o700 });
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    symlinkSync("releases/0.80.10-baseline", join(root, "current"));

    const result = await promoteCandidate({
      deploymentRoot: root,
      candidatePath: candidate,
      releaseId: "0.82.1-qualified",
      qualificationGates: [{ name: "compatibility", run: async () => true }],
      postActivationGate: async () => true,
    });

    assert.deepEqual(result, {
      activated: true,
      releaseId: "0.82.1-qualified",
      gates: ["compatibility"],
    });
    assert.equal(resolvedLink(join(root, "current")), "releases/0.82.1-qualified");
    assert.equal(resolvedLink(join(root, "previous")), "releases/0.80.10-baseline");
  } finally {
    cleanup();
  }
});

test("un gate candidate en échec ne modifie aucun lien actif", async () => {
  const { root, cleanup } = temporaryRoot("pi-updater-refuse-");
  try {
    const baseline = join(root, "releases", "baseline");
    const candidate = join(root, "candidates", "candidate-bad");
    mkdirSync(baseline, { recursive: true, mode: 0o700 });
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    symlinkSync("releases/baseline", join(root, "current"));

    await assert.rejects(
      promoteCandidate({
        deploymentRoot: root,
        candidatePath: candidate,
        releaseId: "candidate-bad",
        qualificationGates: [{ name: "rpc-boundary", run: async () => false }],
        postActivationGate: async () => true,
      }),
      /qualification-gate-refused:rpc-boundary/,
    );
    assert.equal(resolvedLink(join(root, "current")), "releases/baseline");
    assert.throws(() => readlinkSync(join(root, "previous")), /ENOENT/);
  } finally {
    cleanup();
  }
});

test("le rollback de release échange current et previous sans supprimer de preuve", () => {
  const { root, cleanup } = temporaryRoot("pi-updater-rollback-");
  try {
    mkdirSync(join(root, "releases", "current"), { recursive: true });
    mkdirSync(join(root, "releases", "previous"), { recursive: true });
    symlinkSync("releases/current", join(root, "current"));
    symlinkSync("releases/previous", join(root, "previous"));
    assert.deepEqual(rollbackRelease(root), {
      rolledBack: true,
      current: "previous",
      previous: "current",
    });
    assert.equal(resolvedLink(join(root, "current")), "releases/previous");
    assert.equal(resolvedLink(join(root, "previous")), "releases/current");
  } finally {
    cleanup();
  }
});

test("un smoke post-activation en échec restaure exactement current et previous", async () => {
  const { root, cleanup } = temporaryRoot("pi-updater-post-smoke-");
  try {
    const baseline = join(root, "releases", "baseline");
    const older = join(root, "releases", "older");
    const candidate = join(root, "candidates", "candidate-post-fail");
    mkdirSync(baseline, { recursive: true, mode: 0o700 });
    mkdirSync(older, { recursive: true, mode: 0o700 });
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    symlinkSync("releases/baseline", join(root, "current"));
    symlinkSync("releases/older", join(root, "previous"));

    await assert.rejects(
      promoteCandidate({
        deploymentRoot: root,
        candidatePath: candidate,
        releaseId: "candidate-post-fail",
        qualificationGates: [{ name: "candidate", run: async () => true }],
        postActivationGate: async () => false,
      }),
      /post-activation-gate-refused/,
    );
    assert.equal(resolvedLink(join(root, "current")), "releases/baseline");
    assert.equal(resolvedLink(join(root, "previous")), "releases/older");
    assert.equal(lstatSync(candidate).isDirectory(), true);
  } finally {
    cleanup();
  }
});
