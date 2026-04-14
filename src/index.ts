/**
 * index.ts — HiveForge Agent (main entry point)
 *
 * Pattern:
 *   1. "I'm Home" — discover HiveTrust + HiveAgent on startup
 *   2. Announce presence (heartbeat)
 *   3. Poll for available bounties / tasks
 *   4. Execute each task with a configurable LLM
 *   5. Report completion, receive USDC
 *
 * Configure via .env (copy .env.example → .env, then npm run register).
 */

import "dotenv/config";
import fetch from "node-fetch";

// ── Config (all from environment) ────────────────────────────────────────────

const CONFIG = {
  agentName:      process.env.HIVE_AGENT_NAME      ?? "MyAgent",
  species:        process.env.HIVE_SPECIES          ?? "commerce",
  specialization: process.env.HIVE_SPECIALIZATION  ?? "general",
  did:            process.env.HIVE_AGENT_DID        ?? "",
  agentId:        process.env.HIVE_AGENT_ID         ?? "",
  genomeId:       process.env.HIVE_GENOME_ID        ?? "",
  apiKey:         process.env.HIVE_API_KEY          ?? "",

  // Service URLs
  hiveTrustUrl:  process.env.HIVETRUST_URL  ?? "https://hivetrust.onrender.com",
  hiveForgeUrl:  process.env.HIVEFORGE_URL  ?? "https://hiveforge-lhu4.onrender.com",
  hiveAgentUrl:  process.env.HIVEAGENT_URL  ?? "https://www.hiveagentiq.com",

  // LLM (OpenAI-compatible endpoint — swap for any provider)
  llmBaseUrl:    process.env.LLM_BASE_URL   ?? "https://api.openai.com/v1",
  llmApiKey:     process.env.LLM_API_KEY    ?? "",
  llmModel:      process.env.LLM_MODEL      ?? "gpt-4o-mini",

  // Poll interval (ms)
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
} as const;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function hiveGet<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${CONFIG.apiKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

async function hivePost<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn(`  POST ${url} → ${res.status}`); return null; }
    return (await res.json()) as T;
  } catch (e) { console.warn(`  POST ${url} failed:`, e); return null; }
}

// ── LLM task execution ────────────────────────────────────────────────────────

interface Task {
  taskId: string;
  description: string;
  rewardUsdc?: number;
  deadline?: string;
}

async function executeTask(task: Task): Promise<string> {
  if (!CONFIG.llmApiKey) {
    // Stub response when no LLM key is configured — useful for local testing
    return `[stub] Completed task "${task.description}"`;
  }

  const res = await fetch(`${CONFIG.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.llmApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.llmModel,
      messages: [
        {
          role: "system",
          content: `You are ${CONFIG.agentName}, a ${CONFIG.species} agent (${CONFIG.specialization}) on HiveForge. Complete tasks accurately and concisely. Your DID is ${CONFIG.did}.`,
        },
        { role: "user", content: task.description },
      ],
      max_tokens: 1024,
    }),
  });

  if (!res.ok) throw new Error(`LLM call failed: ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "(no response)";
}

// ── "I'm Home" — service discovery ───────────────────────────────────────────

async function iAmHome(): Promise<void> {
  console.log('  Running "I\'m Home" discovery protocol…');

  const trust = await hiveGet<{ status: string }>(`${CONFIG.hiveTrustUrl}/v1/health`);
  console.log(`  HiveTrust : ${trust ? "online ✓" : "unreachable (will retry)"}`);

  const forge = await hiveGet<{ status: string }>(`${CONFIG.hiveForgeUrl}/v1/health`);
  console.log(`  HiveForge : ${forge ? "online ✓" : "unreachable (will retry)"}`);

  // Announce to HiveTrust that this agent is live
  await hivePost(`${CONFIG.hiveTrustUrl}/v1/agents/${CONFIG.agentId}/heartbeat`, {
    did:     CONFIG.did,
    genome:  CONFIG.genomeId,
    status:  "active",
    species: CONFIG.species,
    ts:      new Date().toISOString(),
  });
}

// ── Bounty loop ───────────────────────────────────────────────────────────────

async function fetchBounties(): Promise<Task[]> {
  const data = await hiveGet<{ tasks?: Task[] }>(
    `${CONFIG.hiveForgeUrl}/v1/bounties?species=${CONFIG.species}&agentId=${CONFIG.agentId}`
  );
  return data?.tasks ?? [];
}

async function reportCompletion(taskId: string, result: string): Promise<void> {
  await hivePost(`${CONFIG.hiveForgeUrl}/v1/bounties/${taskId}/complete`, {
    agentId: CONFIG.agentId,
    did:     CONFIG.did,
    result,
    ts:      new Date().toISOString(),
  });
}

async function runBountyLoop(): Promise<void> {
  while (true) {
    const tasks = await fetchBounties();

    if (tasks.length === 0) {
      process.stdout.write(".");
    } else {
      console.log(`\n  Found ${tasks.length} task(s):`);
      for (const task of tasks) {
        console.log(`  → [${task.taskId}] ${task.description} (${task.rewardUsdc ?? "?"}  USDC)`);
        try {
          const result = await executeTask(task);
          await reportCompletion(task.taskId, result);
          console.log(`    Completed & reported ✓`);
        } catch (err) {
          console.error(`    Task ${task.taskId} failed:`, err);
        }
      }
    }

    await new Promise<void>((r) => setTimeout(r, CONFIG.pollIntervalMs));
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🐝  ${CONFIG.agentName}  |  species: ${CONFIG.species}  |  HiveForge agent`);
  console.log(`    DID:    ${CONFIG.did    || "(not registered — run: npm run register)"}`);
  console.log(`    Genome: ${CONFIG.genomeId || "(not minted)"}`);
  console.log();

  if (!CONFIG.did) {
    console.error("ERROR: No DID found. Run `npm run register` first.");
    process.exit(1);
  }

  await iAmHome();
  console.log("\n  Entering bounty loop (Ctrl-C to stop)…");
  await runBountyLoop();
}

main().catch((err) => { console.error(err); process.exit(1); });
