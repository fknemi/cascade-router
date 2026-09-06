// scripts/generate-intents.ts
// Generates intent data using DeepSeek (deepseek-v4-flash) and Ollama (embeddings)
// Creates: intents, sops, invariants, and embeddings

import { Client } from "pg";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { config as dotenvConfig } from "dotenv";

// Load environment variables
dotenvConfig();

// Load opencode config for DeepSeek API Key
function loadConfig(): any {
  const locations = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(process.cwd(), "opencode.json"),
  ];

  for (const loc of locations) {
    try {
      if (existsSync(loc)) {
        const raw = readFileSync(loc, "utf-8");
        const cleanRaw = raw
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        return JSON.parse(cleanRaw);
      }
    } catch (e) {}
  }
  return null;
}

const config = loadConfig();
const deepseekProvider = config?.provider?.deepseek;

const DEEPSEEK_URL = "https://api.deepseek.com";
const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || deepseekProvider?.options?.apiKey || "";

const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";
const GENERATOR_MODEL = "deepseek-v4-flash"; // Switched to DeepSeek v4 Flash
const EMBED_MODEL = "nomic-embed-text"; // For embeddings

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

// Domains and intents to generate

// Domains and intents mapped to the health/diet React Native app features
const DOMAINS = [
  {
    domain: "food_and_nutrition",
    intents: [
      "scan_food_barcode",          // Tied to: app/(tabs)/scan.tsx, services/open-food-facts.ts
      "detect_food_from_image",     // Tied to: components/food-detection-camera.tsx, yolov8n.tflite
      "log_meal_entry",             // Tied to: stores/useMealsStore.ts, app/(tabs)/meals.tsx
      "calculate_macros",           // Tied to: components/macro-breakdown-chart.tsx, services/usda.ts
    ],
  },
  {
    domain: "health_tracking",
    intents: [
      "log_water_intake",           // Tied to: stores/useHydrationStore.ts, components/water-card.tsx
      "record_sleep_session",       // Tied to: stores/useSleepStore.ts, components/sleep-modal.tsx
      "log_meditation_session",     // Tied to: stores/useMeditationStore.ts, app/(tabs)/medidation.tsx
      "sync_step_count",            // Tied to: stores/useStepStore.ts, hooks/use-step-counter.ts
    ],
  },
  {
    domain: "dietary_preferences",
    intents: [
      "update_allergies",           // Tied to: app/edit-allergies.tsx, stores/useAllergensStore.ts
      "set_diet_style",             // Tied to: app/(onboarding)/diet-style.tsx, stores/useDietStore.ts
      "update_disliked_ingredients",// Tied to: app/edit-dislikes.tsx, stores/useDislikedIngredientsStore.ts
    ],
  },
  {
    domain: "recipes_and_discovery",
    intents: [
      "search_recipes",             // Tied to: app/(tabs)/recipes.tsx, services/recipe-api.ts
      "save_favorite_recipe",       // Tied to: stores/useRecipesStore.ts, components/recipe-card.tsx
      "get_recipe_nutrition",       // Tied to: hooks/use-food-nutrition.ts, app/recipe/[id].tsx
    ],
  }
];


async function generateText(prompt: string): Promise<string> {
  if (!DEEPSEEK_API_KEY) {
    throw new Error("DeepSeek API key not found in .env or opencode config");
  }

  const response = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: GENERATOR_MODEL,
      messages: [
        {
          role: "system",
          content: "You are an expert software engineer and systems architect. Output accurate, structured information directly without unnecessary conversational text.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
    }),
  });

  const data = await response.json();
  return data.embeddings[0];
}

async function generateIntentData(domain: string, intentName: string) {
  console.log(`\n[Generate] ${domain}/${intentName}`);

  // 1. Generate description
  const description = await generateText(
    `Write a clear 2-3 sentence description of what the task "${intentName}" does in the "${domain}" domain. Be specific about inputs, actions, and outputs.`
  );
  console.log(`  Description: ${description.substring(0, 80)}...`);

  // 2. Generate SOP
  const sop = await generateText(
    `Write a step-by-step Standard Operating Procedure (SOP) for "${intentName}" in "${domain}". 
     Format as numbered steps. Include validation checks where relevant.
     Description: ${description}`
  );
  console.log(`  SOP: ${sop.substring(0, 80)}...`);

  // 3. Generate JSON schema for output
  const schema = await generateText(
    `For task "${intentName}", write a JSON schema (Pydantic-style) for the expected output.
     Include required fields, types, and any enums. Output ONLY valid JSON.`
  );

  // Try to extract JSON from schema response
  let schemaJson: any = {};
  try {
    const jsonMatch = schema.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      schemaJson = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.log(`  Schema: using default`);
    schemaJson = { type: "object", properties: {} };
  }

  // 4. Generate invariant code linked to schema fields
  const invariantCode = await generateText(
    `For task "${intentName}", write Python assert statements that validate the output.
     The output will strictly follow this schema: ${JSON.stringify(schemaJson)}
     Do not assert the existence of fields not present in the schema.
     Include mathematical conservation, data type checks, and business logic.
     Format as a verify_logic(payload, state) function. Output ONLY code, no markdown.`
  );
  console.log(`  Invariant: ${invariantCode.substring(0, 80)}...`);

  // 5. Generate embedding
  const embedding = await generateEmbedding(description);
  console.log(`  Embedding: ${embedding.length} dims`);

  return {
    description,
    sop,
    schemaJson,
    invariantCode,
    embedding,
  };
}

async function insertIntoDB(data: any) {
  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    const { domain, intentName, description, sop, schemaJson, invariantCode, embedding } = data;

    // Insert intent
    const intentId = randomUUID();
    await client.query(
      `INSERT INTO intents (id, name, domain, schema_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [intentId, intentName, domain, JSON.stringify(schemaJson)]
    );

    // Insert SOP
    await client.query(
      `INSERT INTO sops (id, intent_id, version, content)
       VALUES ($1, $2, 1, $3)`,
      [randomUUID(), intentId, sop]
    );

    // Insert invariant
    await client.query(
      `INSERT INTO invariants (id, intent_id, version, code)
       VALUES ($1, $2, 1, $3)`,
      [randomUUID(), intentId, invariantCode]
    );

    // Insert embedding
    const vectorLiteral = `[${embedding.join(",")}]`;
    await client.query(
      `INSERT INTO intent_embeddings (id, intent_id, name, description, embedding_vector)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [randomUUID(), intentId, intentName, description, vectorLiteral]
    );

    console.log(`   Inserted ${intentName}`);
  } finally {
    await client.end();
  }
}

async function main() {
  console.log("=== Cascade v3 - Intent Generator ===\n");
  console.log(`Using models:`);
  console.log(`  Generator: ${GENERATOR_MODEL}`);
  console.log(`  Embedding: ${EMBED_MODEL}\n`);

  const totalIntents = DOMAINS.reduce((sum, d) => sum + d.intents.length, 0);
  console.log(`Will generate ${totalIntents} intents across ${DOMAINS.length} domains\n`);

  let completed = 0;

  for (const domainConfig of DOMAINS) {
    for (const intentName of domainConfig.intents) {
      try {
        const data = await generateIntentData(domainConfig.domain, intentName);
        await insertIntoDB({
          domain: domainConfig.domain,
          intentName,
          ...data,
        });
        completed++;
        console.log(`\nProgress: ${completed}/${totalIntents}\n`);
      } catch (error: any) {
        console.error(`   Failed ${intentName}: ${error.message}`);
      }
    }
  }

  console.log(`\n Generated ${completed}/${totalIntents} intents`);
}

main().catch(console.error);
