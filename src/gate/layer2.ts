// src/gate/layer2.ts - Semantic Invariant Gate
// Executes Python invariant code in a restricted subprocess

import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const execAsync = promisify(exec);

// Clean invariant code (remove markdown fences, extract function)
function cleanInvariantCode(code: string): string {
  let cleaned = code.trim();

  // Remove markdown code blocks (python or generic)
  cleaned = cleaned.replace(/```python\s*/g, '');
  cleaned = cleaned.replace(/```\s*/g, '');

  return cleaned.trim();
}

// Ensure the code contains a `verify_logic` function.
// If only assert statements are provided, wrap them.
function extractVerifyLogic(code: string): string {
  // If already has the function, return as-is
  if (/\bdef\s+verify_logic\b/.test(code)) {
    return code;
  }

  // Otherwise wrap the raw statements into a function
  const indented = code
    .split('\n')
    .map(line => '    ' + line)
    .join('\n');
  return `def verify_logic(payload, state):\n${indented}`;
}

// Build a Python script that loads the invariant code and runs it
function buildPythonScript(finalCode: string, draft: any, state: any): string {
  const payloadJson = JSON.stringify(draft);
  const stateJson = JSON.stringify(state);

  // Escape single quotes for Python single‑quoted strings
  const escapedPayload = payloadJson.replace(/'/g, "\\'");
  const escapedState = stateJson.replace(/'/g, "\\'");

  return `import json

${finalCode}

# Auto-invoke verify_logic with the provided payload and state
try:
    payload = json.loads('${escapedPayload}')
    state = json.loads('${escapedState}')
    verify_logic(payload, state)
    print("PASS")
except AssertionError as e:
    print(f"FAIL: {e}")
except Exception as e:
    print(f"ERROR: {type(e).__name__}: {e}")
`;
}

export async function layer2Validate(
  draft: any,
  invariantCode: string,
  state: any = {}
): Promise<{ passed: boolean; output: string; execution_ms?: number }> {
  if (!invariantCode || invariantCode.trim() === '') {
    console.log("[Layer 2] No invariant code - skipping");
    return { passed: true, output: "skipped", execution_ms: 0 };
  }

  // Clean and prepare the invariant code
  const cleanCode = cleanInvariantCode(invariantCode);
  const finalCode = extractVerifyLogic(cleanCode);

  console.log("[Layer 2] Invariant code preview:");
  console.log(finalCode.substring(0, 300) + (finalCode.length > 300 ? "..." : ""));

  // Build the script
  const script = buildPythonScript(finalCode, draft, state);

  // Write to a temporary file (easier to debug, avoids shell escaping issues)
  const tmpFile = path.join(os.tmpdir(), `cascade_inv_${Date.now()}.py`);
  fs.writeFileSync(tmpFile, script);

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await execAsync(`python3 ${tmpFile}`, {
      timeout: 5000, // 5 seconds
      maxBuffer: 1024 * 1024, // 1 MB
    });

    const executionMs = Date.now() - startTime;
    const output = stdout.trim();
    const passed = output.includes("PASS") && !output.includes("FAIL") && !output.includes("ERROR");

    console.log(`[Layer 2] ${passed ? '✅ PASSED' : '❌ FAILED'} (${executionMs}ms)`);
    if (!passed) {
      console.log(`[Layer 2] Output: ${output}`);
      if (stderr) console.log(`[Layer 2] Stderr: ${stderr}`);
    }

    return { passed, output, execution_ms: executionMs };
  } catch (error: any) {
    const executionMs = Date.now() - startTime;
    const output = error.stdout?.trim() || error.message;
    console.log(`[Layer 2] ❌ FAILED (execution error) (${executionMs}ms)`);
    console.log(`[Layer 2] Output: ${output}`);

    return { passed: false, output, execution_ms: executionMs };
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpFile);
    } catch (e) {
      // ignore cleanup errors
    }
  }
}

// Sandboxed variant with resource limits (CPU, memory)
export async function layer2ValidateSandboxed(
  draft: any,
  invariantCode: string,
  state: any = {}
): Promise<{ passed: boolean; output: string; execution_ms?: number }> {
  const cleanCode = cleanInvariantCode(invariantCode);
  const finalCode = extractVerifyLogic(cleanCode);
  const script = buildPythonScript(finalCode, draft, state);

  const tmpFile = path.join(os.tmpdir(), `cascade_inv_sandbox_${Date.now()}.py`);
  fs.writeFileSync(tmpFile, script);

  // Use resource limits via a Python wrapper
  const sandboxCmd = `python3 -c "
import resource
import sys
import os

# Set resource limits
resource.setrlimit(resource.RLIMIT_CPU, (1, 1))      # 1 second CPU
resource.setrlimit(resource.RLIMIT_AS, (100*1024*1024, 100*1024*1024))  # 100 MB memory

try:
    exec(open('${tmpFile}').read())
except Exception as e:
    print(f'ERROR: {e}')
"`;

  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execAsync(sandboxCmd, {
      timeout: 3000, // 3 seconds wall time
      maxBuffer: 1024 * 1024,
    });

    const executionMs = Date.now() - startTime;
    const output = stdout.trim();
    const passed = output.includes("PASS") && !output.includes("FAIL") && !output.includes("ERROR");

    console.log(`[Layer 2 Sandboxed] ${passed ? '✅ PASSED' : '❌ FAILED'} (${executionMs}ms)`);
    return { passed, output, execution_ms: executionMs };
  } catch (error: any) {
    const executionMs = Date.now() - startTime;
    const output = error.stdout?.trim() || error.message;
    return { passed: false, output, execution_ms: executionMs };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (e) {}
  }
}
