import { loadConfig, getConfigPath, configExists } from "../lib/config-store.js";
import { banner, bold, cyan, dim, fail, info } from "../lib/ui.js";

export default async function statusCommand() {
  banner();
  if (!configExists()) {
    fail("No deployment found. Run `familiar deploy` first.");
    process.exit(1);
  }
  const config = loadConfig();
  if (!config) {
    fail("Config file is unreadable.");
    process.exit(1);
  }
  console.log(bold("  Deployment\n"));
  if (config.app?.url) info(`App:    ${cyan(config.app.url)}`);
  if (config.bridge?.url) info(`Bridge: ${cyan(config.bridge.url)}`);
  if (config.bridge?.d1Id) info(`D1:     ${dim(config.bridge.d1Id)}`);
  console.log("");
  console.log(bold("  Config\n"));
  info(`Path:   ${dim(getConfigPath())}`);
  if (config.elevenlabs?.voiceId) info(`Voice:  ${dim(config.elevenlabs.voiceId)} (ElevenLabs)`);
  console.log("");
}
