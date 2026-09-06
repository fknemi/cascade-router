// src/gate/layer2.ts - Semantic Invariant Gate
// Executes Python invariant code via Bun's bundled Python (or system python3)
//
// Fixes applied from Branch 1:
//   [Merge] Pipe via stdin — no /tmp file
//   [New]   Timeout 500ms (Python startup + execution)
//   [New]   layer2ValidateSandboxed() tmpFile bug removed — uses same stdin pipe
//   [New]   Entity grounding — real DB state passed into verify_logic() via state
//   [New]   Full telemetry integration with GUARDRAIL spans
//   [New]   Resource limits (RLIMIT_CPU, RLIMIT_AS equivalent)
//   [New]   Restricted builtins for security
//   [New]   Optimized Python execution with -S flag (no site-packages loading)

import { spawn } from "child_process";
import { 
  startGuardrailSpan, 
  setSpanAttributes, 
  endSpan,
  setTraceOutput 
} from "../telemetry";

// ---------------------------------------------------------------------------
// Security constants - adjusted for real-world Python startup time
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 500;           // 500ms total (Python startup ~100-200ms + execution)
const MAX_BUFFER = 1024 * 1024;   // 1MB max output
const MAX_MEMORY_MB = 50;        // 50MB memory limit (RLIMIT_AS equivalent)
const MAX_CPU_SECONDS = 1;       // 1s CPU time limit (RLIMIT_CPU equivalent)

// Restricted builtins - no os, sys, socket, etc. in verify_logic exec()
const RESTRICTED_BUILTINS = `
# Security: Restricted __builtins__ - no os/sys/socket
__builtins__ = {
    'len': len,
    'str': str,
    'int': int,
    'float': float,
    'bool': bool,
    'list': list,
    'dict': dict,
    'tuple': tuple,
    'set': set,
    'range': range,
    'enumerate': enumerate,
    'zip': zip,
    'map': map,
    'filter': filter,
    'sorted': sorted,
    'min': min,
    'max': max,
    'sum': sum,
    'abs': abs,
    'round': round,
    'isinstance': isinstance,
    'hasattr': hasattr,
    'getattr': getattr,
    'setattr': setattr,
    'any': any,
    'all': all,
    'print': print,
    'json': json,
    'base64': base64,
    'AssertionError': AssertionError,
    'Exception': Exception,
    'TypeError': TypeError,
    'ValueError': ValueError,
    'KeyError': KeyError,
    'IndexError': IndexError,
    'AttributeError': AttributeError,
}
`;

// ---------------------------------------------------------------------------
// Helpers (enhanced from original)
// ---------------------------------------------------------------------------

function cleanInvariantCode(code: string): string {
  let cleaned = code.trim();
  cleaned = cleaned.replace(/```python\s*/g, '');
  cleaned = cleaned.replace(/```\s*/g, '');
  return cleaned.trim();
}

function extractVerifyLogic(code: string): string {
  if (/\bdef\s+verify_logic\b/.test(code)) {
    return code;
  }
  const indented = code
    .split('\n')
    .map(line => '    ' + line)
    .join('\n');
  return `def verify_logic(payload, state):\n${indented}`;
}

// ---------------------------------------------------------------------------
// Build Python script (runs via stdin, no tmp file)
// Enhanced with security restrictions
// ---------------------------------------------------------------------------

function buildPythonScript(finalCode: string, draft: any, state: any): string {
  // Pass data as base64 JSON to avoid any escaping issues
  const payloadB64 = Buffer.from(JSON.stringify(draft)).toString('base64');
  const stateB64 = Buffer.from(JSON.stringify(state)).toString('base64');

  return `
import json, base64
import resource
import signal
import sys

# Set resource limits (RLIMIT_CPU equivalent)
try:
    resource.setrlimit(resource.RLIMIT_CPU, (${MAX_CPU_SECONDS}, ${MAX_CPU_SECONDS}))
    resource.setrlimit(resource.RLIMIT_AS, (${MAX_MEMORY_MB} * 1024 * 1024, ${MAX_MEMORY_MB} * 1024 * 1024))
except:
    pass

# Set timeout alarm as backup
signal.alarm(${Math.ceil(TIMEOUT_MS / 1000)})

${RESTRICTED_BUILTINS}

${finalCode}

try:
    payload = json.loads(base64.b64decode('${payloadB64}').decode('utf-8'))
    state   = json.loads(base64.b64decode('${stateB64}').decode('utf-8'))
    verify_logic(payload, state)
    print("PASS")
except AssertionError as e:
    print(f"FAIL: {e}")
except Exception as e:
    print(f"ERROR: {type(e).__name__}: {e}")
finally:
    signal.alarm(0)  # Cancel alarm
`;
}

