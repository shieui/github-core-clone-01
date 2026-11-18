// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP,
// all on one node:http server with a single in-memory Store.
//
// Routing:
//   GET  /healthz                                  200 {"ok":true}, no auth
//   /{owner}/{repo}.git/info/refs?service=...     git advertisements (auth)
//   POST /{owner}/{repo}.git/git-upload-pack       v2 ls-refs / fetch, v0 fetch (auth)
//   POST /{owner}/{repo}.git/git-receive-pack      v0 push (auth)
//   /api/v3/...                                    REST v3 (auth, JSON, X-GitHub-Request-Id)
//   POST /api/graphql                              GraphQL v4 (auth)
//   POST /mcp                                      MCP JSON-RPC (auth); GET/DELETE -> 405
//   anything else                                  404 JSON
//
// Auth: a Bearer token must equal MAKEFUN_SHOP_TOKEN when that env var is set;
// when it is unset, any non-empty Bearer passes, but a missing header is still 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  advertiseV0Receive,
  advertiseV0Upload,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  V2_ADVERTISEMENT,
} from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { RestApi, type RestRequest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Whether the request's Bearer token is the entry's token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected && expected !== '') return token === expected;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const rest = new RestApi(store);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    // Keep-alive friendly: a generous keep-alive window for the read workload's
    // single connection, and no per-request server-side work beyond the handler.
    res.setHeader('connection', 'keep-alive');

    void (async () => {
      try {
        // -- health probe: no auth -------------------------------------------------
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // -- git smart HTTP --------------------------------------------------------
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const tail = gitMatch[3] ?? '';
          await handleGit(req, res, store, owner, repoName, tail, method);
          return;
        }

        // -- MCP -------------------------------------------------------------------
        if (path === '/mcp') {
          if (method === 'GET' || method === 'DELETE') {
            res.writeHead(405, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ message: 'Method Not Allowed' }));
            return;
          }
          if (method !== 'POST') {
            res.writeHead(405, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ message: 'Method Not Allowed' }));
            return;
          }
          const body = await readBody(req);
          const outcome = handleMcp(store, body.toString('utf8'), authorized(req));
          if (outcome.body === '') {
            res.writeHead(outcome.status);
            res.end();
            return;
          }
          sendBuffer(res, outcome.status, Buffer.from(outcome.body, 'utf8'), JSON_TYPE);
          return;
        }

        // -- GraphQL ---------------------------------------------------------------
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
          const body = await readBody(req);
          const answer = handleGraphQL(store, body.toString('utf8'));
          sendJson(res, 200, answer);
          return;
        }

        // -- REST v3 ---------------------------------------------------------------
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Unauthorized' }, { 'x-github-request-id': store.nextRequestId() });
            return;
          }
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const requestId = store.nextRequestId();
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
          // The contents route's path keeps its slashes: everything after
          // /api/v3/repos/{owner}/{repo}/contents/ is one path.
          let contentsPath: string | null = null;
          const contentsIndex = segments.indexOf('contents');
          if (segments[0] === 'repos' && contentsIndex === 3) {
            contentsPath = segments.slice(4).join('/');
          }
          const request: RestRequest = {
            method,
            segments,
            contentsPath,
            query: queryOf(req),
            body,
            origin: `http://${req.headers.host ?? '127.0.0.1'}`,
          };
          const answer = rest.handle(request);
          if (answer.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, {
            'x-github-request-id': requestId,
            ...(answer.headers ?? {}),
          });
          return;
        }

        // -- everything else -------------------------------------------------------
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never crash the server or hang the connection.
        try {
          sendJson(res, 500, { message: `Internal Server Error: ${(err as Error).message}` });
        } catch {
          try {
            res.end();
          } catch {
            // The socket is already gone.
          }
        }
      }
    })();
  });
}

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  tail: string,
  method: string,
): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const query = queryOf(req);

  // GET /info/refs?service=git-upload-pack | git-receive-pack
  if (method === 'GET' && tail === '/info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (wantsV2) {
        sendBuffer(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, advertiseV0Upload(repo), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, advertiseV0Receive(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: `unknown service ${service ?? ''}` });
    return;
  }

  // POST /git-upload-pack (v2 ls-refs / fetch, or v0 fetch)
  if (method === 'POST' && tail === '/git-upload-pack') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      const out = isV2 ? handleLsRefsOrFetch(repo, body) : handleFetchV0(repo, body);
      sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
    } catch (err) {
      // A malformed pkt-line body must not crash the server: 400, and the repo survives.
      sendBuffer(res, 400, Buffer.from((err as Error).message, 'utf8'), 'text/plain; charset=utf-8');
    }
    return;
  }

  // POST /git-receive-pack (v0 push)
  if (method === 'POST' && tail === '/git-receive-pack') {
    const body = await readBody(req);
    const outcome = handleReceivePack(repo, body);
    sendBuffer(res, outcome.status, outcome.body, 'application/x-git-receive-pack-result');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** A v2 upload-pack POST is ls-refs or fetch, told apart by its first command line. */
function handleLsRefsOrFetch(repo: Parameters<typeof handleLsRefs>[0], body: Buffer): Buffer {
  const text = body.subarray(0, Math.min(body.length, 64)).toString('utf8');
  if (text.includes('command=ls-refs')) return handleLsRefs(repo, body);
  if (text.includes('command=fetch')) return handleFetchV2(repo, body);
  throw new Error('unsupported v2 command');
}
