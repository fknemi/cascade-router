// src/telemetry.ts
// Fixed: Use correct Neatlogs API - trace() expects (name, fn, config)

let initialized = false;
let neatlogsModule: any = null;

// Try to load neatlogs, but don't fail if it's not available
async function loadNeatlogs(): Promise<any> {
  if (neatlogsModule !== null) {
    return neatlogsModule;
  }

  try {
    const module = await import('neatlogs');
    neatlogsModule = module.default || module;
    console.log('[Telemetry] Neatlogs loaded successfully');
    return neatlogsModule;
  } catch (error: any) {
    console.warn('[Telemetry] Failed to load neatlogs:', error.message);
    console.warn('[Telemetry] Continuing without telemetry...');
    neatlogsModule = false;
    return null;
  }
}

export async function initTelemetry() {
  if (initialized) return;
  
  const neatlogs = await loadNeatlogs();
  
  if (!neatlogs || typeof neatlogs.init !== 'function') {
    console.log('[Telemetry] Telemetry not available - using no-op mode');
    initialized = true;
    return;
  }

  try {
    const apiKey = process.env.NEATLOGS_API_KEY;
    
    if (!apiKey) {
      console.warn('[Telemetry] NEATLOGS_API_KEY not set - telemetry disabled');
      initialized = true;
      return;
    }

    await neatlogs.init({
      apiKey,
      workflowName: 'cascade-v3',
    });
    
    console.log('[Telemetry] Initialized successfully');
    initialized = true;
  } catch (error: any) {
    console.error('[Telemetry] Init failed:', error.message);
    console.log('[Telemetry] Continuing without telemetry...');
    initialized = true;
  }
}

export async function flushTelemetry() {
  if (!initialized) return;
  
  try {
    const neatlogs = await loadNeatlogs();
    
    if (!neatlogs) {
      initialized = false;
      return;
    }
    
    if (typeof neatlogs.flush === 'function') {
      await neatlogs.flush();
    }
    if (typeof neatlogs.shutdown === 'function') {
      await neatlogs.shutdown();
    }
  } catch (error: any) {
    console.error('[Telemetry] Flush failed:', error.message);
  } finally {
    initialized = false;
  }
}

// ─── Create a no-op span object ──────────────────────────────────────────
function createNoopSpan(name: string, attributes: Record<string, any> = {}) {
  return {
    _name: name,
    _attributes: { ...attributes },
    _ended: false,
    setAttribute(key: string, value: any) {
      this._attributes[key] = value;
    },
    setTraceOutput(output: any) {
      this._attributes.output = output;
    },
    end() {
      this._ended = true;
    },
  };
}

// ─── Create a real span using neatlogs ────────────────────────────────────
function createRealSpan(
  neatlogs: any,
  kind: string,
  name: string,
  attributes: Record<string, any> = {}
) {
  const spanObj = {
    _neatlogs: neatlogs,
    _kind: kind,
    _name: name,
    _attributes: { ...attributes },
    _span: null as any,
    _ended: false,
    
    setAttribute(key: string, value: any) {
      this._attributes[key] = value;
      if (this._span && typeof this._span.setAttribute === 'function') {
        this._span.setAttribute(`neatlogs.${key}`, value);
      }
    },
    
    setTraceOutput(output: any) {
      this._attributes.output = output;
      if (this._span && typeof this._span.setOutput === 'function') {
        this._span.setOutput(output);
      }
    },
    
    end() {
      if (this._ended) return;
      this._ended = true;
      
      // If we have a real span, end it
      if (this._span && typeof this._span.end === 'function') {
        this._span.end();
      }
    },
  };
  
  // Try to create a real span using the trace API with callback
  try {
    if (typeof neatlogs.trace === 'function') {
      // Use trace with callback pattern
      neatlogs.trace(name, (span: any) => {
        spanObj._span = span;
        
        // Set initial attributes
        Object.entries(attributes).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            span.setAttribute(`neatlogs.${key}`, value);
          }
        });
        
        // Set kind if possible
        if (typeof span.setKind === 'function') {
          span.setKind(kind);
        }
      }, {
        kind,
      });
    }
  } catch (e) {
    // Silently fail - use no-op span
  }
  
  return spanObj;
}

export function startWorkflowSpan(name: string, attributes: Record<string, any> = {}) {
  if (!initialized) return createNoopSpan(name, attributes);
  
  const neatlogs = neatlogsModule;
  if (!neatlogs) return createNoopSpan(name, attributes);
  
  return createRealSpan(neatlogs, 'WORKFLOW', name, attributes);
}

export function startChainSpan(name: string, parentSpan: any = null, attributes: Record<string, any> = {}) {
  if (!initialized) return createNoopSpan(name, attributes);
  
  const neatlogs = neatlogsModule;
  if (!neatlogs) return createNoopSpan(name, attributes);
  
  return createRealSpan(neatlogs, 'CHAIN', name, attributes);
}

export function startAgentSpan(name: string, parentSpan: any = null, attributes: Record<string, any> = {}) {
  if (!initialized) return createNoopSpan(name, attributes);
  
  const neatlogs = neatlogsModule;
  if (!neatlogs) return createNoopSpan(name, attributes);
  
  return createRealSpan(neatlogs, 'AGENT', name, attributes);
}

export function startGuardrailSpan(name: string, parentSpan: any = null, attributes: Record<string, any> = {}) {
  if (!initialized) return createNoopSpan(name, attributes);
  
  const neatlogs = neatlogsModule;
  if (!neatlogs) return createNoopSpan(name, attributes);
  
  return createRealSpan(neatlogs, 'GUARDRAIL', name, attributes);
}

export function startEmbeddingSpan(name: string, parentSpan: any = null, attributes: Record<string, any> = {}) {
  if (!initialized) return createNoopSpan(name, attributes);
  
  const neatlogs = neatlogsModule;
  if (!neatlogs) return createNoopSpan(name, attributes);
  
  return createRealSpan(neatlogs, 'EMBEDDING', name, attributes);
}

export function setSpanAttributes(span: any, attributes: Record<string, any>) {
  if (!span) return;
  
  try {
    Object.entries(attributes).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        span.setAttribute(key, value);
      }
    });
  } catch (error: any) {
    // Silently fail
  }
}

export function setTraceOutput(span: any, output: any) {
  if (!span || output === undefined || output === null) return;
  
  try {
    span.setTraceOutput(output);
  } catch (error: any) {
    // Silently fail
  }
}

export function endSpan(span: any, error?: Error) {
  if (!span) return;
  
  try {
    if (error) {
      span.setAttribute('error', true);
      span.setAttribute('error.message', error.message);
    }
    span.end();
  } catch (e: any) {
    // Silently fail
  }
}

export function isTelemetryReady(): boolean {
  return initialized && neatlogsModule !== null && neatlogsModule !== false;
}

// ─── Wrap function for LLM clients ─────────────────────────────────────────
export function wrapLLMClient(client: any): any {
  if (!initialized) return client;
  
  const neatlogs = neatlogsModule;
  if (!neatlogs || typeof neatlogs.wrap !== 'function') {
    return client;
  }
  
  try {
    return neatlogs.wrap(client);
  } catch (error: any) {
    console.error('[Telemetry] Failed to wrap LLM client:', error.message);
    return client;
  }
}
