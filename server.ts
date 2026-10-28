/**
 * ==============================================================================
 * DRSSS AI - Node.js / Express Dev & Preview Server
 * Authors: Shantanu, Diggaj, Raj, Suraj, and Sanika.
 *
 * Implements model switching, thinking controls, dual-model automatic failover,
 * and static file serving for DRSSS AI:
 *   - GET  /api/health
 *   - POST /api/auth/register, POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout
 *   - GET  /api/download-zip
 *   - POST /api/chat (Selectable primary: gemini-3.5-flash-lite | gemini-3.6-flash -> Fallback: gemini-3.1-flash-lite)
 *   - Static file server for ./frontend
 * ==============================================================================
 */

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes, randomUUID, pbkdf2 as pbkdf2Callback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  buildGeminiContents,
  shouldFailover,
  extractCandidateText,
  validateModel,
  validateThinkingLevel,
  buildGenerationConfig,
  PRIMARY_DEFAULT_MODEL,
  ADVANCED_PRIMARY_MODEL,
  FALLBACK_MODEL,
  ThinkingLevel
} from './src/utils/gemini-failover.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'drsss_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const pbkdf2 = promisify(pbkdf2Callback);
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? '' : randomBytes(32).toString('hex'));
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ...(process.env.PGSSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {})
    })
  : null;
const localAuthStorePath = process.env.AUTH_STORE_PATH || path.join(__dirname, '.data', 'auth-users.json');
let authSchemaReady: Promise<void> | null = null;

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// CORS headers
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  next();
});

app.options('*', (_req, res) => {
  res.sendStatus(204);
});

// 1. Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'drsss-ai-server',
    models: {
      primary_default: PRIMARY_DEFAULT_MODEL,
      primary_advanced: ADVANCED_PRIMARY_MODEL,
      fallback: FALLBACK_MODEL
    },
    thinking_levels: ['medium', 'high'],
    credits: 'Built by Shantanu, Diggaj, Raj, Suraj, and Sanika.'
  });
});

// Email/password authentication. Production uses PostgreSQL; a file-backed
// store is available only for local preview/development when DATABASE_URL is absent.
interface AuthUser {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: string;
}

