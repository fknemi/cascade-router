# Cascade v3

**Inference-time agent execution framework that gets frontier-model reliability at micro-model cost.**

Instead of using an expensive LLM to judge another LLM's output, Cascade uses deterministic code checks. A cheap, fast "Student" model drafts answers. A verification gate checks them with real code (schema validation + Python invariants). If it passes, you get the answer in ~1.5s for $0.005. If it fails, Cascade auto-routes to a "Teacher" model (frontier-class) for the reliable path. Every Teacher success gets distilled into new invariants, so the system gets smarter over time.


---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Set your API key
cp .env.example .env
# Edit .env → add your DeepSeek API key

# 3. Run the server
bun main.ts
```

Server starts at `http://localhost:3000`

---

## What It Does

| Stage | What Happens |
|-------|-------------|
| **Route** | Matches query to an intent profile (SOP + schema + invariants) |
| **Draft** | Student model (cheap/fast) generates JSON output |
| **Verify** | Layer 1 checks structure, Layer 2 runs Python invariant assertions |
| **Pass** | Result returned instantly (~$0.005) |
| **Fail** | Auto-fallback to Teacher model (~$0.12, higher reliability) |
| **Learn** | Teacher success → new invariant synthesized for next time |

---

## API Examples

### Basic Chat Completion

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

### Streaming Response

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Draft a journal entry for the reconciliation"}
    ],
    "stream": true
  }'
```

### With Tools (Code Queries)

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Find improvements to speed up the yolo model in this repo"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "Read a file from the repo",
          "parameters": {
            "type": "object",
            "properties": {
              "path": {"type": "string"}
            }
          }
        }
      }
    ]
  }'
```

### Health Check

```bash
curl http://localhost:3000/health
```

---

## Example Intent Bundle

What a matched intent looks like internally:

```json
{
  "routing_metadata": {
    "intent_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "intent_name": "reconcile_and_draft_je",
    "domain": "month_end_close",
    "model_target": "llama-3-8b"
  },
  "execution_assets": {
    "sop_version": 3,
    "sop_text": "Step 1: Check GL account balances. Step 2: Compare to statement debit entries..."
  },
  "verification_assets": {
    "layer1_schema": {
      "type": "object",
      "properties": {
        "matched": {"type": "boolean"},
        "je": {
          "type": "object",
          "properties": {
            "dr": {"type": "string"},
            "cr": {"type": "string"},
            "amount": {"type": "number"}
          },
          "required": ["dr", "cr", "amount"]
        }
      },
      "required": ["matched", "je"]
    },
    "layer2_invariant_code": "def verify_logic(payload, state):\n    je = payload.get('je', {})\n    assert je.get('dr') == '1010', 'Must use asset account 1010'\n    assert je.get('dr') != je.get('cr'), 'Debits and Credits must balance, not match'"
  }
}
```

---

## Example Output

```json
{
  "id": "cascade-uuid",
  "model": "cascade-student",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "**Reconciliation Results**\n\n**Summary:**\n- Purchase Orders Received: 12\n- Invoices Received: 14\n- Confirmed Matches: 10\n..."
      },
      "finish_reason": "stop"
    }
  ],
  "cascade_metadata": {
    "trace_id": "uuid",
    "path": "student_fast_path",
    "status": "passed",
    "latency_ms": 1200,
    "cost_usd": 0.005
  }
}
```

---

## Demo Talking Points

- **"The moat is deterministic verification."** No LLM judging LLMs. Real code asserts real invariants.
- **"Fast path is 8x cheaper and 10x faster."** ~$0.005 vs $0.12, ~1.5s vs ~12s.
- **"It self-heals."** Every Teacher success becomes a new invariant. The gate gets stricter automatically.
- **"Zero side effects during drafting."** Sandboxed execution — nothing commits until the gate passes.

---

## Scripts

```bash
bun run build              # TypeScript build
bun run contract:emit      # Emit Prisma contract
bun scripts/test-gate.ts   # Test the verification gate
bun scripts/test-router.ts # Test intent routing
bun scripts/test-student.ts # Test Student model
```

---

## Troubleshooting

**API key missing**: Set `DEEPSEEK_API_KEY` in `.env`

**Tool call loop**: System caps tool rounds at 6, then forces a final answer. That's intentional.

**Prisma not initialized**: Run `bun run contract:emit` first.
