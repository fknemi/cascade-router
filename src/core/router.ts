// src/core/router.ts
import { Client } from "pg";
import { randomUUID } from "crypto";
import type { IntentProfileBundle } from "../types/pipeline";
import {
  startChainSpan,
  startEmbeddingSpan,
  setSpanAttributes,
  endSpan,
  setTraceOutput,
} from "../telemetry";

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";
const WARN_DISTANCE = 0.65;
const MAX_DISTANCE  = 0.35;
const MIN_MARGIN    = 0.03;

// ─── Embedding generation ──────────────────────────────────────────────────
async function getEmbedding(text: string, parentSpan?: any): Promise<number[]> {
  const span = startEmbeddingSpan("getEmbedding", parentSpan, {
    model: "nomic-embed-text",
    text_length: text.length,
  });

  const startTime = Date.now();

  try {
    const safeText = text.length > 8000 ? text.slice(0, 8000) : text;

    const res = await fetch(OLLAMA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", input: safeText }),
    });

    if (!res.ok) throw new Error(`Ollama embedding failed: ${res.status}`);

    const data = await res.json();

    setSpanAttributes(span, {
      status: "success",
      latency_ms: Date.now() - startTime,
      embedding_dimensions: data.embeddings[0]?.length || 0,
    });

    return data.embeddings[0];
  } catch (error: any) {
    setSpanAttributes(span, {
      status: "error",
      latency_ms: Date.now() - startTime,
      error: error.message,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Main routing function ─────────────────────────────────────────────────
// Pure read-only. Returns null on no-match. Caller triggers the learning loop.
export async function routeIntent(
  userQuery: string,
  parentSpan?: any,
): Promise<IntentProfileBundle | null> {
  const span = startChainSpan("routeIntent", parentSpan, {
    query: userQuery.slice(0, 200),
    query_length: userQuery.length,
  });

  const startTime = Date.now();
  const client = new Client(DB_CONFIG);

  try {
    await client.connect();

    const queryEmbedding = await getEmbedding(userQuery, span);
    const vectorLiteral  = `[${queryEmbedding.join(",")}]`;

    const matchResult = await client.query(
      `SELECT ie.intent_id, ie.name, ie.description,
              (ie.embedding_vector <=> $1::vector) AS distance
       FROM intent_embeddings ie
       ORDER BY distance ASC
       LIMIT 3`,
      [vectorLiteral],
    );

    if (matchResult.rows.length === 0) {
      console.log("[Router] No intents in database — returning null");
      setSpanAttributes(span, {
        status: "no_match",
        reason: "no_intents",
        latency_ms: Date.now() - startTime,
      });
      return null;
    }

    const match    = matchResult.rows[0];
    const runnerUp = matchResult.rows[1];

    console.log(`[Router] Top matches:`);
    for (const row of matchResult.rows) {
      console.log(`  ${row.name}: ${row.distance.toFixed(4)}`);
    }

    setSpanAttributes(span, {
      top_match:            match.name,
      top_distance:         match.distance,
      runner_up:            runnerUp?.name || null,
      runner_up_distance:   runnerUp?.distance || null,
      third_match:          matchResult.rows[2]?.name || null,
      third_distance:       matchResult.rows[2]?.distance || null,
    });

    if (match.distance > MAX_DISTANCE) {
      console.log(`[Router] ❌ No intent within max distance (${match.distance.toFixed(4)} > ${MAX_DISTANCE})`);
      setSpanAttributes(span, {
        status:          "no_match",
        reason:          "max_distance_exceeded",
        distance:        match.distance,
        max_distance:    MAX_DISTANCE,
        closest_intent:  match.name,
        latency_ms:      Date.now() - startTime,
      });
      return null;
    }

    if (runnerUp && runnerUp.distance - match.distance < MIN_MARGIN) {
      console.log(
        `[Router] ⚠️ Insufficient margin: "${match.name}" (${match.distance.toFixed(4)}) ` +
        `vs "${runnerUp.name}" (${runnerUp.distance.toFixed(4)}), ` +
        `margin ${(runnerUp.distance - match.distance).toFixed(4)} < ${MIN_MARGIN}`,
      );
      setSpanAttributes(span, {
        status:          "no_match",
        reason:          "insufficient_margin",
        margin:          runnerUp.distance - match.distance,
        min_margin:      MIN_MARGIN,
        closest_intent:  match.name,
        latency_ms:      Date.now() - startTime,
      });
      return null;
    }

    if (match.distance > WARN_DISTANCE) {
      console.log(`[Router] ⚠️ Weak match accepted (${match.distance.toFixed(4)} > ${WARN_DISTANCE})`);
      setSpanAttributes(span, { weak_match: true, warn_distance: WARN_DISTANCE });
    }

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
      setSpanAttributes(span, {
        status:    "no_bundle",
        intent_id: match.intent_id,
        latency_ms: Date.now() - startTime,
      });
      return null;
    }

    const row = bundleResult.rows[0];

    const bundle: IntentProfileBundle = {
      routing_metadata: {
        intent_id:    row.intent_id,
        intent_name:  row.intent_name,
        domain:       row.domain,
        model_target: "qwen2.5-coder:3b",
        trace_id:     randomUUID(),
      },
      execution_assets: {
        sop_version: row.sop_version || 1,
        sop_text:    row.sop_text || `Execute the task: ${row.intent_name}`,
      },
      verification_assets: {
        layer1_schema:          row.layer1_schema || { type: "object", properties: {} },
        layer2_invariant_code:  row.layer2_invariant_code || "",
      },
    };

    setTraceOutput(span, {
      matched_intent: bundle.routing_metadata.intent_name,
      intent_id:      bundle.routing_metadata.intent_id,
      domain:         bundle.routing_metadata.domain,
      sop_version:    bundle.execution_assets.sop_version,
      has_invariant:  !!bundle.verification_assets.layer2_invariant_code,
    });

    setSpanAttributes(span, {
      status:      "matched",
      intent_id:   bundle.routing_metadata.intent_id,
      intent_name: bundle.routing_metadata.intent_name,
      domain:      bundle.routing_metadata.domain,
      distance:    match.distance,
      latency_ms:  Date.now() - startTime,
    });

    console.log(`[Router] ✅ Matched intent: ${match.name} (distance: ${match.distance.toFixed(4)})`);
    return bundle;

  } catch (error: any) {
    console.error(`[Router] Error: ${error.message}`);
    setSpanAttributes(span, {
      status:    "error",
      error:     error.message,
      latency_ms: Date.now() - startTime,
    });
    return null;
  } finally {
    await client.end().catch((e) => console.error("[Router] DB disconnect error:", e.message));
    endSpan(span);
  }
}

// ─── Batch embedding ───────────────────────────────────────────────────────
export async function getEmbeddingsBatch(
  texts: string[],
  parentSpan?: any,
): Promise<number[][]> {
  const span = startEmbeddingSpan("getEmbeddingsBatch", parentSpan, {
    model: "nomic-embed-text",
    batch_size: texts.length,
  });

  const startTime = Date.now();

  try {
    const safeTexts = texts.map((t) => t.length > 8000 ? t.slice(0, 8000) : t);

    const res = await fetch(OLLAMA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", input: safeTexts }),
    });

    if (!res.ok) throw new Error(`Ollama batch embedding failed: ${res.status}`);

    const data = await res.json();

    setSpanAttributes(span, {
      status:              "success",
      latency_ms:          Date.now() - startTime,
      embeddings_returned: data.embeddings?.length || 0,
    });

    return data.embeddings;
  } catch (error: any) {
    setSpanAttributes(span, {
      status:    "error",
      latency_ms: Date.now() - startTime,
      error:     error.message,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Find similar intents (debugging) ─────────────────────────────────────
export async function findSimilarIntents(
  embedding: number[],
  limit: number = 5,
  parentSpan?: any,
): Promise<any[]> {
  const span   = startChainSpan("findSimilarIntents", parentSpan, { limit });
  const client = new Client(DB_CONFIG);

  try {
    await client.connect();
    const vectorLiteral = `[${embedding.join(",")}]`;
    const result = await client.query(
      `SELECT ie.intent_id, ie.name, ie.description,
              (ie.embedding_vector <=> $1::vector) AS distance
       FROM intent_embeddings ie
       ORDER BY distance ASC
       LIMIT $2`,
      [vectorLiteral, limit],
    );
    setSpanAttributes(span, { status: "success", results: result.rows.length });
    return result.rows;
  } catch (error: any) {
    setSpanAttributes(span, { status: "error", error: error.message });
    throw error;
  } finally {
    await client.end().catch((e) => console.error("[Router] DB disconnect error:", e.message));
    endSpan(span);
  }
}

// ─── Delete an intent ──────────────────────────────────────────────────────
export async function deleteIntent(intentId: string, parentSpan?: any): Promise<boolean> {
  const span   = startChainSpan("deleteIntent", parentSpan, { intent_id: intentId });
  const client = new Client(DB_CONFIG);

  try {
    await client.connect();
    await client.query("DELETE FROM intent_embeddings WHERE intent_id = $1", [intentId]);
    await client.query("DELETE FROM sops WHERE intent_id = $1", [intentId]);
    await client.query("DELETE FROM invariants WHERE intent_id = $1", [intentId]);
    await client.query("DELETE FROM intents WHERE id = $1", [intentId]);
    console.log(`[Router] Deleted intent: ${intentId}`);
    setSpanAttributes(span, { status: "success", deleted: true });
    return true;
  } catch (error: any) {
    console.error(`[Router] Failed to delete intent: ${error.message}`);
    setSpanAttributes(span, { status: "error", error: error.message });
    return false;
  } finally {
    await client.end().catch((e) => console.error("[Router] DB disconnect error:", e.message));
    endSpan(span);
  }
}

// ─── Intent statistics ─────────────────────────────────────────────────────
export async function getIntentStats(parentSpan?: any): Promise<any> {
  const span   = startChainSpan("getIntentStats", parentSpan, {});
  const client = new Client(DB_CONFIG);

  try {
    await client.connect();
    const stats = await client.query(`
      SELECT
        COUNT(DISTINCT i.id)          as total_intents,
        COUNT(DISTINCT ie.intent_id)  as total_embeddings,
        COUNT(DISTINCT s.intent_id)   as intents_with_sops,
        COUNT(DISTINCT inv.intent_id) as intents_with_invariants,
        MIN(ie.created_at)            as oldest_intent,
        MAX(ie.created_at)            as newest_intent
      FROM intents i
      LEFT JOIN intent_embeddings ie ON i.id = ie.intent_id
      LEFT JOIN sops s               ON i.id = s.intent_id
      LEFT JOIN invariants inv       ON i.id = inv.intent_id
    `);
    setSpanAttributes(span, { status: "success" });
    return stats.rows[0];
  } catch (error: any) {
    setSpanAttributes(span, { status: "error", error: error.message });
    throw error;
  } finally {
    await client.end().catch((e) => console.error("[Router] DB disconnect error:", e.message));
    endSpan(span);
  }
}
