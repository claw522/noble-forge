// mcp.ts — the Model Context Protocol endpoint (POST /mcp, streamable HTTP, plain
// JSON answers): server/discover for the current revision, the legacy initialize
// handshake, tools/list and tools/call over the same store the REST surface serves.

import { HttpError, VIEWER, type RepoRec, type Store } from './core.ts';
import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './domain.ts';

const SERVER_INFO = { name: 'noble-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([key, text]) => [key, { type: key === 'private' ? 'boolean' : key === 'pull_number' ? 'number' : 'string', description: text }])),
      required,
    },
  };
}

/** The tool list: a constant, so two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a repository owned by the authenticated user', { name: 'Repository name', description: 'Repository description', private: 'Whether the repository is private' }, ['name']),
  tool('get_repo', 'Read one repository by owner and name', { owner: 'Repository owner login', repo: 'Repository name' }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository', { owner: 'Repository owner login', repo: 'Repository name', title: 'Issue title', body: 'Issue body' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository', { owner: 'Repository owner login', repo: 'Repository name', state: 'Issue state filter: open, closed or all' }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch', { owner: 'Repository owner login', repo: 'Repository name', title: 'Pull request title', body: 'Pull request body', head: 'Head branch', base: 'Base branch' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge an open pull request', { owner: 'Repository owner login', repo: 'Repository name', pull_number: 'Pull request number' }, ['owner', 'repo', 'pull_number']),
];

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpReply {
  status: number;
  body?: unknown;
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function requireToolRepo(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  const repo = store.getRepo(owner, name);
  if (repo === null) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const definition = TOOLS.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new RpcError(-32602, `unknown tool: ${name}`);
  for (const required of definition.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw new RpcError(-32602, `missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const existing = store.getRepo(VIEWER.login, repoName);
        if (existing !== null) return toolResult(repoJson(existing));
        const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(requireToolRepo(store, args)));
      }
      case 'create_issue': {
        const repo = requireToolRepo(store, args);
        const issue = createIssue(store, repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '' });
        return toolResult(issueJson(store, repo, issue));
      }
      case 'list_issues': {
        const repo = requireToolRepo(store, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.items.values()]
          .filter((item) => item.kind === 'issue')
          .filter((item) => state === 'all' || item.state === state)
          .map((item) => issueJson(store, repo, item));
        return toolResult({ repository: `${repo.owner}/${repo.name}`, issues });
      }
      case 'create_pull_request': {
        const repo = requireToolRepo(store, args);
        const pull = createPull(store, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolResult(pullJson(store, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = requireToolRepo(store, args);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
        const item = repo.items.get(number);
        if (item === undefined || item.kind !== 'pull') throw new Error(`pull request #${number} not found`);
        mergePull(store, repo, item, 'merge');
        return toolResult(pullJson(store, repo, item));
      }
      default:
        throw new RpcError(-32602, `unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof HttpError) return toolFailure(error.message);
    return toolFailure(error instanceof Error ? error.message : String(error));
  }
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function handleOne(store: Store, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;
  try {
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ? params.protocolVersion : '2025-11-25';
        return rpcResult(id, { protocolVersion: requested, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
      }
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        return rpcResult(id, callTool(store, name, args));
      }
      case 'ping':
        return rpcResult(id, {});
      default:
        if (isNotification) return null;
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  } catch (error) {
    if (isNotification) return null;
    if (error instanceof RpcError) return rpcError(id, error.code, error.message);
    return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

/** Handle one POST /mcp body. Auth is app.ts's job (401 before this runs). */
export function handleMCP(store: Store, rawText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => handleOne(store, entry as JsonRpcRequest))
      .filter((entry) => entry !== null);
    return { status: 200, body: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const answer = handleOne(store, parsed as JsonRpcRequest);
  if (answer === null) return { status: 202 };
  return { status: 200, body: answer };
}
