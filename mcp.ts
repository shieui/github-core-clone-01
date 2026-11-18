// mcp.ts — Model Context Protocol at POST /mcp: JSON-RPC 2.0 over Streamable HTTP
// (plain JSON answers), modern revision 2026-07-28 via server/discover plus the
// legacy initialize handshake as a fallback. Tools act on the same store as REST.
//
// Wire contract: auth is decided before any tool exists (no Authorization -> 401);
// a non-JSON body is HTTP 400 with JSON-RPC -32700; an unknown tool is -32601;
// a call missing required arguments answers isError:true; notifications (no id)
// answer 202 with an empty body. GET/DELETE on /mcp is 405 (app.ts).

import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER, type Issue, type Pull, type Repo, type Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

// ---------------------------------------------------------------------------
// tools (one frozen list; two tools/list calls answer it byte for byte)
// ---------------------------------------------------------------------------

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

export const MCP_TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: stringProp('The owner login; defaults to the authenticated user.'),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        full_name: stringProp('The full "owner/repo" name; an alternative to owner and repo.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        full_name: stringProp('The full "owner/repo" name; an alternative to owner and repo.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach (must already exist).' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        full_name: stringProp('The full "owner/repo" name; an alternative to owner and repo.'),
        state: stringProp('Filter by state: open, closed or all.'),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        full_name: stringProp('The full "owner/repo" name; an alternative to owner and repo.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        full_name: stringProp('The full "owner/repo" name; an alternative to owner and repo.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

const TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name as string));

// ---------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------

