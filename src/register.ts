/**
 * register.ts — One-time agent registration script.
 *
 * Run: npm run register
 *
 * Steps:
 *   1. Generate a fresh ed25519 keypair (your agent's identity)
 *   2. POST to HiveTrust  → receive a DID
 *   3. POST to HiveForge  → mint a genome (unique agent fingerprint)
 *   4. Write credentials to .env
 */

import "dotenv/config";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { generateKeyPairSync, createHash } from "crypto";
import fetch from "node-fetch";

const HIVETRUST_URL = process.env.HIVETRUST_URL ?? "https://hivetrust.onrender.com";
const HIVEFORGE_URL = process.env.HIVEFORGE_URL ?? "https://hiveforge-lhu4.onrender.com";

const AGENT_NAME       = process.env.HIVE_AGENT_NAME   ?? "MyAgent";
const AGENT_SPECIES    = process.env.HIVE_SPECIES       ?? "commerce";
const AGENT_SPEC       = process.env.HIVE_SPECIALIZATION ?? "general";

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding:  { type: "spki",  format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  // Derive a compact public key fingerprint (hex of SHA-256)
  const pubBytes = publicKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const fingerprint = createHash("sha256").update(pubBytes).digest("hex").slice(0, 32);
  return { privateKey, publicKey, fingerprint };
}

function updateEnvFile(additions: Record<string, string>): void {
  const envPath = ".env";
  let existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  for (const [key, value] of Object.entries(additions)) {
    const line = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*`, "m");
    existing = regex.test(existing)
      ? existing.replace(regex, line)
      : existing + (existing.endsWith("\n") || !existing ? "" : "\n") + line + "\n";
  }
  writeFileSync(envPath, existing);
  console.log(`  Saved to .env`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🐝  HiveForge Agent Registration\n");

  // 1. Keypair
  console.log("1/3  Generating ed25519 keypair…");
  const { privateKey, publicKey, fingerprint } = generateKeypair();

  // 2. Register with HiveTrust → DID
  console.log("2/3  Registering with HiveTrust…");
  const trustRes = await fetch(`${HIVETRUST_URL}/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name:        AGENT_NAME,
      species:     AGENT_SPECIES,
      publicKey:   publicKey,
      fingerprint: fingerprint,
    }),
  });

  if (!trustRes.ok) {
    const body = await trustRes.text();
    throw new Error(`HiveTrust registration failed (${trustRes.status}): ${body}`);
  }

  const trustData = (await trustRes.json()) as { did?: string; agentId?: string; apiKey?: string };
  const did     = trustData.did     ?? `did:hive:${fingerprint}`;
  const agentId = trustData.agentId ?? fingerprint;
  const apiKey  = trustData.apiKey  ?? "";
  console.log(`  DID: ${did}`);

  // 3. Mint on HiveForge → genome
  console.log("3/3  Minting genome on HiveForge…");
  const forgeRes = await fetch(`${HIVEFORGE_URL}/v1/forge/mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      agentId:        agentId,
      did:            did,
      name:           AGENT_NAME,
      species:        AGENT_SPECIES,
      specialization: AGENT_SPEC,
      publicKey:      publicKey,
    }),
  });

  if (!forgeRes.ok) {
    const body = await forgeRes.text();
    throw new Error(`HiveForge mint failed (${forgeRes.status}): ${body}`);
  }

  const forgeData = (await forgeRes.json()) as { genomeId?: string; genome?: string };
  const genomeId  = forgeData.genomeId ?? forgeData.genome ?? `genome_${fingerprint}`;
  console.log(`  Genome ID: ${genomeId}`);

  // 4. Persist credentials
  updateEnvFile({
    HIVE_AGENT_DID:    did,
    HIVE_AGENT_ID:     agentId,
    HIVE_GENOME_ID:    genomeId,
    HIVE_API_KEY:      apiKey,
    HIVE_PRIVATE_KEY:  privateKey.replace(/\n/g, "\\n"),
    HIVE_PUBLIC_KEY:   publicKey.replace(/\n/g, "\\n"),
  });

  console.log("\n✅  Registration complete. Run `npm start` to launch your agent.\n");
}

main().catch((err) => { console.error("Registration failed:", err); process.exit(1); });