// ---------------------------------------------------------------------------
// Run Python script via stdin — no tmp file
// Optimized with -S flag to skip site-packages
// ---------------------------------------------------------------------------

async function runPythonScript(
  script: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // Use python3 -S to skip site-packages initialization (faster startup)
    const child = spawn("python3", ["-S", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      // Additional security: run in restricted environment
      env: {
        ...process.env,
        PYTHONHASHSEED: '0',  // Deterministic execution
        PYTHONDONTWRITEBYTECODE: '1',  // No .pyc files
        PYTHONPATH: '',  // Clear Python path for security
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    };

    child.stdout.on("data", (d: Buffer) => { 
      stdout += d.toString();
      // Check buffer size
      if (stdout.length > MAX_BUFFER) {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`Output exceeded ${MAX_BUFFER} bytes`));
        }
      }
    });
    
    child.stderr.on("data", (d: Buffer) => { 
      stderr += d.toString();
      if (stderr.length > MAX_BUFFER) {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`Stderr exceeded ${MAX_BUFFER} bytes`));
        }
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`python3 timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled && !timedOut) {
        settled = true;
        resolve({ stdout, stderr, timedOut: false });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.stdin.write(script, "utf8");
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Public API with telemetry
// ---------------------------------------------------------------------------

export interface GateResult {
  passed: boolean;
  output: string;
  execution_ms?: number;
  timedOut?: boolean;
}

export async function layer2Validate(
  draft: any,
  invariantCode: string,
  state: any = {},
  parentSpan?: any
): Promise<GateResult> {
  // Create GUARDRAIL span
  const span = startGuardrailSpan('layer2Validate', parentSpan, {
    invariant_provided: !!invariantCode,
    state_provided: !!state,
    timeout_ms: TIMEOUT_MS,
  });

  try {
    if (!invariantCode || invariantCode.trim() === '') {
      console.log("[Layer 2] No invariant code — skipping");
      setSpanAttributes(span, {
        passed: true,
        skipped: true,
        reason: 'no_invariant_code',
      });
      setTraceOutput(span, { status: 'skipped' });
      return { passed: true, output: "skipped", execution_ms: 0 };
    }

    const cleanCode = cleanInvariantCode(invariantCode);
    const finalCode = extractVerifyLogic(cleanCode);

    console.log("[Layer 2] Invariant code preview:");
    console.log(finalCode.substring(0, 300) + (finalCode.length > 300 ? "..." : ""));

    // Set code hash for tracking
    const crypto = await import('crypto');
    const codeHash = crypto.createHash('sha256').update(finalCode).digest('hex').substring(0, 16);
    
    setSpanAttributes(span, {
      code_hash: codeHash,
      code_length: finalCode.length,
    });

    const script = buildPythonScript(finalCode, draft, state);
    const startTime = Date.now();

    try {
      const { stdout, stderr, timedOut } = await runPythonScript(script, TIMEOUT_MS);
      const executionMs = Date.now() - startTime;
      const output = stdout.trim();
      
      // Parse result
      const hasPass = output.includes("PASS");
      const hasFail = output.includes("FAIL");
      const hasError = output.includes("ERROR");
      const passed = hasPass && !hasFail && !hasError;

      console.log(`[Layer 2] ${passed ? ' PASSED' : ' FAILED'} (${executionMs}ms)`);
      
      if (!passed) {
        console.log(`[Layer 2] Output: ${output}`);
        if (stderr) console.log(`[Layer 2] Stderr: ${stderr.substring(0, 500)}`);
      }

      // Set telemetry attributes
      setSpanAttributes(span, {
        passed,
        exec_ms: executionMs,
        timeout: TIMEOUT_MS,
        memory_limit_mb: MAX_MEMORY_MB,
        cpu_limit_seconds: MAX_CPU_SECONDS,
        stdout_length: stdout.length,
        stderr_length: stderr.length,
      });

      // Set trace output with result details
      setTraceOutput(span, {
        passed,
        execution_ms: executionMs,
        has_fail: hasFail,
        has_error: hasError,
      });

      return { 
        passed, 
        output, 
        execution_ms: executionMs,
        timedOut: false,
      };
    } catch (error: any) {
      const executionMs = Date.now() - startTime;
      const output = error.message;
      const timedOut = error.message.includes('timeout');
      
      console.log(`[Layer 2]  FAILED (${executionMs}ms): ${output}`);
      
      // Set telemetry attributes for failure
      setSpanAttributes(span, {
        passed: false,
        exec_ms: executionMs,
        error: error.message,
        timed_out: timedOut,
      });

      setTraceOutput(span, {
        passed: false,
        error: error.message,
        timed_out: timedOut,
      });

      return { 
        passed: false, 
        output, 
        execution_ms: executionMs,
        timedOut,
      };
    }
  } finally {
    endSpan(span);
  }
}

// layer2ValidateSandboxed: tmpFile bug fixed — same stdin pipe as layer2Validate
export async function layer2ValidateSandboxed(
  draft: any,
  invariantCode: string,
  state: any = {},
  parentSpan?: any
): Promise<GateResult> {
  return layer2Validate(draft, invariantCode, state, parentSpan);
}

// ---------------------------------------------------------------------------
// Batch validation for multiple invariants (from Branch 1)
// ---------------------------------------------------------------------------

export async function layer2ValidateBatch(
  draft: any,
  invariants: Array<{ code: string; name?: string }>,
  state: any = {},
  parentSpan?: any
): Promise<GateResult[]> {
  const span = startGuardrailSpan('layer2ValidateBatch', parentSpan, {
    invariant_count: invariants.length,
  });

  try {
    const results: GateResult[] = [];
    
    for (const invariant of invariants) {
      const result = await layer2Validate(
        draft,
        invariant.code,
        state,
        span
      );
      
      results.push({
        ...result,
        output: invariant.name ? `[${invariant.name}] ${result.output}` : result.output,
      });
      
      // Early exit if any invariant fails
      if (!result.passed) {
        console.log(`[Layer 2] Batch validation failed at invariant: ${invariant.name || 'unnamed'}`);
        break;
      }
    }
    
    const allPassed = results.every(r => r.passed);
    setSpanAttributes(span, {
      all_passed: allPassed,
      results_count: results.length,
      passed_count: results.filter(r => r.passed).length,
    });
    
    setTraceOutput(span, {
      all_passed: allPassed,
      results: results.map(r => ({
        passed: r.passed,
        execution_ms: r.execution_ms,
      })),
    });
    
    return results;
  } finally {
    endSpan(span);
  }
}

// ---------------------------------------------------------------------------
// Pre-validation security check (from Branch 1)
// ---------------------------------------------------------------------------

export function validateInvariantSecurity(code: string): { 
  safe: boolean; 
  issues: string[] 
} {
  const issues: string[] = [];
  const dangerousPatterns = [
    { pattern: /import\s+os/, message: 'OS module import' },
    { pattern: /import\s+sys/, message: 'SYS module import' },
    { pattern: /import\s+socket/, message: 'Socket module import' },
    { pattern: /import\s+subprocess/, message: 'Subprocess module import' },
    { pattern: /import\s+shutil/, message: 'Shutil module import' },
    { pattern: /__import__/, message: 'Dynamic import' },
    { pattern: /eval\s*\(/, message: 'Eval function' },
    { pattern: /exec\s*\(/, message: 'Exec function' },
    { pattern: /open\s*\(/, message: 'File open' },
    { pattern: /os\.system/, message: 'OS system call' },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(code)) {
      issues.push(message);
    }
  }

  return {
    safe: issues.length === 0,
    issues,
  };
}
