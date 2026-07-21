import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const POLICY_MODES = Object.freeze(["off", "observe", "confirm", "enforce"]);
export const DEFAULT_POLICY_MODE = "observe";
export const POLICY_MODE_RANK = Object.freeze({ off: 0, observe: 1, confirm: 2, enforce: 3 });
export const CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 16 * 1024;

const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  policyMode: DEFAULT_POLICY_MODE,
});

export function normalizePolicyMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return POLICY_MODES.includes(normalized) ? normalized : undefined;
}

export function strongerPolicyMode(left, right) {
  const leftMode = normalizePolicyMode(left) ?? DEFAULT_POLICY_MODE;
  const rightMode = normalizePolicyMode(right);
  if (!rightMode) return leftMode;
  return POLICY_MODE_RANK[rightMode] > POLICY_MODE_RANK[leftMode] ? rightMode : leftMode;
}

export function resolveConfigPath(environment = process.env) {
  if (environment.PI_HARNESS_CHALLENGER_CONFIG) {
    return resolve(environment.PI_HARNESS_CHALLENGER_CONFIG);
  }
  const configHome = environment.XDG_CONFIG_HOME
    ? resolve(environment.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(configHome, "pi-harness-challenger", "config.json");
}

function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration-object-required");
  }
  if (value.version !== CONFIG_VERSION) throw new Error("configuration-version-unsupported");

  const policyMode = normalizePolicyMode(value.policyMode);
  if (!policyMode) throw new Error("configuration-policy-mode-invalid");

  return { version: CONFIG_VERSION, policyMode };
}

function assertRegularFile(path) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("configuration-file-unsafe");
  if (stats.size > MAX_CONFIG_BYTES) throw new Error("configuration-file-too-large");
}

function assertSafeDirectory(path) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("configuration-directory-unsafe");
}

export function createConfigStore(explicitPath) {
  const path = explicitPath ? resolve(explicitPath) : resolveConfigPath();
  const load = () => {
    if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, exists: false };
    assertRegularFile(path);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { config: validateConfig(parsed), exists: true };
  };

  return {
    path,
    load,
    update(patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("configuration-patch-invalid");
      }
      const current = load().config;
      const next = validateConfig({ ...current, ...patch, version: CONFIG_VERSION });
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      assertSafeDirectory(directory);
      chmodSync(directory, 0o700);

      if (existsSync(path)) assertRegularFile(path);
      const temporaryPath = join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        renameSync(temporaryPath, path);
        chmodSync(path, 0o600);
      } catch (error) {
        rmSync(temporaryPath, { force: true });
        throw error;
      }
      return { ...next };
    },
  };
}
