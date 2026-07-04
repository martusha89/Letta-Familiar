import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function spawnCmd(cmd, args, opts) {
  if (process.platform === "win32") {
    const full = [cmd, ...args].map((a) => a.includes(" ") ? `"${a}"` : a).join(" ");
    return spawn(full, [], { ...opts, shell: true });
  }
  return spawn(cmd, args, opts);
}

export function execWrangler(args, cwd, stdinData) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npx", ["wrangler", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    if (stdinData) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

export function parseD1CreateOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const match = combined.match(/database_id\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function parseDeployOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const match = combined.match(/https:\/\/[^\s)]+\.workers\.dev/);
  return match ? match[0] : null;
}

export function parsePagesDeployOutput(output) {
  const combined = output.stdout + "\n" + output.stderr;
  const allUrls = combined.match(/https:\/\/[^\s)]+\.pages\.dev/g) || [];
  // Production URL has no hash prefix — shortest match wins.
  const production = allUrls.sort((a, b) => a.length - b.length)[0];
  return production || null;
}

export async function checkWranglerAuth(cwd) {
  const result = await execWrangler(["whoami"], cwd);
  if (result.code !== 0) return false;
  const combined = result.stdout + result.stderr;
  return !combined.includes("Not logged in") && !combined.includes("not authenticated");
}

export async function wranglerLogin(cwd) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npx", ["wrangler", "login"], { cwd, stdio: "inherit" });
    proc.on("close", (code) => resolve(code === 0));
  });
}

export async function setSecret(name, value, cwd) {
  return execWrangler(["secret", "put", name], cwd, value + "\n");
}

export async function executeSchema(dbName, schemaPath, cwd) {
  const result = await execWrangler(
    ["d1", "execute", dbName, "--remote", "--file=" + schemaPath],
    cwd,
  );
  if (result.code === 0) return { ok: true, method: "file" };

  const sql = readFileSync(join(cwd, schemaPath), "utf-8");
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    const r = await execWrangler(
      ["d1", "execute", dbName, "--remote", "--command", stmt + ";"],
      cwd,
    );
    if (r.code !== 0) {
      return { ok: false, method: "command", error: r.stderr || r.stdout };
    }
  }
  return { ok: true, method: "command-fallback" };
}

export async function listD1Databases(cwd) {
  const result = await execWrangler(["d1", "list", "--json"], cwd);
  if (result.code !== 0) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}

export function npmInstall(cwd, { production = false } = {}) {
  const args = production ? ["install", "--omit=dev"] : ["install"];
  return new Promise((resolve) => {
    const proc = spawnCmd("npm", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0 && (stderr.includes("ERESOLVE") || stderr.includes("peer dep"))) {
        const retryArgs = [...args, "--legacy-peer-deps"];
        const retry = spawnCmd("npm", retryArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let retryStderr = "";
        retry.stderr.on("data", (d) => { retryStderr += d.toString(); });
        retry.on("close", (retryCode) => {
          resolve({ code: retryCode, stdout, stderr: retryStderr || stderr });
        });
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

export function npmRunBuild(cwd) {
  return new Promise((resolve) => {
    const proc = spawnCmd("npm", ["run", "build"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
