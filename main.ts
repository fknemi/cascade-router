// main.ts - Everything routes through Cascade
import express from 'express';
import axios from 'axios';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// === LOAD OPENCODE CONFIG ===
function loadConfig(): any {
  const locations = [
    join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
    join(homedir(), '.config', 'opencode', 'opencode.json'),
    join(process.cwd(), 'opencode.jsonc'),
    join(process.cwd(), 'opencode.json'),
  ];
  
  for (const loc of locations) {
    try {
      if (existsSync(loc)) {
        const raw = readFileSync(loc, 'utf-8');
        const cleanRaw = raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        const config = JSON.parse(cleanRaw);
        console.log(`[Config] Loaded: ${loc}`);
        return config;
      }
    } catch (e) {
      console.log(`[Config] Failed: ${loc}`);
    }
  }
  throw new Error('opencode config not found');
}

const config = loadConfig();
const providers = config.provider || {};

// === RESOLVE MODEL TO BACKEND ===
function resolveBackend(modelString: string): { baseURL: string; apiKey: string; actualModel: string } {
  // If model is "deepseek/deepseek-v4-flash" format
  const parts = modelString.split('/');
  if (parts.length >= 2) {
    const providerName = parts[0];
    const modelName = parts.slice(1).join('/');
    const provider = providers[providerName];
    
    if (provider) {
      return {
        baseURL: provider.options?.baseURL || '',
        apiKey: provider.options?.apiKey || '',
        actualModel: modelName,
      };
    }
  }
  
  // Fallback: look in ao-router models
  const aoRouter = providers['ao-router'];
  if (aoRouter?.models?.[modelString]) {
    const modelConfig = aoRouter.models[modelString];
    const targetId = modelConfig.id || modelString;
    
    const targetParts = targetId.split('/');
    const providerName = targetParts[0];
    const modelName = targetParts.slice(1).join('/');
    const provider = providers[providerName];
    
    if (provider) {
      return {
        baseURL: provider.options?.baseURL || '',
        apiKey: provider.options?.apiKey || '',
        actualModel: modelName,
      };
    }
  }
  
  // Default: use deepseek
  const deepseekProvider = providers['deepseek'];
  if (deepseekProvider) {
    return {
      baseURL: deepseekProvider.options?.baseURL || '',
      apiKey: deepseekProvider.options?.apiKey || '',
      actualModel: 'deepseek-v4-flash',
    };
  }
  
  throw new Error(`Cannot resolve backend for: ${modelString}`);
}

// === CALL BACKEND ===
async function callBackend(resolved: any, messages: any[]) {
  const url = `${resolved.baseURL}/chat/completions`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (resolved.apiKey && resolved.apiKey !== '' && resolved.apiKey !== 'local-router-key' && resolved.apiKey !== 'sk-xxx') {
    headers['Authorization'] = `Bearer ${resolved.apiKey}`;
  }
  
  const response = await axios.post(url, {
    model: resolved.actualModel,
    messages,
    stream: false,
  }, { headers });
  
  return response.data;
}

// === CASCADE PIPELINE ===
async function cascadePipeline(userQuery: string, modelRequested: string, resolved: any) {
  const traceId = randomUUID();
  
  console.log(`\n=== CASCADE PIPELINE ===`);
  console.log(`Trace: ${traceId}`);
  console.log(`Model: ${modelRequested}`);
  console.log(`Backend: ${resolved.actualModel}`);
  console.log(`Query: "${userQuery.substring(0, 100)}..."`);
  
  // TODO: Step 1 - Intent routing via pgvector
  // const bundle = await routeIntent(userQuery);
  
  // TODO: Step 2 - Create AO worktree sandbox
  
  // TODO: Step 3 - Student drafts in sandbox
  
  // TODO: Step 4 - Gate validation (Layer 1 + Layer 2)
  
  // TODO: Step 5 - TensorMux: commit or rollback + Teacher fallback
  
  return {
    trace_id: traceId,
    path: 'cascade_pipeline',
    status: 'implementing',
    model_requested: modelRequested,
    backend_model: resolved.actualModel,
  };
}

// Request logging
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Model:', req.body?.model);
  next();
});

// === MAIN ENDPOINT - EVERYTHING GOES THROUGH CASCADE ===
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const modelRequested = req.body.model || 'auto';
    const messages = req.body.messages || [];
    const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user');
    const userQuery = lastUserMessage?.content || '';
    const isStreaming = req.body.stream === true;
    
    console.log(`[Router] Request: ${modelRequested}`);
    
    // Resolve backend
    const resolved = resolveBackend(modelRequested);
    console.log(`[Router] Backend: ${resolved.baseURL} (${resolved.actualModel})`);
    
    // Run Cascade pipeline FIRST
    const cascadeResult = await cascadePipeline(userQuery, modelRequested, resolved);
    
    // Call actual backend
    const backendResponse = await callBackend(resolved, messages);
    const content = backendResponse.choices?.[0]?.message?.content || '';
    
    // Return with Cascade metadata
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      res.write(`data: ${JSON.stringify({
        id: 'cascade-' + cascadeResult.trace_id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelRequested,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content },
          finish_reason: null,
        }],
      })}\n\n`);
      
      res.write(`data: ${JSON.stringify({
        id: 'cascade-' + cascadeResult.trace_id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelRequested,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      })}\n\n`);
      
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        ...backendResponse,
        model: modelRequested,
        cascade_metadata: cascadeResult,
      });
    }
  } catch (error: any) {
    console.error('Router error:', error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'cascade' });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`Cascade v3 Router on http://localhost:${PORT}`);
  console.log(`ALL requests go through Cascade pipeline`);
  console.log(`========================================\n`);
});
