import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  listReleaseManifestFiles,
  verifyCompleteReleaseManifest,
} from "./release-manager.mjs";

function metric(value) {
  return Number(value.toFixed(3));
}

export function benchmarkReleaseIntegrity({ releaseRoot, runs = 20, now = () => performance.now() }) {
  if (!Number.isSafeInteger(runs) || runs < 20) throw new Error("release-integrity-benchmark-runs-invalid");
  const manifestPath = join(releaseRoot, "critical.sha256");
  const fileCount = listReleaseManifestFiles(releaseRoot)
    .filter((path) => path !== "critical.sha256")
    .length;
  const durations = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = now();
    if (!verifyCompleteReleaseManifest(releaseRoot, manifestPath)) {
      throw new Error("release-integrity-benchmark-verification-refused");
    }
    durations.push(now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return {
    fileCount,
    runs,
    medianMs: metric(durations[Math.floor(durations.length / 2)]),
    p95Ms: metric(durations[Math.ceil(durations.length * 0.95) - 1]),
    maxMs: metric(durations.at(-1)),
  };
}

function activeReleaseRoot(deploymentRoot) {
  const currentPath = join(deploymentRoot, "current");
  const stats = lstatSync(currentPath);
  if (!stats.isSymbolicLink()) throw new Error("release-integrity-benchmark-current-unsafe");
  const target = readlinkSync(currentPath);
  if (!/^releases\/[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(target)) {
    throw new Error("release-integrity-benchmark-current-unsafe");
  }
  const releaseRoot = realpathSync(currentPath);
  const releasesRoot = `${realpathSync(join(deploymentRoot, "releases"))}${sep}`;
  if (!releaseRoot.startsWith(releasesRoot)) throw new Error("release-integrity-benchmark-current-unsafe");
  return releaseRoot;
}

function main() {
  const deploymentRoot = process.env.PI_GONDOLIN_DEPLOYMENT_ROOT
    ?? join(homedir(), ".local", "share", "pi-harness-challenger", "gondolin-rpc", "v3");
  const result = benchmarkReleaseIntegrity({ releaseRoot: activeReleaseRoot(deploymentRoot) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
