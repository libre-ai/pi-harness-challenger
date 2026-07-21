import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyGuestChangesToHost,
  captureSnapshot,
  collectGuestChanges,
  describeSnapshotRequest,
  importSnapshotToGuest,
  renderGuestChangesPreview,
  validateSnapshotPath,
} from "./snapshot.mjs";

const root = await mkdtemp(join(tmpdir(), "gondolin-snapshot-root-"));
const guestRoot = await mkdtemp(join(tmpdir(), "gondolin-snapshot-guest-"));
const outside = join(await mkdtemp(join(tmpdir(), "gondolin-snapshot-outside-")), "outside.txt");
const original = "#!/bin/sh\nprintf 'before\\n'\n";
const updated = "#!/bin/sh\nprintf 'after\\n'\n";
const hostSource = join(root, "src", "normalize.sh");

function guestTarget(path) {
  assert.ok(path === "/workspace" || path.startsWith("/workspace/"));
  return path === "/workspace" ? guestRoot : join(guestRoot, path.slice("/workspace/".length));
}

const guestFs = {
  mkdir: (path, options) => mkdir(guestTarget(path), options),
  writeFile: async (path, content, options) => {
    await mkdir(dirname(guestTarget(path)), { recursive: true });
    return writeFile(guestTarget(path), content, options);
  },
  readFile: (path, options) => readFile(guestTarget(path), options),
};

try {
  await mkdir(dirname(hostSource), { recursive: true });
  await writeFile(hostSource, original, { mode: 0o700 });
  await writeFile(join(root, "test.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(root, "linked.sh"));

  assert.throws(() => validateSnapshotPath("../escape"), /path-(?:invalid|outside-root)/);
  assert.throws(() => validateSnapshotPath(".env"), /sensitive/);
  assert.throws(() => validateSnapshotPath("unsafe name.sh"), /path-invalid/);
  await assert.rejects(captureSnapshot(root, ["linked.sh"]), /file-invalid/);
  await assert.rejects(describeSnapshotRequest(root, ["src/normalize.sh", "src/normalize.sh"]), /duplicate/);

  const description = await describeSnapshotRequest(root, ["src/normalize.sh", "test.sh"]);
  assert.equal(description.fileCount, 2);
  const snapshot = await captureSnapshot(root, ["src/normalize.sh", "test.sh"]);
  assert.equal(snapshot.fileCount, 2);
  await importSnapshotToGuest(snapshot, guestFs);
  assert.equal(await readFile(join(guestRoot, "src", "normalize.sh"), "utf8"), original);

  await writeFile(join(guestRoot, "src", "normalize.sh"), updated);
  const plan = await collectGuestChanges(snapshot, guestFs);
  assert.equal(plan.changedFiles, 1);
  assert.match(renderGuestChangesPreview(plan), /Apply performed: false/);
  assert.match(renderGuestChangesPreview(plan), /src\/normalize\.sh/);

  await assert.rejects(applyGuestChangesToHost(snapshot, plan, "wrong"), /not-approved/);
  assert.equal(await readFile(hostSource, "utf8"), original);

  const tampered = structuredClone(plan);
  tampered.changes[0].content = "tampered\n";
  await assert.rejects(applyGuestChangesToHost(snapshot, tampered, tampered.planSha256), /plan-tampered/);
  assert.equal(await readFile(hostSource, "utf8"), original);

  await writeFile(hostSource, "concurrent user change\n");
  await assert.rejects(applyGuestChangesToHost(snapshot, plan, plan.planSha256), /host-changed/);
  assert.equal(await readFile(hostSource, "utf8"), "concurrent user change\n");

  await writeFile(hostSource, original, { mode: 0o700 });
  const heldSourceDirectory = join(root, "src-held");
  const outsideDirectory = dirname(outside);
  await writeFile(join(outsideDirectory, "normalize.sh"), original);
  await rename(join(root, "src"), heldSourceDirectory);
  await symlink(outsideDirectory, join(root, "src"));
  await assert.rejects(applyGuestChangesToHost(snapshot, plan, plan.planSha256), /ancestor-invalid/);
  await unlink(join(root, "src"));
  await rename(heldSourceDirectory, join(root, "src"));

  const applied = await applyGuestChangesToHost(snapshot, plan, plan.planSha256);
  assert.equal(applied.appliedFiles, 1);
  assert.equal(await readFile(hostSource, "utf8"), updated);

  console.log("gondolin snapshot: ok (explicit import, preview, approval, TOCTOU and symlink guards)");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(guestRoot, { recursive: true, force: true });
  await rm(dirname(outside), { recursive: true, force: true });
}
