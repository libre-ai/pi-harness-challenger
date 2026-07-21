import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const piCommand = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8", timeout: 10_000 });
if (piCommand.status !== 0) throw new Error("Unable to resolve pi executable");
let piExecutable = realpathSync(piCommand.stdout.trim());
let piRoot = resolve(dirname(piExecutable), "..");
if (!existsSync(join(piRoot, "package.json"))) {
  const deploymentStatePath = join(homedir(), ".local", "share", "pi-harness-challenger", "gondolin-rpc", "deployment.json");
  if (!existsSync(deploymentStatePath)) throw new Error("Unable to resolve Pi package root");
  piExecutable = JSON.parse(readFileSync(deploymentStatePath, "utf8")).originalPi?.realPath;
  piRoot = resolve(dirname(piExecutable), "..");
}
if (!existsSync(join(piRoot, "package.json"))) throw new Error("Unable to resolve Pi package root");
const candidates = {
  gondolin: join(piRoot, "examples", "extensions", "gondolin", "package-lock.json"),
  sandboxRuntime: join(piRoot, "examples", "extensions", "sandbox", "package-lock.json"),
};
const verifiedOverrides = new Map([
  ["buildcheck@0.0.7", "MIT"],
  ["cpu-features@0.0.10", "MIT"],
  ["ssh2@1.17.0", "MIT"],
]);
const forbiddenPattern = /(?:AGPL|SSPL|BUSL|\bBSL\b)/i;
const acceptedPattern = /(?:MIT|Apache-2\.0|BSD-[23]-Clause|ISC)/i;
const exceptionPath = join(resolve(dirname(new URL(import.meta.url).pathname), ".."), "experiments", "gondolin", "license-exception.json");
const exception = JSON.parse(readFileSync(exceptionPath, "utf8"));
const exceptionPackageRoot = join(dirname(exceptionPath), "node_modules", "tweetnacl");
const artifactHash = (name) => createHash("sha256").update(readFileSync(join(exceptionPackageRoot, name))).digest("hex");
const exceptionArtifactsMatched = exception.approved === true
  && exception.scope?.backend === "@earendil-works/gondolin@0.12.0"
  && exception.scope?.package === "tweetnacl@0.14.5"
  && exception.artifacts?.licenseSha256 === artifactHash("LICENSE")
  && exception.artifacts?.packageJsonSha256 === artifactHash("package.json")
  && exception.artifacts?.runtimeFileSha256 === artifactHash("nacl-fast.js");

function packageName(path) {
  return path.split("node_modules/").at(-1);
}

function audit(path) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  const packages = Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => packagePath.includes("node_modules/"))
    .map(([packagePath, metadata]) => {
      const name = packageName(packagePath);
      const key = `${name}@${metadata.version}`;
      const declared = metadata.license;
      const resolved = declared ?? verifiedOverrides.get(key);
      const exceptionApplied = key === "tweetnacl@0.14.5"
        && resolved === "Unlicense"
        && metadata.integrity === exception.artifacts?.lockfileIntegrity
        && exceptionArtifactsMatched;
      return {
        key,
        license: resolved ?? null,
        source: exceptionApplied ? "hash-pinned-policy-exception" : declared ? "lock" : verifiedOverrides.has(key) ? "verified-exact-tarball" : "missing",
        forbidden: forbiddenPattern.test(resolved ?? ""),
        accepted: exceptionApplied || (acceptedPattern.test(resolved ?? "") && !forbiddenPattern.test(resolved ?? "")),
      };
    });
  const unresolved = packages.filter((item) => !item.license || !item.accepted || item.forbidden);
  const licenseCounts = {};
  for (const item of packages) licenseCounts[item.license ?? "MISSING"] = (licenseCounts[item.license ?? "MISSING"] ?? 0) + 1;
  return {
    packageCount: packages.length,
    licenseCounts,
    exactTarballOverridesUsed: packages.filter((item) => item.source === "verified-exact-tarball").map((item) => item.key),
    policyExceptionsUsed: packages.filter((item) => item.source === "hash-pinned-policy-exception").map((item) => item.key),
    unresolved: unresolved.map((item) => ({ key: item.key, license: item.license })),
    passes: unresolved.length === 0,
  };
}

const results = Object.fromEntries(Object.entries(candidates).map(([name, path]) => [name, audit(path)]));
process.stdout.write(`${JSON.stringify({
  version: 2,
  source: "Pi global package-lock files; no network",
  candidates: results,
  allPass: Object.values(results).every((item) => item.passes),
}, null, 2)}\n`);
