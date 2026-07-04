import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { getPackageRoot, getNodeMajor } from "../lib/platform.js";
import { getConfigDir, saveConfig, getConfigPath, configExists, loadConfig } from "../lib/config-store.js";
import { generateSecret } from "../lib/secrets.js";
import { ask, confirm, password, closePrompts } from "../lib/prompts.js";
import {
  execWrangler, parseD1CreateOutput, parseDeployOutput, parsePagesDeployOutput,
  checkWranglerAuth, wranglerLogin, setSecret, executeSchema,
  listD1Databases, npmInstall, npmRunBuild,
} from "../lib/wrangler.js";
import {
  banner, step, bold, dim, cyan, green, yellow,
  success, fail, warn, info, spinner,
} from "../lib/ui.js";

const TOTAL_STEPS = 5;
const DEPLOY_DIR = join(getConfigDir(), "deploy");

function patchFile(filePath, replacements) {
  let content = readFileSync(filePath, "utf-8");
  for (const [find, replace] of Object.entries(replacements)) {
    content = content.replaceAll(find, replace);
  }
  writeFileSync(filePath, content, "utf-8");
}

async function createD1OrReuse(dbName, cwd) {
  const result = await execWrangler(["d1", "create", dbName], cwd);
  if (result.code === 0) {
    return parseD1CreateOutput(result);
  }
  const combined = result.stdout + result.stderr;
  if (combined.includes("already exists") || combined.includes("already a database")) {
    warn(`Database "${dbName}" already exists. Looking up ID...`);
    const databases = await listD1Databases(cwd);
    const db = databases.find((d) => d.name === dbName);
    if (db) {
      info(`Found: ${db.uuid}`);
      return db.uuid;
    }
    fail("Could not find existing database ID.");
    return null;
  }
  fail(`Failed to create database: ${combined}`);
  return null;
}

