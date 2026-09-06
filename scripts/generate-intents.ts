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

// ---------------------------------------------------------------------------
// 10 domains, 100 intents total, each tied to a real file in the repo
// ---------------------------------------------------------------------------
const DOMAINS = [
  {
    domain: "food_and_nutrition",
    intents: [
      // Tied to: app/(tabs)/scan.tsx, services/open-food-facts.ts
      "scan_food_barcode",
      "detect_food_from_image",       // components/food-detection-camera.tsx, yolov8n.tflite
      "log_meal_entry",               // stores/useMealsStore.ts, app/(tabs)/meals.tsx
      "calculate_macros",             // components/macro-breakdown-chart.tsx, services/usda.ts
      "search_food_database",         // services/usda.ts, hooks/use-food-nutrition.ts
      "get_food_details_by_id",       // services/usda.ts, app/recipe/[id].tsx
      "analyze_meal_photo",           // components/food-detection-camera.tsx, stores/useDetectionStore.ts
      "estimate_portion_size",        // components/food-detection-camera.tsx, midas_v2_small.tflite
      "log_custom_food",              // stores/useMealsStore.ts, components/meal-search-modal.tsx
      "get_recent_meals",             // stores/useMealsStore.ts, app/(tabs)/meals.tsx
      "delete_meal_entry",            // stores/useMealsStore.ts, components/meal-card.tsx
      "update_meal_entry",            // stores/useMealsStore.ts, components/meal-card.tsx
    ],
  },
  {
    domain: "health_tracking",
    intents: [
      "log_water_intake",             // stores/useHydrationStore.ts, components/water-card.tsx
      "record_sleep_session",         // stores/useSleepStore.ts, components/sleep-modal.tsx
      "log_meditation_session",       // stores/useMeditationStore.ts, app/(tabs)/medidation.tsx
      "sync_step_count",              // stores/useStepStore.ts, hooks/use-step-counter.ts
      "log_weight_measurement",       // stores/useGoalsStore.ts, components/body-fat-chart.tsx
      "log_body_fat_percentage",      // components/body-fat-chart.tsx, useGoalsStore.ts
      "log_heart_rate",               // stores/useActivityStore.ts, components/activity-card.tsx
      "log_blood_pressure",           // stores/useActivityStore.ts, components/activity-modal.tsx
      "start_workout_session",        // stores/useActivityStore.ts, app/(tabs)/activity.tsx
      "end_workout_session",          // stores/useActivityStore.ts, components/activity-modal.tsx
      "log_exercise_set",             // stores/useActivityStore.ts, components/activity-card.tsx
      "get_daily_health_summary",     // app/(tabs)/analytics.tsx, components/daily-overview-card.tsx
    ],
  },
  {
    domain: "dietary_preferences",
    intents: [
      "update_allergies",             // app/edit-allergies.tsx, stores/useAllergensStore.ts
      "set_diet_style",               // app/(onboarding)/diet-style.tsx, stores/useDietStore.ts
      "update_disliked_ingredients",  // app/edit-dislikes.tsx, stores/useDislikedIngredientsStore.ts
      "add_allergy",                  // app/edit-allergies.tsx, stores/useAllergensStore.ts
      "remove_allergy",               // app/edit-allergies.tsx, stores/useAllergensStore.ts
      "add_disliked_ingredient",      // app/edit-dislikes.tsx, stores/useDislikedIngredientsStore.ts
      "remove_disliked_ingredient",   // app/edit-dislikes.tsx, stores/useDislikedIngredientsStore.ts
      "get_dietary_restrictions",     // stores/useDietStore.ts, stores/useAllergensStore.ts
      "get_disliked_ingredients",     // stores/useDislikedIngredientsStore.ts
      "set_calorie_goal",             // stores/useGoalsStore.ts, components/calories-card.tsx
    ],
  },
  {
    domain: "recipes_and_discovery",
    intents: [
      "search_recipes",               // app/(tabs)/recipes.tsx, services/recipe-api.ts
      "save_favorite_recipe",         // stores/useRecipesStore.ts, components/recipe-card.tsx
      "get_recipe_nutrition",         // hooks/use-food-nutrition.ts, app/recipe/[id].tsx
      "get_recipe_details",           // app/recipe/[id].tsx, services/recipe-api.ts
      "get_similar_recipes",          // services/recipe-api.ts, components/recipe-card.tsx
      "filter_recipes_by_diet",       // app/(tabs)/recipes.tsx, stores/useDietStore.ts
      "filter_recipes_by_allergens",  // app/(tabs)/recipes.tsx, stores/useAllergensStore.ts
      "generate_meal_plan",           // stores/useRecipesStore.ts, services/recipe-api.ts
      "add_recipe_to_meal_plan",      // stores/useRecipesStore.ts, app/(tabs)/meals.tsx
      "remove_recipe_from_meal_plan", // stores/useRecipesStore.ts, app/(tabs)/meals.tsx
      "share_recipe",                 // components/recipe-card.tsx, app/recipe/[id].tsx
      "rate_recipe",                  // app/recipe/[id].tsx, stores/useRecipesStore.ts
    ],
  },
  {
    domain: "activity_tracking",
    intents: [
      "log_activity",                 // stores/useActivityStore.ts, app/(tabs)/activity.tsx
      "get_activity_history",         // stores/useActivityStore.ts, components/activity-card.tsx
      "get_activity_stats",           // app/(tabs)/analytics.tsx, components/stat-card.tsx
      "set_activity_goal",            // stores/useActivityStore.ts, components/week-progress-card.tsx
      "log_distance",                 // stores/useActivityStore.ts, hooks/use-step-counter.ts
      "log_flights_climbed",          // stores/useActivityStore.ts, components/activity-modal.tsx
      "log_active_minutes",           // stores/useActivityStore.ts, components/activity-card.tsx
      "get_weekly_activity_summary",  // app/(tabs)/analytics.tsx, components/week-progress-card.tsx
      "log_workout",                  // stores/useActivityStore.ts, app/(tabs)/activity.tsx
      "get_workout_history",          // stores/useActivityStore.ts, components/activity-modal.tsx
    ],
  },
  {
    domain: "body_composition",
    intents: [
      "log_body_weight",              // components/body-fat-chart.tsx, stores/useGoalsStore.ts
      "log_body_fat",                 // components/body-fat-chart.tsx, useGoalsStore.ts
      "log_muscle_mass",              // components/body-fat-chart.tsx, useGoalsStore.ts
      "log_waist_circumference",      // components/body-fat-chart.tsx, useGoalsStore.ts
      "get_body_composition_history", // app/(tabs)/analytics.tsx, components/body-fat-chart.tsx
      "get_body_composition_trends",  // app/(tabs)/analytics.tsx, components/body-fat-chart.tsx
      "set_body_composition_goal",    // stores/useGoalsStore.ts, components/body-fat-chart.tsx
      "get_body_composition_goal",    // stores/useGoalsStore.ts, components/body-fat-chart.tsx
    ],
  },
  {
    domain: "social",
    intents: [
      "invite_friend",                // components/invite-friends-card.tsx, assets/images/friend-avatar-*.png
      "get_friend_list",              // components/invite-friends-card.tsx, stores/useUserStore.ts
      "get_friend_activity",          // components/invite-friends-card.tsx, stores/useActivityStore.ts
      "send_friend_request",          // components/invite-friends-card.tsx, stores/useUserStore.ts
      "accept_friend_request",        // components/invite-friends-card.tsx, stores/useUserStore.ts
      "remove_friend",                // components/invite-friends-card.tsx, stores/useUserStore.ts
      "get_friend_leaderboard",       // app/(tabs)/analytics.tsx, components/week-progress-card.tsx
      "share_achievement",            // components/invite-friends-card.tsx, stores/useActivityStore.ts
      "get_friend_profile",           // components/invite-friends-card.tsx, stores/useUserStore.ts
      "post_to_feed",                 // app/(tabs)/activity.tsx, components/invite-friends-card.tsx
    ],
  },
  {
    domain: "chat_assistant",
    intents: [
      "ask_nutrition_question",       // app/(tabs)/chat.tsx, services/usda.ts
      "ask_health_tip",               // app/(tabs)/chat.tsx, stores/useActivityStore.ts
      "ask_recipe_suggestion",        // app/(tabs)/chat.tsx, services/recipe-api.ts
      "ask_meal_plan_advice",         // app/(tabs)/chat.tsx, stores/useMealsStore.ts
      "ask_workout_recommendation",   // app/(tabs)/chat.tsx, stores/useActivityStore.ts
      "ask_sleep_advice",             // app/(tabs)/chat.tsx, stores/useSleepStore.ts
      "ask_water_intake_advice",      // app/(tabs)/chat.tsx, stores/useHydrationStore.ts
      "ask_general_health_question",  // app/(tabs)/chat.tsx, general
      "log_chat_feedback",            // app/(tabs)/chat.tsx, stores/useUserStore.ts
      "get_chat_history",             // app/(tabs)/chat.tsx, stores/useUserStore.ts
    ],
  },
  {
    domain: "analytics_and_insights",
    intents: [
      "get_daily_calorie_summary",    // app/(tabs)/analytics.tsx, components/calories-card.tsx
      "get_weekly_nutrition_report",  // app/(tabs)/analytics.tsx, components/nutrition-chart.tsx
      "get_macro_trends",             // app/(tabs)/analytics.tsx, components/macro-breakdown-chart.tsx
      "get_hydration_trends",         // app/(tabs)/analytics.tsx, components/water-card.tsx
      "get_sleep_quality_trends",     // app/(tabs)/analytics.tsx, components/sleep-modal.tsx
      "get_activity_trends",          // app/(tabs)/analytics.tsx, components/activity-card.tsx
      "get_weight_trends",            // app/(tabs)/analytics.tsx, components/body-fat-chart.tsx
      "get_insights_recommendations", // app/(tabs)/analytics.tsx, components/week-progress-card.tsx
      "get_weekly_progress",          // app/(tabs)/analytics.tsx, components/week-progress-card.tsx
      "export_health_data",           // app/(tabs)/analytics.tsx, stores/*
    ],
  },
  {
    domain: "user_account",
    intents: [
      "login",                        // app/(auth)/login.tsx, stores/useUserStore.ts
      "signup",                       // app/(auth)/login.tsx, stores/useUserStore.ts
      "logout",                       // app/(auth)/login.tsx, stores/useUserStore.ts
      "update_profile",               // app/profile.tsx, stores/useUserStore.ts
      "change_password",              // app/settings.tsx, stores/useUserStore.ts
      "update_settings",              // app/settings.tsx, stores/useUserStore.ts
      "get_user_profile",             // app/profile.tsx, stores/useUserStore.ts
      "delete_account",               // app/settings.tsx, stores/useUserStore.ts
      "reset_password",               // app/(auth)/login.tsx, stores/useUserStore.ts
      "update_notification_preferences", // app/settings.tsx, stores/useUserStore.ts
    ],
  },
];

// ---------------------------------------------------------------------------
// Rest of the script (unchanged)
// ---------------------------------------------------------------------------

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