function authUnavailable(res: Response) {
  const missing: string[] = [];
  if (sessionSecret.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (isProduction && !pool) missing.push('DATABASE_URL');
  res.status(503).json({
    error: `Account sign-in is not configured on this server. Set ${missing.join(' and ')} in the server environment.`
  });
}

async function ensureAuthSchema(): Promise<void> {
  if (!pool) return;
  if (!authSchemaReady) {
    authSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS drsss_users (
        id TEXT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        email VARCHAR(254) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => undefined).catch((err) => {
      authSchemaReady = null;
      throw err;
    });
  }
  await authSchemaReady;
}

async function readLocalUsers(): Promise<AuthUser[]> {
  try {
    const raw = await fs.promises.readFile(localAuthStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeLocalUsers(users: AuthUser[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(localAuthStorePath), { recursive: true });
  const tempPath = `${localAuthStorePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.promises.rename(tempPath, localAuthStorePath);
}

async function findUserByEmail(email: string): Promise<AuthUser | null> {
  if (pool) {
    await ensureAuthSchema();
    const result = await pool.query<AuthUser>(
      'SELECT id, name, email, password_hash, salt, created_at::text AS created_at FROM drsss_users WHERE email = $1 LIMIT 1',
      [email]
    );
    return result.rows[0] || null;
  }
  const users = await readLocalUsers();
  return users.find(user => user.email === email) || null;
}

async function findUserById(id: string): Promise<AuthUser | null> {
  if (pool) {
    await ensureAuthSchema();
    const result = await pool.query<AuthUser>(
      'SELECT id, name, email, password_hash, salt, created_at::text AS created_at FROM drsss_users WHERE id = $1 LIMIT 1',
      [id]
    );
    return result.rows[0] || null;
  }
  const users = await readLocalUsers();
  return users.find(user => user.id === id) || null;
}

async function createUser(user: AuthUser): Promise<void> {
  if (pool) {
    await ensureAuthSchema();
    await pool.query(
      'INSERT INTO drsss_users (id, name, email, password_hash, salt, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [user.id, user.name, user.email, user.password_hash, user.salt]
    );
    return;
  }
  const users = await readLocalUsers();
  if (users.some(existing => existing.email === user.email)) {
    const duplicate: any = new Error('Email already registered');
    duplicate.code = '23505';
    throw duplicate;
  }
  users.push(user);
  await writeLocalUsers(users);
}

function publicUser(user: AuthUser) {
  return { id: user.id, name: user.name, email: user.email };
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  // 600,000 PBKDF2-HMAC-SHA256 iterations; compatible with the C++ production backend.
  const derived = await pbkdf2(password, Buffer.from(saltHex, 'hex'), 600_000, 32, 'sha256') as Buffer;
  return derived.toString('hex');
}

function createSessionToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_TTL_SECONDS * 1000 })).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSessionUserId(req: Request): string | null {
  if (!sessionSecret) return null;
  const cookieHeader = req.headers.cookie || '';
  const rawCookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (!rawCookie) return null;
  const token = rawCookie.slice(SESSION_COOKIE.length + 1);
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  try {
    const expected = createHmac('sha256', sessionSecret).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.sub !== 'string' || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data.sub;
  } catch {
    return null;
  }
}

function setSessionCookie(req: Request, res: Response, userId: string): void {
  const secure = isProduction || req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${createSessionToken(userId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(req: Request, res: Response): void {
  const secure = isProduction || req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

const authAttempts = new Map<string, { count: number; resetAt: number }>();
function authRateLimit(req: Request, res: Response, next: () => void) {
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.path}`;
  const now = Date.now();
  let record = authAttempts.get(key);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + 15 * 60 * 1000 };
    authAttempts.set(key, record);
  }
  record.count += 1;
  if (record.count > 10) {
    res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    return;
  }
  next();
}

function validateAuthConfiguration(res: Response): boolean {
  if (sessionSecret.length < 32 || (isProduction && !pool)) {
    authUnavailable(res);
    return false;
  }
  return true;
}

app.post('/api/auth/register', authRateLimit, async (req: Request, res: Response) => {
  if (!validateAuthConfiguration(res)) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (name.length < 1 || name.length > 80) {
    res.status(400).json({ error: 'Enter a name between 1 and 80 characters.' });
    return;
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (password.length < 8 || password.length > 128) {
    res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
    return;
  }

  try {
    if (await findUserByEmail(email)) {
      res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
      return;
    }
    const salt = randomBytes(16).toString('hex');
    const user: AuthUser = {
      id: randomUUID(), name, email,
      password_hash: await hashPassword(password, salt), salt,
      created_at: new Date().toISOString()
    };
    await createUser(user);
    setSessionCookie(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (error: any) {
    if (error?.code === '23505') {
      res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
      return;
    }
    console.error('[Auth] Registration failed:', error?.message || error);
    res.status(500).json({ error: 'Account creation failed. Please try again.' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req: Request, res: Response) => {
  if (!validateAuthConfiguration(res)) return;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || email.length > 254 || password.length > 128) {
    res.status(400).json({ error: 'Enter your email and password.' });
    return;
  }
  try {
    const user = await findUserByEmail(email);
    if (!user) {
      // Perform comparable work for unknown accounts to reduce timing-based enumeration.
      await hashPassword(password, '64727373732d617574682d64756d6d79');
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const candidate = Buffer.from(await hashPassword(password, user.salt), 'hex');
    const expected = Buffer.from(user.password_hash, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    setSessionCookie(req, res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error: any) {
    console.error('[Auth] Login failed:', error?.message || error);
    res.status(500).json({ error: 'Sign in failed. Please try again.' });
  }
});

app.get('/api/auth/me', async (req: Request, res: Response) => {
  if (!validateAuthConfiguration(res)) return;
  const userId = readSessionUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Not signed in.' });
    return;
  }
  try {
    const user = await findUserById(userId);
    if (!user) {
      clearSessionCookie(req, res);
      res.status(401).json({ error: 'Session is no longer valid.' });
      return;
    }
    res.json({ user: publicUser(user) });
  } catch (error: any) {
    console.error('[Auth] Session validation failed:', error?.message || error);
    res.status(500).json({ error: 'Could not validate your session.' });
  }
});

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  clearSessionCookie(_req, res);
  res.json({ ok: true });
});

// 2. Download full project ZIP endpoint
app.get('/api/download-zip', (_req: Request, res: Response) => {
  const zipPath = path.join(__dirname, 'drsss-ai-fullstack.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="drsss-ai-fullstack.zip"');
    res.sendFile(zipPath);
  } else {
    res.status(404).json({ error: 'Project ZIP archive not generated yet' });
  }
});

// Helper to call upstream Gemini REST API with authentication header and thinkingConfig
async function callGeminiRest(
  model: string,
  contents: any[],
  apiKey: string,
  thinkingLevel: ThinkingLevel = 'medium'
) {
  // Use header-based authentication strictly; never expose key in URL query string
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = {
    contents,
    generationConfig: buildGenerationConfig(thinkingLevel),
    systemInstruction: {
      parts: [
        {
          text:
            'You are an intelligent, helpful, and concise AI assistant named DRSSS AI. ' +
            'Provide well-structured Markdown answers with syntax-highlighted code when applicable. ' +
            'Credit: Designed and built by Shantanu, Diggaj, Raj, Suraj, and Sanika.'
        }
      ]
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const statusCode = response.status;
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { statusCode, data, isNetworkSuccess: true };
  } catch (netErr: any) {
    return {
      statusCode: 0,
      data: { error: { message: netErr.message || 'Network transport failure' } },
      isNetworkSuccess: false
    };
  }
}

// 4. Chat completion endpoint with model routing, thinking controls, and automatic failover
app.post('/api/chat', async (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY is not configured on the server. Please set the GEMINI_API_KEY environment variable.'
    });
    return;
  }

  const { message, history, model: rawModel, thinking_level: rawThinking } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({
      error: "Missing or invalid 'message' string field in request body."
    });
    return;
  }

  // Validate model selection against allowlist
  const selectedModel = validateModel(rawModel);
  // Validate thinking level against allowlist
  const thinkingLevel = validateThinkingLevel(rawThinking);

  const contents = buildGeminiContents(history || [], message);

  // 1. Attempt Primary Model
  console.log(`[DRSSS Chat] Attempting primary model: ${selectedModel} (thinking: ${thinkingLevel})`);
  let primaryRes = await callGeminiRest(selectedModel, contents, apiKey, thinkingLevel);

  // Check if primary succeeded
  if (primaryRes.isNetworkSuccess && primaryRes.statusCode === 200 && primaryRes.data) {
    const extracted = extractCandidateText(primaryRes.data);
    if (extracted.text) {
      console.log(`[DRSSS Chat] Completed with primary model: ${selectedModel}`);
      res.json({
        reply: extracted.text,
        model_used: selectedModel,
        thinking_level: thinkingLevel,
        fallback_used: false
      });
      return;
    }
  }

  // If failure is retryable, perform bounded 1x retry after 500ms
  const isRetryable = shouldFailover(primaryRes.statusCode, primaryRes.isNetworkSuccess);
  if (isRetryable) {
    console.warn(
      `[DRSSS Chat] Primary model ${selectedModel} failed with status ${primaryRes.statusCode}. Retrying once after 500ms...`
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    primaryRes = await callGeminiRest(selectedModel, contents, apiKey, thinkingLevel);

    if (primaryRes.isNetworkSuccess && primaryRes.statusCode === 200 && primaryRes.data) {
      const extracted = extractCandidateText(primaryRes.data);
      if (extracted.text) {
        console.log(`[DRSSS Chat] Primary retry succeeded: ${selectedModel}`);
        res.json({
          reply: extracted.text,
          model_used: selectedModel,
          thinking_level: thinkingLevel,
          fallback_used: false
        });
        return;
      }
    }
  }

  // 2. Automatic Failover to Fallback Model: gemini-3.1-flash-lite
  console.warn(
    `[DRSSS Failover] Primary model ${selectedModel} unavailable. Initiating failover to ${FALLBACK_MODEL}...`
  );

  const fallbackRes = await callGeminiRest(FALLBACK_MODEL, contents, apiKey, thinkingLevel);

  if (fallbackRes.isNetworkSuccess && fallbackRes.statusCode === 200 && fallbackRes.data) {
    const extracted = extractCandidateText(fallbackRes.data);
    if (extracted.text) {
      console.log(`[DRSSS Failover] Failover successful with fallback model: ${FALLBACK_MODEL}`);
      res.json({
        reply: extracted.text,
        model_used: FALLBACK_MODEL,
        thinking_level: thinkingLevel,
        fallback_used: true
      });
      return;
    }
  }

  // Both primary and fallback failed
  const errorDetail =
    (fallbackRes.data && fallbackRes.data.error && fallbackRes.data.error.message) ||
    (primaryRes.data && primaryRes.data.error && primaryRes.data.error.message) ||
    `Upstream status ${fallbackRes.statusCode || primaryRes.statusCode}`;

  // Sanitize upstream errors so no third-party branding or keys leak
  const sanitizedError = errorDetail
    .replace(/google/gi, 'AI')
    .replace(/gemini/gi, 'DRSSS')
    .replace(/api[_-]?key=[a-zA-Z0-9_\-]+/gi, 'api_key=***');

  res.status(502).json({
    error: `Both primary and fallback models were unable to complete your request. Details: ${sanitizedError}`,
    model_attempted: `${selectedModel} -> ${FALLBACK_MODEL}`
  });
});

// 5. Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend')));

// Fallback to frontend index.html for SPA routing
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`==========================================================`);
  console.log(` DRSSS AI Full-Stack Server Running`);
  console.log(` Built by Shantanu, Diggaj, Raj, Suraj, and Sanika.`);
  console.log(` Local URL : http://localhost:${PORT}`);
  console.log(` Primary 1 : ${PRIMARY_DEFAULT_MODEL} (DRSSS 3.5 Flash Lite)`);
  console.log(` Primary 2 : ${ADVANCED_PRIMARY_MODEL} (DRSSS 3.6 Flash)`);
  console.log(` Fallback  : ${FALLBACK_MODEL} (DRSSS 3.1 Flash Lite)`);
  console.log(`==========================================================`);
});