export default async function deployCommand() {
  banner();
  console.log(bold("  Familiar — One-time setup\n"));
  info("This deploys your own personal Familiar to your Cloudflare account.");
  info("Your data, your bridge, your URL. Free Cloudflare tier covers it.");
  console.log("");

  if (configExists()) {
    const existing = loadConfig();
    if (existing?.app?.url) info(`Existing deployment: ${cyan(existing.app.url)}`);
    const cont = await confirm("  An existing config was found. Continue and overwrite?");
    if (!cont) {
      closePrompts();
      info("Cancelled.");
      return;
    }
  }

  // ── Preflight ──────────────────────────────────────────────────────

  step(1, TOTAL_STEPS, "Preflight checks");

  const nodeMajor = getNodeMajor();
  if (nodeMajor < 18) {
    fail(`Node.js ${nodeMajor} detected. Need >= 18.`);
    process.exit(1);
  }
  success(`Node.js ${process.version}`);

  const wranglerCheck = await execWrangler(["--version"], ".");
  if (wranglerCheck.code !== 0) {
    fail("Wrangler not found. Install it: npm install -g wrangler");
    process.exit(1);
  }
  success(`Wrangler ${(wranglerCheck.stdout + wranglerCheck.stderr).match(/\d+\.\d+\.\d+/)?.[0] || "installed"}`);

  const authed = await checkWranglerAuth(".");
  if (!authed) {
    warn("Not logged into Cloudflare. Opening browser...");
    const loginOk = await wranglerLogin(".");
    if (!loginOk) {
      fail("Cloudflare login failed.");
      process.exit(1);
    }
  }
  success("Cloudflare authenticated");

  // ── Optional config (Letta + ElevenLabs) ──────────────────────────

  step(2, TOTAL_STEPS, "Optional configuration");
  console.log();
  info("Letta key + ElevenLabs creds are OPTIONAL — you can paste them in the app later.");
  info("Skip with blank input. Letta key never leaves your browser; ElevenLabs lives in your bridge D1.");
  console.log();

  const lettaKey = await password("  Letta API key (sk-let-... or blank to skip)");
  const elevenlabsKey = await password("  ElevenLabs API key (or blank to skip)");
  const elevenlabsVoice = elevenlabsKey ? await ask("  ElevenLabs voice ID (or blank to skip)") : "";
  closePrompts();

  // ── Prepare deploy directory ──────────────────────────────────────

  const pkgRoot = getPackageRoot();

  if (existsSync(DEPLOY_DIR)) {
    rmSync(DEPLOY_DIR, { recursive: true, force: true });
  }
  mkdirSync(DEPLOY_DIR, { recursive: true });

  let s = spinner("Copying source files");
  for (const dir of ["bridge", "app"]) {
    const src = join(pkgRoot, dir);
    const dst = join(DEPLOY_DIR, dir);
    if (!existsSync(src)) {
      s.fail(`Source directory not found: ${src}`);
      process.exit(1);
    }
    // Filter on path segments RELATIVE to the copy root. When installed via
    // npx the package itself lives under a node_modules directory, so testing
    // the absolute path would exclude every file and stage nothing.
    const SKIP_SEGMENTS = new Set(["node_modules", ".wrangler", "dist"]);
    cpSync(src, dst, {
      recursive: true,
      filter: (p) => !relative(src, p).split(/[\\/]/).some((seg) => SKIP_SEGMENTS.has(seg)),
    });
  }
  if (!existsSync(join(DEPLOY_DIR, "bridge", "package.json")) || !existsSync(join(DEPLOY_DIR, "app", "package.json"))) {
    s.fail("Staging failed: deploy workspace is missing source files.");
    process.exit(1);
  }
  s.stop("Source files staged in deploy workspace");

  const bridgeDir = join(DEPLOY_DIR, "bridge");
  const appDir = join(DEPLOY_DIR, "app");
  const tomlPath = join(bridgeDir, "wrangler.toml");

  // ── Deploy bridge ─────────────────────────────────────────────────

  step(3, TOTAL_STEPS, "Deploying bridge");

  s = spinner("Installing bridge dependencies");
  const bridgeInstall = await npmInstall(bridgeDir, { production: true });
  if (bridgeInstall.code !== 0) {
    s.fail("npm install failed in bridge/");
    console.log(dim(bridgeInstall.stderr));
    process.exit(1);
  }
  s.stop("Bridge dependencies installed");

  // Pick a unique bridge name so deployments don't collide with someone else's.
  const suffix = generateSecret().replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  const bridgeName = `familiar-bridge-${suffix}`;
  const dbName = `familiar-bridge-db-${suffix}`;

  // Patch wrangler.toml with anchored full-line replacements. "familiar-bridge"
  // is a prefix of "familiar-bridge-db", so bare substring swaps mangle the db name.
  patchFile(tomlPath, {
    'name = "familiar-bridge"': `name = "${bridgeName}"`,
    'database_name = "familiar-bridge-db"': `database_name = "${dbName}"`,
  });

  s = spinner("Creating database");
  const d1Id = await createD1OrReuse(dbName, bridgeDir);
  if (!d1Id) process.exit(1);
  s.stop(`Database created (${dim(d1Id.substring(0, 8) + "...")})`);

  // Inject the real D1 id into wrangler.toml, whatever id the packaged copy carries.
  writeFileSync(
    tomlPath,
    readFileSync(tomlPath, "utf-8").replace(/database_id = "[^"]*"/, `database_id = "${d1Id}"`),
    "utf-8",
  );

  // Optional ElevenLabs secrets
  if (elevenlabsKey) {
    s = spinner("Setting ElevenLabs secret");
    await setSecret("ELEVENLABS_API_KEY", elevenlabsKey, bridgeDir);
    if (elevenlabsVoice) {
      await setSecret("ELEVENLABS_VOICE_ID", elevenlabsVoice, bridgeDir);
    }
    s.stop("ElevenLabs configured");
  }

  s = spinner("Initializing database schema");
  const schemaResult = await executeSchema(dbName, "schema.sql", bridgeDir);
  if (!schemaResult.ok) {
    s.fail(`Schema failed: ${schemaResult.error}`);
    process.exit(1);
  }
  s.stop(`Schema initialized (${schemaResult.method})`);

  s = spinner("Creating audio storage (R2 bucket)");
  const r2Result = await execWrangler(["r2", "bucket", "create", "familiar-audio"], bridgeDir);
  const r2Out = r2Result.stdout + r2Result.stderr;
  if (r2Result.code === 0 || /already exists|already owned/i.test(r2Out)) {
    s.stop("Audio storage ready");
  } else {
    // R2 must be enabled once per Cloudflare account (needs a card on file,
    // even on the free tier). Everything except voice notes works without it,
    // so strip the binding and let the worker deploy anyway.
    writeFileSync(
      tomlPath,
      readFileSync(tomlPath, "utf-8").replace(/# Audio storage[\s\S]*?bucket_name = "[^"]*"\s*/, ""),
      "utf-8",
    );
    s.stop("R2 unavailable, continuing without voice-note storage");
    warn("Voice notes are disabled. Enable R2 in your Cloudflare dashboard, then re-run deploy to add them.");
  }

  s = spinner("Deploying bridge worker");
  const bridgeDeploy = await execWrangler(["deploy"], bridgeDir);
  const bridgeUrl = parseDeployOutput(bridgeDeploy);
  if (!bridgeUrl) {
    s.fail("Bridge deploy failed — could not parse URL");
    console.log(dim(bridgeDeploy.stdout + "\n" + bridgeDeploy.stderr));
    process.exit(1);
  }
  s.stop(`Bridge deployed: ${cyan(bridgeUrl)}`);

  // ── Deploy app ────────────────────────────────────────────────────

  step(4, TOTAL_STEPS, "Deploying app");

  s = spinner("Installing app dependencies (this takes a minute)");
  const appInstall = await npmInstall(appDir);
  if (appInstall.code !== 0) {
    s.fail("npm install failed in app/");
    console.log(dim(appInstall.stderr));
    process.exit(1);
  }
  s.stop("App dependencies installed");

  // Bake the bridge URL into the app build
  const envContent = `VITE_BRIDGE_URL=${bridgeUrl}\n`;
  writeFileSync(join(appDir, ".env"), envContent, "utf-8");
  writeFileSync(join(appDir, ".env.local"), envContent, "utf-8");
  info(`.env written: VITE_BRIDGE_URL=${bridgeUrl}`);

  s = spinner("Building app (1-2 min — grab a coffee)");
  const buildResult = await npmRunBuild(appDir);
  if (buildResult.code !== 0) {
    s.fail("Build failed");
    console.log(dim(buildResult.stderr));
    process.exit(1);
  }

  // Sanity check: the bridge URL should be in the bundle
  try {
    const distAssets = readdirSync(join(appDir, "dist", "assets"));
    const indexJs = distAssets.find((f) => f.startsWith("index-") && f.endsWith(".js"));
    if (indexJs) {
      const bundle = readFileSync(join(appDir, "dist", "assets", indexJs), "utf-8");
      if (!bundle.includes(bridgeUrl)) {
        warn("Bridge URL not found in built bundle (vite may have inlined differently — usually fine).");
      }
    }
  } catch { /* non-fatal */ }
  s.stop("App built");

  // Pages project name — unique per install
  const pagesProjectName = `familiar-${suffix}`;

  s = spinner(`Deploying to Cloudflare Pages (${pagesProjectName})`);
  let pagesDeploy = await execWrangler(
    ["pages", "deploy", "dist", `--project-name=${pagesProjectName}`, "--branch=main", "--commit-dirty=true"],
    appDir,
  );
  if (pagesDeploy.code !== 0) {
    const msg = pagesDeploy.stdout + pagesDeploy.stderr;
    if (msg.includes("Project not found") || msg.includes("could not find") || msg.includes("8000007")) {
      s.stop("Creating Pages project...");
      await execWrangler(["pages", "project", "create", pagesProjectName, "--production-branch=main"], appDir);
      s = spinner(`Deploying to Cloudflare Pages (${pagesProjectName})`);
      pagesDeploy = await execWrangler(
        ["pages", "deploy", "dist", `--project-name=${pagesProjectName}`, "--branch=main", "--commit-dirty=true"],
        appDir,
      );
    }
  }
  let appUrl = parsePagesDeployOutput(pagesDeploy);
  const productionUrl = `https://${pagesProjectName}.pages.dev`;
  if (!appUrl || (appUrl.includes(pagesProjectName) && appUrl !== productionUrl)) {
    appUrl = productionUrl;
  }
  if (pagesDeploy.code !== 0) {
    s.fail("Pages deploy failed");
    console.log(dim(pagesDeploy.stdout + "\n" + pagesDeploy.stderr));
    process.exit(1);
  }
  s.stop(`App deployed: ${cyan(appUrl)}`);

  // ── Save config & finish ──────────────────────────────────────────

  step(5, TOTAL_STEPS, "Done");

  saveConfig({
    bridge: {
      url: bridgeUrl,
      d1Id,
      name: bridgeName,
    },
    app: {
      url: appUrl,
      projectName: pagesProjectName,
    },
    letta: lettaKey ? { apiKey: lettaKey } : {},
    elevenlabs: elevenlabsKey ? { apiKey: elevenlabsKey, voiceId: elevenlabsVoice || "" } : {},
  });

  console.log(`
${green(bold("  Familiar is live."))}

  ${bold("App:")}    ${cyan(appUrl)}
  ${bold("Bridge:")} ${cyan(bridgeUrl)}
  ${bold("Config:")} ${dim(getConfigPath())}

${bold("  Next steps:")}

  ${cyan("1.")} Open ${cyan(appUrl)} in your browser
  ${cyan("2.")} Paste your Letta API key${lettaKey ? " (already saved — paste again on first login)" : ""}
  ${cyan("3.")} Pick the agent you want Familiar to talk to
  ${cyan("4.")} You're done. Familiar will auto-configure your agent (custom block + system instructions).
`);

  if (!elevenlabsKey) {
    info("Voice notes need an ElevenLabs key. Add one later via Settings → Voice in the app.");
  }
}
