import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".familiar");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getConfigDir() {
  return CONFIG_DIR;
}

export function getConfigPath() {
  return CONFIG_PATH;
}

export function configExists() {
  return existsSync(CONFIG_PATH);
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] != null && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else if (source[key] !== undefined && source[key] !== null) {
      result[key] = source[key];
    }
  }
  return result;
}

export function saveConfig(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });

  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch { /* fall through */ }
  }

  const merged = deepMerge(existing, data);
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  if (process.platform !== "win32") {
    try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best-effort */ }
  }

  return merged;
}

export function maskSecret(value) {
  if (!value || value.length <= 4) return "***";
  return value.substring(0, 4) + "***";
}
