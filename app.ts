// app.ts — noble-forge's HTTP server: the env's health probe, the REST v3 surface,
// GraphQL v4, the MCP endpoint and git smart HTTP, all over one in-memory store.
// main.ts owns the entry<->env lifecycle; this file is the whole forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './core.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, sendJson } from './gitproto.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestSeq = 0;

/** Every API reply carries a non-empty request id, as GitHub's does. */
function nextRequestId(): string {
  requestSeq += 1;
  return `noble-forge-${requestSeq}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || presented === expected;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendRest(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': text.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  // The env's boot probe: no token, called twice, wants 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendRest(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const name = decodeURIComponent(gitMatch[2]!);
    const repo = store.getRepo(owner, name);
    const rest = gitMatch[3]!;
    if (rest === 'info/refs' && method === 'GET') {
      handleInfoRefs(req, res, store, repo, url.searchParams.get('service'));
      return;
    }
    if (rest === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      handleUploadPack(res, store, repo, body, version2);
      return;
    }
    if (rest === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(res, store, repo, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // The API surfaces all require the bearer token.
  const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';
  if (!isApi) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req)) {
    sendRest(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendRest(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const reply = handleGraphQL(store, raw);
    sendRest(res, reply.status, reply.body);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendRest(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const reply = handleMCP(store, raw);
    if (reply.body === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendRest(res, reply.status, reply.body);
    return;
  }

  // REST v3.
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  let body: Record<string, unknown> | undefined;
  if (rawBody.length > 0) {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body is not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      sendRest(res, 400, { message: 'Invalid JSON body' });
      return;
    }
  }
  const segments = path
    .slice('/api/v3'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  const request: RestRequest = { method, segments, query: url.searchParams, body, host: req.headers.host ?? '127.0.0.1' };
  const reply = handleRest(store, request);
  sendRest(res, reply.status, reply.body, { 'x-oauth-scopes': 'repo, read:org', ...(reply.headers ?? {}) });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((error: unknown) => {
      process.stderr.write(`[entry] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Error' });
      else res.end();
    });
  });
}
