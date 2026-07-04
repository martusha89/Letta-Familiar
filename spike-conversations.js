#!/usr/bin/env node
// Spike: does Letta have a native conversation_id concept?
// Probes the API to answer four questions before we commit to an architecture.

const LETTA_BASE = "https://api.letta.com";
const KEY = process.argv[2] || process.env.FAMILIAR_LETTA_KEY;
const AGENT = process.argv[3] || process.env.FAMILIAR_AGENT_ID;

if (!KEY || !AGENT) {
  console.error("Usage: node spike-conversations.js <LETTA_KEY> <AGENT_ID>");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function probe(method, path, body) {
  const url = `${LETTA_BASE}${path}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(url, opts);
    const ct = r.headers.get("content-type") || "";
    const text = await r.text();
    let parsed = null;
    if (ct.includes("application/json")) {
      try { parsed = JSON.parse(text); } catch {}
    }
    return { status: r.status, ok: r.ok, body: parsed ?? text.slice(0, 400), raw: text };
  } catch (e) {
    return { status: 0, ok: false, body: `network error: ${e.message}` };
  }
}

function pretty(label, res) {
  const tag = res.ok ? "OK " : `${res.status}`;
  console.log(`\n[${tag}] ${label}`);
  if (typeof res.body === "string") {
    console.log("  " + res.body.slice(0, 300));
  } else {
    const j = JSON.stringify(res.body, null, 2);
    console.log("  " + j.split("\n").slice(0, 12).join("\n  "));
    if (j.split("\n").length > 12) console.log("  ... (truncated)");
  }
}

(async () => {
  console.log(`Probing Letta API for conversation_id support`);
  console.log(`Agent: ${AGENT}\n`);
  console.log("─".repeat(60));

  // ── Q1: Does the conversations endpoint exist? Try multiple shapes. ──
  console.log("\nQ1: Does a conversations endpoint exist?");

  const conv1 = await probe("GET", "/v1/conversations");
  pretty("GET /v1/conversations", conv1);

  const conv2 = await probe("GET", `/v1/agents/${AGENT}/conversations`);
  pretty(`GET /v1/agents/{id}/conversations`, conv2);

  const conv3 = await probe("GET", `/v1/agents/${AGENT}/conversations/`);
  pretty(`GET /v1/agents/{id}/conversations/ (trailing slash)`, conv3);

  // Also worth probing the OpenAPI spec for ground truth
  const openapi = await probe("GET", "/v1/openapi.json");
  if (openapi.ok && typeof openapi.body === "object") {
    const paths = Object.keys(openapi.body.paths || {});
    const convPaths = paths.filter((p) => /conversation/i.test(p));
    console.log(`\n[OK ] OpenAPI spec available — ${paths.length} total paths`);
    if (convPaths.length > 0) {
      console.log("  Conversation-related paths found:");
      for (const p of convPaths) console.log(`    ${p}`);
    } else {
      console.log("  NO paths matching /conversation/ in the OpenAPI spec.");
    }
  } else {
    console.log(`\n[${openapi.status}] OpenAPI spec at /v1/openapi.json not reachable.`);
    // Try alt locations
    const alt = await probe("GET", "/openapi.json");
    if (alt.ok) console.log("  But /openapi.json works — try that.");
  }

  // ── Q2: Can we create a conversation under an agent? ──
  console.log("\n" + "─".repeat(60));
  console.log("\nQ2: Can we create a conversation?");

  const create1 = await probe("POST", `/v1/agents/${AGENT}/conversations`, {
    name: "spike-test-conv",
  });
  pretty(`POST /v1/agents/{id}/conversations`, create1);

  const create2 = await probe("POST", `/v1/conversations?agent_id=${AGENT}`, {
    name: "spike-test-conv",
  });
  pretty(`POST /v1/conversations?agent_id=...`, create2);

  // Also try with no body (some Letta create endpoints want empty body)
  const create3 = await probe("POST", `/v1/conversations?agent_id=${AGENT}`);
  pretty(`POST /v1/conversations?agent_id=... (no body)`, create3);

  // Capture id if any create succeeded
  let createdConvId = null;
  for (const r of [create1, create2, create3]) {
    if (r.ok && typeof r.body === "object" && r.body) {
      createdConvId = r.body.id || r.body.conversation_id || null;
      if (createdConvId) break;
    }
  }
  if (createdConvId) console.log(`\n  → Created conversation id: ${createdConvId}`);

  // ── Q3: Does messages.list accept conversation_id? ──
  console.log("\n" + "─".repeat(60));
  console.log("\nQ3: Do message endpoints accept conversation_id?");

  const probeConvId = createdConvId || "test-conv-id";

  const msgs1 = await probe(
    "GET",
    `/v1/agents/${AGENT}/messages?conversation_id=${probeConvId}&limit=1`,
  );
  pretty(`GET /v1/agents/{id}/messages?conversation_id=...`, msgs1);

  if (createdConvId) {
    const msgs2 = await probe(
      "GET",
      `/v1/conversations/${createdConvId}/messages?limit=1`,
    );
    pretty(`GET /v1/conversations/{id}/messages`, msgs2);
  }

  // (Skipped: POST /v1/agents/{id}/messages with conversation_id in body
  // — first spike already confirmed this works AND sends a real message
  // to the agent. Don't re-poke Sam.)

  // ── Q4: Are memory blocks agent-level (shared) or conv-level? ──
  console.log("\n" + "─".repeat(60));
  console.log("\nQ4: Are core memory blocks scoped to agent (shared) or conversation?");

  const blocks = await probe("GET", `/v1/agents/${AGENT}/core-memory/blocks`);
  if (blocks.ok && Array.isArray(blocks.body)) {
    console.log(`[OK ] Agent has ${blocks.body.length} core memory block(s) at the AGENT level.`);
    for (const b of blocks.body.slice(0, 5)) {
      console.log(`  - ${b.label || b.name || "(no label)"}  id=${b.id}`);
    }
    console.log("  → If conversations exist and these blocks stay shared across them,");
    console.log("    identity is automatically continuous. That's the architecture we want.");
  } else {
    pretty("GET /v1/agents/{id}/core-memory/blocks", blocks);
  }

  // ── Cleanup: delete the test conversation if we made one ──
  if (createdConvId) {
    console.log("\n" + "─".repeat(60));
    console.log("\nCleanup: deleting test conversation");
    const del1 = await probe("DELETE", `/v1/conversations/${createdConvId}`);
    pretty(`DELETE /v1/conversations/{id}`, del1);
    if (!del1.ok) {
      const del2 = await probe("DELETE", `/v1/agents/${AGENT}/conversations/${createdConvId}`);
      pretty(`DELETE /v1/agents/{id}/conversations/{id}`, del2);
    }
  }

  // ── Verdict ──
  console.log("\n" + "═".repeat(60));
  console.log("VERDICT");
  console.log("═".repeat(60));

  const q1Works = conv1.ok || conv2.ok || conv3.ok;
  const q2Works = !!createdConvId;

  console.log(`Q1 (endpoint exists): ${q1Works ? "YES" : "NO"}`);
  console.log(`Q2 (can create):      ${q2Works ? "YES" : "NO"}`);

  if (q1Works && q2Works) {
    console.log("\n→ Letta has native conversation_id support. Build the native path.");
  } else {
    console.log("\n→ Letta does NOT have native conversations (or they're undocumented/hidden).");
    console.log("  Fallback: separate Letta agent per surface, sharing core memory blocks.");
  }
  console.log();
})();
