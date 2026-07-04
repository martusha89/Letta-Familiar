#!/usr/bin/env node
// One-off: list every schedule on an agent, nuke any [autonomous_check_in] ones.
// Usage:  node cleanup-schedules.js <LETTA_KEY> <AGENT_ID>
// Or set FAMILIAR_LETTA_KEY + FAMILIAR_AGENT_ID env vars.

const LETTA_BASE = "https://api.letta.com";

const key = process.argv[2] || process.env.FAMILIAR_LETTA_KEY;
const agent = process.argv[3] || process.env.FAMILIAR_AGENT_ID;

if (!key || !agent) {
  console.error("Usage: node cleanup-schedules.js <LETTA_KEY> <AGENT_ID>");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function list() {
  const r = await fetch(`${LETTA_BASE}/v1/agents/${agent}/schedule`, { headers });
  if (!r.ok) {
    console.error(`list failed (${r.status}): ${await r.text()}`);
    process.exit(1);
  }
  const data = await r.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.schedules)) return data.schedules;
  return [];
}

async function del(id) {
  const r = await fetch(`${LETTA_BASE}/v1/agents/${agent}/schedule/${id}`, { method: "DELETE", headers });
  if (!r.ok && r.status !== 404) {
    console.error(`  delete ${id} failed (${r.status}): ${await r.text()}`);
    return false;
  }
  return true;
}

(async () => {
  const schedules = await list();
  console.log(`\nFound ${schedules.length} schedule(s) on agent ${agent}:\n`);
  for (const s of schedules) {
    const firstMsg = s.messages?.[0]?.content?.slice(0, 60) || "(no message)";
    console.log(`  ${s.id}  cron="${s.cron_expression || "?"}"  msg="${firstMsg}"`);
  }
  const targets = schedules.filter((s) =>
    s.messages?.some((m) => m.content?.startsWith("[autonomous_check_in]")),
  );
  if (targets.length === 0) {
    console.log("\nNo [autonomous_check_in] schedules found. Nothing to delete.");
    return;
  }
  console.log(`\nDeleting ${targets.length} [autonomous_check_in] schedule(s)...`);
  for (const s of targets) {
    process.stdout.write(`  ${s.id} ... `);
    const ok = await del(s.id);
    console.log(ok ? "deleted" : "FAILED");
  }
  console.log("\nDone. Sam will stop getting poked.\n");
})();
