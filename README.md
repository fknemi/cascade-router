# Cascade-Router

Cascade is an inference-time agent execution framework designed for hackathons to get frontier-model reliability at micro-model cost. Instead of using an expensive LLM as a judge, it uses deterministic code checks. A fast/cheap "Student" model drafts an answer, which is verified against a JSON schema and sandboxed Python invariants. If verification passes, it returns instantly. If it fails, it falls back to a highly capable "Teacher" model.

---

## File Structure

```text
.
├── main.ts                 # Main server entry point
├── prisma/
│   └── schema.prisma       # Database schema and models
├── scripts/
│   ├── setup-db.sh         # PostgreSQL + pgvector initialization script
│   ├── test-gate.ts        # Test script for the verification gate
│   ├── test-router.ts      # Test script for intent routing
│   └── test-student.ts     # Test script for Student model execution
├── opencode.json           # OpenCode integration config
├── package.json            # Project dependencies
└── .env                    # Environment variables

```

---

## Setup Instructions

**Prerequisites:** You need [Bun](https://bun.sh/) and [Docker](https://www.docker.com/) installed on your machine.

### 1. Install Dependencies

```bash
bun install

```

### 2. Setup PostgreSQL + pgvector Database

Create a script named `setup-db.sh` in your project root or `scripts/` folder and run it to initialize the database via Docker.

```bash
#!/bin/bash
set -e

echo "1. Stopping and removing any existing container..."
docker rm -f cascade_pgvector 2>/dev/null || true
docker volume rm cascade_pg_data 2>/dev/null || true

echo "2. Starting fresh PostgreSQL with pgvector..."
docker run -d \
  --name cascade_pgvector \
  -e POSTGRES_USER=cascade \
  -e POSTGRES_PASSWORD=cascade_dev_password \
  -e POSTGRES_DB=cascade \
  -p 5432:5432 \
  -v cascade_pg_data:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

echo "3. Waiting for database to be ready..."
until docker exec cascade_pgvector pg_isready -U cascade >/dev/null 2>&1; do
  sleep 1
done
echo "   Database is ready!"

echo "4. Enabling pgvector extension..."
docker exec cascade_pgvector psql -U cascade -d cascade -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "5. Emitting Prisma contract..."
bunx prisma contract emit

echo "6. Initializing database schema..."
export DATABASE_URL="postgres://cascade:cascade_dev_password@localhost:5432/cascade"
bunx prisma db init

echo "7. Adding native vector column..."
docker exec cascade_pgvector psql -U cascade -d cascade -c "ALTER TABLE intent_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(768);"

echo "8. Creating HNSW index for cosine similarity..."
docker exec cascade_pgvector psql -U cascade -d cascade -c "CREATE INDEX IF NOT EXISTS embedding_vector_hnsw_idx ON intent_embeddings USING hnsw (embedding_vector vector_cosine_ops);"

echo ""
echo "   ✅ Setup Complete!"
echo "   Connection: postgres://cascade:cascade_dev_password@localhost:5432/cascade"
echo "   Container:  cascade_pgvector"

```

Run it:

```bash
bash setup-db.sh

```

### 3. Environment Variables

Create a `.env` file in the root directory and configure it as follows:

```env
# ─── DeepSeek API Configuration ────────────────────────────────────────────
DEEPSEEK_API_KEY=your-deepseek-api-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com

# ─── Student/Teacher Models ────────────────────────────────────────────────
STUDENT_MODEL=deepseek-v4-flash
TEACHER_MODEL=deepseek-v4-pro

# ─── Neatlogs Telemetry ────────────────────────────────────────────────────
NEATLOGS_API_KEY=your-neatlogs-api-key-here

# ─── Database Configuration ────────────────────────────────────────────────
DATABASE_URL=postgresql://cascade:cascade_dev_password@localhost:5432/cascade
PGHOST=localhost
PGPORT=5432
PGUSER=cascade
PGPASSWORD=cascade_dev_password
PGDATABASE=cascade

# ─── Ollama Configuration ──────────────────────────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=nomic-embed-text

# ─── Server Configuration ──────────────────────────────────────────────────
PORT=3000
NODE_ENV=development

# ─── Performance Targets ───────────────────────────────────────────────────
FAST_PATH_LATENCY_MS=1500
FAST_PATH_COST_USD=0.005
FALLBACK_COST_USD=0.12
MUTATION_CATCH_RATE=10

# ─── AO Configuration ──────────────────────────────────────────────────────
# for windows
# AO_DB_PATH=C:\Users\<USERNAME>\.ao\data\ao.db 
# AO_WORKTREES_PATH=C:\Users\<USERNAME>\.ao\data\worktrees
AO_DB_PATH=~/.ao/data/ao.db
AO_WORKTREES_PATH=~/.ao/data/worktrees

# ─── Logging ───────────────────────────────────────────────────────────────
LOG_LEVEL=info

```

### 4. Configure OpenCode

To route your OpenCode workspace through Cascade, add this to your `opencode.json`. Ensure both the `ao-router` and `deepseek` providers are configured side-by-side so OpenCode can utilize both natively.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ao-router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AO Router",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "local-router-key"
      },
      "models": {
        "student": {
          "id": "deepseek/deepseek-v4-flash",
          "name": "Student (Fast Draft)"
        },
        "teacher": {
          "id": "deepseek/deepseek-v4-pro",
          "name": "Teacher (Reliable Fallback)"
        },
        "auto": {
          "id": "deepseek/deepseek-v4-pro",
          "name": "Cascade Router"
        }
      }
    },
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": ""
      },
      "models": {
        "deepseek-v4-flash": {
          "id": "deepseek-v4-flash"
        },
        "deepseek-v4-flash-vision-exp": {
          "id": "deepseek-v4-flash-vison-exp"
        },
        "deepseek-v4-pro": {
          "options": {
            "thinking": {
              "type": "disabled"
            }
          }
        }
      }
    }
  }
}

```

---

## How to Run

**1. Start the Server**

```bash
bun main.ts

```

*The server will start at `http://localhost:3000*`

**2. Test the API (Chat Completion)**
In a new terminal, test the local routing endpoint:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Reconcile invoice #1234 with PO #5678"}
    ]
  }'

```

**3. Run Specific Tests (Optional)**

```bash
bun scripts/test-router.ts
bun scripts/test-gate.ts

```
