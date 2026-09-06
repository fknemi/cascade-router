// src/core/router.ts
import { Client } from "pg";
import { randomUUID } from "crypto";
import type { IntentProfileBundle } from "../types/pipeline";

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";
// NOTE: `<=>` in pgvector is COSINE DISTANCE, not similarity — 0 means
// identical, larger means less alike. Both thresholds below are distance
// ceilings despite the old names; only MAX_DISTANCE used to actually block
// a match. Renamed for clarity and a margin check has been added below.
const WARN_DISTANCE = 0.65;  // Above this, log a warning even if still accepted
const MAX_DISTANCE = 0.35;   // Reject: absolute "no confident match" cutoff. (Updated from 0.45)
// Tuned against real traces: "write api docs" landed its best match around
// 0.50-0.55 across a near three-way tie and should be rejected. Retune
// against a larger labeled sample once available.
const MIN_MARGIN = 0.03;
// A confident top-1 should clear the runner-up by a real margin. Three
// near-tied candidates (0.3077 / 0.3232 / 0.3335 in the "Match PO to
// invoice" trace) indicate the embedding didn't discriminate between
// intents, even though the absolute top-1 distance looked low enough alone.


async function getEmbedding(text: string): Promise<number[]> {
  // Truncate text to ~8000 characters to stay safely within the 
  // nomic-embed-text context window and prevent 400 errors
  const safeText = text.length > 8000 ? text.slice(0, 8000) : text;

  const res = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      input: safeText,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embedding failed: ${res.status}`);
  }

  const data = await res.json();
  return data.embeddings[0];
}


export async function routeIntent(
  userQuery: string,
): Promise<IntentProfileBundle | null> {
  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    // Step 1: Generate embedding for user query
    const queryEmbedding = await getEmbedding(userQuery);
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    // Step 2: Find top 3 matching intents
    const matchResult = await client.query(
      `SELECT ie.intent_id, ie.name, ie.description,
              (ie.embedding_vector <=> $1::vector) AS distance
       FROM intent_embeddings ie
       ORDER BY distance ASC
       LIMIT 3`,
      [vectorLiteral],
    );

    if (matchResult.rows.length === 0) {
      console.log("[Router] No intents in database");
      return null;
    }

    const match = matchResult.rows[0];
    const runnerUp = matchResult.rows[1]; // may be undefined if <2 intents exist
    console.log(`[Router] Top matches:`);
    for (const row of matchResult.rows) {
      console.log(`  ${row.name}: ${row.distance.toFixed(4)}`);
    }

    // Reject: worse than the absolute distance ceiling.
    if (match.distance > MAX_DISTANCE) {
      console.log(`[Router]  No intent within max distance (${match.distance.toFixed(4)} > ${MAX_DISTANCE}) → no match`);
      return null;
    }

    // Reject: top match isn't meaningfully better than the runner-up, i.e.
    // the embedding didn't actually discriminate between candidate intents.
    if (runnerUp && (runnerUp.distance - match.distance) < MIN_MARGIN) {
      console.log(
        `[Router]  Top match "${match.name}" (${match.distance.toFixed(4)}) too close to runner-up ` +
          `"${runnerUp.name}" (${runnerUp.distance.toFixed(4)}), margin ${(runnerUp.distance - match.distance).toFixed(4)} < ${MIN_MARGIN} → no match`,
      );
      return null;
    }

    // Accepted, but log if it's a weaker match than we'd ideally want.
    if (match.distance > WARN_DISTANCE) {
      console.log(`[Router]  Weak match accepted (${match.distance.toFixed(4)} > ${WARN_DISTANCE})`);
      console.log(`[Router] Proceeding with closest intent: ${match.name}`);
    }

    // Step 3: Fetch complete bundle
    const bundleResult = await client.query(
      `SELECT 
         i.id AS intent_id,
         i.name AS intent_name,
         i.domain,
         i.schema_json AS layer1_schema,
         s.version AS sop_version,
         s.content AS sop_text,
         inv.version AS invariant_version,
         inv.code AS layer2_invariant_code
       FROM intents i
       LEFT JOIN sops s ON s.intent_id = i.id AND s.status = 'active'
       LEFT JOIN invariants inv ON inv.intent_id = i.id AND inv.status = 'active'
       WHERE i.id = $1
       ORDER BY s.version DESC, inv.version DESC
       LIMIT 1`,
      [match.intent_id],
    );

    if (bundleResult.rows.length === 0) {
      console.log(`[Router] No active bundle for intent: ${match.name}`);
      return null;
    }

    const row = bundleResult.rows[0];

    // If no SOP or invariant, still return what we have
    const bundle: IntentProfileBundle = {
      routing_metadata: {
        intent_id: row.intent_id,
        intent_name: row.intent_name,
        domain: row.domain,
        model_target: "qwen2.5-coder:3b",
        trace_id: randomUUID(),
      },
      execution_assets: {
        sop_version: row.sop_version || 1,
        sop_text: row.sop_text || `Execute the task: ${row.intent_name}`,
      },
      verification_assets: {
        layer1_schema: row.layer1_schema || { type: "object", properties: {} },
        layer2_invariant_code: row.layer2_invariant_code || "",
      },
    };

    return bundle;
  } catch (error: any) {
    console.error(`[Router] Error: ${error.message}`);
    return null;
  } finally {
    await client.end();
  }
}