interface ToolOutcome {
  /** A tool result object, or a JSON-RPC error code when the call itself fails. */
  result?: Record<string, unknown>;
  rpcError?: { code: number; message: string };
}

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Split owner/repo out of the arguments (owner + repo, or a full_name). */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = args.full_name;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2);
    if (owner && repo) return { owner, repo };
  }
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner === 'string' && owner !== '' && typeof repo === 'string' && repo !== '') {
    return { owner, repo };
  }
  return null;
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const pair = ownerRepo(args);
  if (!pair) return null;
  if (pair.owner !== VIEWER.login) return null;
  return store.getRepo(pair.owner, pair.repo) ?? null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  if (!TOOL_NAMES.has(name)) {
    return { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  const missing = (required: string[]): string[] => required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  switch (name) {
    case 'create_repo': {
      const missingKeys = missing(['name']);
      if (missingKeys.length > 0) return { result: toolError(`Missing required argument(s): ${missingKeys.join(', ')}`) };
      const repoName = asString(args.name);
      const owner = asString(args.owner) || VIEWER.login;
      if (owner !== VIEWER.login) return { result: toolError(`cannot create a repository under ${owner}`) };
      if (store.getRepo(owner, repoName)) return { result: toolError(`Repository ${owner}/${repoName} already exists`) };
      const repo = store.createRepo(
        owner,
        repoName,
        asString(args.description),
        typeof args.private === 'boolean' ? args.private : false,
      );
      return { result: toolResult(repoJson(store, repo)) };
    }
    case 'get_repo': {
      const missingKeys = missing(['owner', 'repo']);
      if (missingKeys.length > 0 && !args.full_name) return { result: toolError(`Missing required argument(s): ${missingKeys.join(', ')}`) };
      const repo = resolveRepo(store, args);
      if (!repo) return { result: toolError('repository not found') };
      return { result: toolResult(repoJson(store, repo)) };
    }
    case 'create_issue': {
      const missingKeys = missing(['owner', 'repo', 'title']);
      if (missingKeys.length > 0 && !args.full_name) return { result: toolError(`Missing required argument(s): ${missingKeys.join(', ')}`) };
      const repo = resolveRepo(store, args);
      if (!repo) return { result: toolError('repository not found') };
      const title = asString(args.title);
      if (!title) return { result: toolError('Missing required argument(s): title') };
      const rawLabels = Array.isArray(args.labels) ? args.labels : [];
      const labels: { name: string }[] = [];
      for (const raw of rawLabels) {
        const labelName = typeof raw === 'string' ? raw : asString((raw as Record<string, unknown>).name);
        if (!repo.labels.has(labelName)) return { result: toolError(`label ${labelName} does not exist`) };
        labels.push({ name: labelName });
      }
      const issue: Issue = store.createIssue(repo, title, asString(args.body), labels);
      return { result: toolResult(issueJson(store, repo, issue)) };
    }
    case 'list_issues': {
      const missingKeys = missing(['owner', 'repo']);
      if (missingKeys.length > 0 && !args.full_name) return { result: toolError(`Missing required argument(s): ${missingKeys.join(', ')}`) };
      const repo = resolveRepo(store, args);
      if (!repo) return { result: toolError('repository not found') };
      const state = asString(args.state) || 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const payload = { issues: list.map((issue) => issueJson(store, repo, issue)) };
      return { result: toolResult(payload) };
    }
    case 'create_pull_request': {
      const missingKeys = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (missingKeys.length > 0 && !args.full_name) return { result: toolError(`Missing required argument(s): ${missingKeys.join(', ')}`) };
      const repo = resolveRepo(store, args);
      if (!repo) return { result: toolError('repository not found') };
      const head = asString(args.head);
      const base = asString(args.base);
      const title = asString(args.title);
      if (!head || !base || !title) {
        return { result: toolError(`Missing required argument(s): ${[!head && 'head', !base && 'base', !title && 'title'].filter(Boolean).join(', ')}`) };
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return { result: toolError(`head branch ${head} does not exist`) };
      if (!baseSha) return { result: toolError(`base branch ${base} does not exist`) };
      const duplicate = repo.pulls.find((pull) => pull.head.ref === head && pull.state === 'open');
      if (duplicate) return { result: toolError(`a pull request from ${head} is already open`) };
      const pull: Pull = store.createPull(repo, title, asString(args.body), head, base);
      return { result: toolResult(pullJson(store, repo, pull)) };
    }
    case 'merge_pull_request': {
      const missingKeys = missing(['owner', 'repo', 'pull_number']);
      if (missingKeys.length > 0 && !args.full_name) return { result: toolError(`Missing required argument(s): ${missingKeys.join(', ')}`) };
      const repo = resolveRepo(store, args);
      if (!repo) return { result: toolError('repository not found') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(asString(args.pull_number), 10);
      if (!Number.isInteger(number)) return { result: toolError('Missing required argument(s): pull_number') };
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return { result: toolError(`pull request ${number} not found`) };
      const merged = store.squashMerge(repo, pull);
      if (!merged.ok) return { result: toolError(merged.reason) };
      return { result: toolResult({ number: pull.number, merged: true, sha: merged.sha, state: 'closed', ...pullJson(store, repo, pull) }) };
    }
    default:
      return { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle one JSON-RPC request object. Returns {status, body}. */
function handleOne(store: Store, request: unknown): { status: number; body: string } {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const record = request as Record<string, unknown>;
  const id = record.id;
  const method = record.method;
  // A notification (no id) is answered 202 with an empty body.
  if (id === undefined || id === null) {
    return { status: 202, body: '' };
  }
  if (typeof method !== 'string') {
    return { status: 400, body: rpcError(id, -32600, 'Invalid Request') };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      }),
    };
  }
  if (method === 'initialize') {
    const params = (record.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      }),
    };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
  }
  if (method === 'tools/call') {
    const params = (record.params ?? {}) as Record<string, unknown>;
    const toolName = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: rpcError(id, -32602, 'tools/call needs a tool name') };
    }
    const outcome = callTool(store, toolName, args);
    if (outcome.rpcError) {
      return { status: 200, body: rpcError(id, outcome.rpcError.code, outcome.rpcError.message) };
    }
    return { status: 200, body: rpcResult(id, outcome.result) };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/**
 * Handle a POST /mcp body. `authorized` is false when the request carries no (or
 * a wrong) Bearer token: auth is decided before any tool exists, so the answer is
 * 401 either way. Returns {status, body} with an application/json body (or '' for 202).
 */
export function handleMcp(store: Store, bodyText: string, authorized: boolean): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (!authorized) {
    const id = !Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).id ?? null : null;
    return { status: 401, body: rpcError(id, -32000, 'Unauthorized') };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => {
      const one = handleOne(store, entry);
      return one.body === '' ? null : JSON.parse(one.body);
    }).filter((entry) => entry !== null);
    return { status: 200, body: JSON.stringify(answers) };
  }
  return handleOne(store, parsed);
}
