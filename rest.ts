// rest.ts — GitHub REST v3 under /api/v3.
//
// Every reply is application/json and carries X-GitHub-Request-Id (set by app.ts).
// Errors are JSON with a string `message`. Auth: a Bearer token must match
// MAKEFUN_SHOP_TOKEN when that env var is set; a missing or wrong token is 401.
// A repo under another owner is 404, never 403.

import { isObjectId, parseCommit, parseTree, ZERO_OID } from './gitutil.ts';
import {
  DEFAULT_BRANCH,
  SCENARIO_EPOCH_SEC,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (e.g. ['repos', owner, name, 'issues']). */
  segments: string[];
  /** The raw remainder after /api/v3/repos/{owner}/{repo}/contents/ (may contain '/'), or null. */
  contentsPath: string | null;
  query: URLSearchParams;
  /** Raw request body bytes (empty when none). */
  body: Buffer;
  /** Absolute origin (scheme://host:port) for Link headers. */
  origin: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({
  status,
  body,
  headers,
});

const err = (status: number, message: string): RestResponse => json(status, { message });

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/** Parse a JSON body; on failure returns an error response. */
function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(req.body.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, response: err(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: err(400, 'request body is not valid JSON') };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    created_at: iso(SCENARIO_EPOCH_SEC),
    updated_at: iso(store.now()),
    pushed_at: iso(store.now()),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => {
      const created = repo.labels.get(label.name);
      return { name: label.name, color: created?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: iso(SCENARIO_EPOCH_SEC),
    updated_at: iso(store.now()),
    closed_at: issue.state === 'closed' ? iso(store.now()) : null,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    mergeable: true,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${repo.owner}:${pull.head.ref}`,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(store, repo),
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${repo.owner}:${pull.base.ref}`,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(store, repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: iso(SCENARIO_EPOCH_SEC),
    updated_at: iso(store.now()),
    closed_at: pull.state === 'closed' ? iso(store.now()) : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    draft: false,
    locked: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum: page, perPage };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, total: number, pageNum: number, perPage: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= lastPage) return null;
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(perPage));
    return `${origin}${path}?${q.toString()}`;
  };
  return `<${build(pageNum + 1)}>; rel="next", <${build(lastPage)}>; rel="last"`;
}

/** Resolve a repo from the path; a foreign owner or a missing repo is a 404. */
function resolveRepo(store: Store, owner: string, name: string): { ok: true; repo: Repo } | { ok: false; response: RestResponse } {
  if (owner !== VIEWER.login) return { ok: false, response: err(404, `repository ${owner}/${name} not found`) };
  const repo = store.getRepo(owner, name);
  if (!repo) return { ok: false, response: err(404, `repository ${owner}/${name} not found`) };
  return { ok: true, repo };
}

/** Resolve a branch name or commit sha to a commit oid, or null. */
function resolveRefTarget(repo: Repo, ref: string): string | null {
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** The commit history from a tip, newest first (full walk, parents in order). */
function commitHistory(repo: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
    out.push({ sha: oid, message });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export class RestApi {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  handle(req: RestRequest): RestResponse {
    const [head, ...rest] = req.segments;
    if (head === undefined || head === '') {
      if (req.method === 'GET') {
        return json(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
      }
      return err(404, 'not found');
    }
    switch (head) {
      case 'meta':
        return req.method === 'GET'
          ? json(200, { installed_version: '1.0.0', version: '1.0.0' })
          : err(404, 'not found');
      case 'user':
        return this.user(req, rest);
      case 'repos':
        return this.repos(req, rest);
      default:
        return err(404, `unknown route /api/v3/${head}`);
    }
  }

  private user(req: RestRequest, rest: string[]): RestResponse {
    if (rest.length === 0) {
      if (req.method !== 'GET') return err(404, 'not found');
      return json(200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        html_url: `https://github.com/${VIEWER.login}`,
        url: '/api/v3/user',
      });
    }
    if (rest[0] === 'repos') {
      if (req.method === 'GET') return this.listUserRepos(req);
      if (req.method === 'POST') return this.createRepo(req);
      return err(404, 'not found');
    }
    return err(404, 'not found');
  }

  private listUserRepos(req: RestRequest): RestResponse {
    const repos = [...this.store.repos.values()]
      .filter((repo) => repo.owner === VIEWER.login)
      .sort((a, b) => a.id - b.id);
    const { page, total, pageNum, perPage } = paginate(repos, req.query);
    const headers: Record<string, string> = {};
    const link = linkHeader(req.origin, '/api/v3/user/repos', req.query, total, pageNum, perPage);
    if (link) headers.Link = link;
    return json(200, page.map((repo) => repoJson(this.store, repo)), headers);
  }

  private createRepo(req: RestRequest): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const name = asString(body.name);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      return err(422, 'name is required and must be a valid repository name');
    }
    if (this.store.getRepo(VIEWER.login, name)) {
      return err(422, `Repository ${VIEWER.login}/${name} already exists`);
    }
    const repo = this.store.createRepo(
      VIEWER.login,
      name,
      asString(body.description),
      asBool(body.private, false),
    );
    return json(201, repoJson(this.store, repo));
  }

  private repos(req: RestRequest, rest: string[]): RestResponse {
    const [owner, name, ...tail] = rest;
    if (!owner || !name) return err(404, 'not found');
    const resolved = resolveRepo(this.store, owner, name);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.repo;
    if (tail.length === 0) {
      if (req.method === 'GET') return json(200, repoJson(this.store, repo));
      if (req.method === 'PATCH') return this.patchRepo(req, repo);
      if (req.method === 'DELETE') {
        this.store.deleteRepo(repo);
        return { status: 204, body: null };
      }
      return err(404, 'not found');
    }
    const [section, ...sub] = tail;
    switch (section) {
      case 'git':
        return this.gitRefs(req, repo, sub);
      case 'branches':
        return this.branches(req, repo, sub);
      case 'commits':
        if (req.method === 'GET' && sub.length === 0) return this.listCommits(req, repo);
        return err(404, 'not found');
      case 'contents':
        return this.contents(req, repo, sub);
      case 'labels':
        return this.labels(req, repo, sub);
      case 'issues':
        return this.issues(req, repo, sub);
      case 'pulls':
        return this.pulls(req, repo, sub);
      default:
        return err(404, 'not found');
    }
  }

  private patchRepo(req: RestRequest, repo: Repo): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    repo.version += 1;
    return json(200, repoJson(this.store, repo));
  }

  private gitRefs(req: RestRequest, repo: Repo, sub: string[]): RestResponse {
    if (sub[0] !== 'refs') return err(404, 'not found');
    if (req.method === 'POST' && sub.length === 1) {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/') || !isObjectId(sha)) {
        return err(422, 'ref and sha are required');
      }
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      if (!repo.objects.has(sha)) return err(422, `Object ${sha} does not exist`);
      repo.refs.set(ref, sha);
      repo.version += 1;
      repo.cache.clear();
      return json(201, { ref, object: { sha, type: 'commit', url: '' } });
    }
    if (req.method === 'GET' && sub.length >= 2) {
      const ref = sub.join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, `reference ${ref} not found`);
      return json(200, { ref, object: { sha, type: 'commit', url: '' } });
    }
    return err(404, 'not found');
  }

  private branches(req: RestRequest, repo: Repo, sub: string[]): RestResponse {
    if (req.method !== 'GET') return err(404, 'not found');
    const list = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha, url: '' } }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (sub.length === 0) return json(200, list);
    const branch = sub.join('/');
    const found = list.find((entry) => entry.name === branch);
    if (!found) return err(404, `branch ${branch} not found`);
    return json(200, found);
  }

  private listCommits(req: RestRequest, repo: Repo): RestResponse {
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRefTarget(repo, ref);
    if (!tip) return err(404, `reference ${ref} not found`);
    const history = commitHistory(repo, tip);
    const { page } = paginate(history, req.query);
    return json(
      200,
      page.map((entry) => ({
        sha: entry.sha,
        commit: { message: entry.message },
        author: { login: VIEWER.login, id: VIEWER.id },
        committer: { login: VIEWER.login, id: VIEWER.id },
      })),
    );
  }

  private contents(req: RestRequest, repo: Repo, sub: string[]): RestResponse {
    const path = req.contentsPath ?? sub.join('/');
    if (req.method === 'PUT') return this.putContents(req, repo, path);
    if (req.method === 'DELETE') return this.deleteContents(req, repo, path);
    if (req.method === 'GET') return this.getContents(req, repo, path);
    return err(404, 'not found');
  }

  private getContents(req: RestRequest, repo: Repo, path: string): RestResponse {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRefTarget(repo, ref);
    if (!tip) return err(404, `reference ${ref} not found`);
    const files = this.store.filesAt(repo, tip);
    if (path === '') {
      // Root listing: immediate children.
      const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [filePath, file] of files) {
        const slash = filePath.indexOf('/');
        if (slash < 0) {
          entries.set(filePath, { type: 'file', name: filePath, path: filePath, sha: file.oid });
        } else {
          const dir = filePath.slice(0, slash);
          if (!entries.has(dir)) {
            entries.set(dir, { type: 'dir', name: dir, path: dir, sha: this.dirSha(repo, tip, dir) });
          }
        }
      }
      return json(200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    }
    const file = files.get(path);
    if (file) {
      const object = repo.objects.get(file.oid);
      const data = object?.data ?? Buffer.alloc(0);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: file.oid,
      });
    }
    // Directory listing: immediate children of `path/`.
    const prefix = `${path}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.set(rest, { type: 'file', name: rest, path: filePath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!entries.has(dir)) {
          entries.set(dir, { type: 'dir', name: dir, path: `${path}/${dir}`, sha: this.dirSha(repo, tip, `${path}/${dir}`) });
        }
      }
    }
    if (entries.size === 0) return err(404, `path ${path} not found`);
    return json(200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  }

  /** The tree oid of a directory inside a commit's tree (empty-tree oid when absent). */
  private dirSha(repo: Repo, tip: string, dirPath: string): string {
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return EMPTY_TREE;
    let treeOid = parseCommit(object.data).tree;
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return EMPTY_TREE;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return EMPTY_TREE;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  private putContents(req: RestRequest, repo: Repo, path: string): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = asString(body.message);
    const contentB64 = asString(body.content);
    if (!message || !contentB64) return err(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(400, 'content is not valid base64');
    }
    const branch = asString(body.branch) || repo.defaultBranch;
    const sha = asString(body.sha);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const files = tip ? this.store.filesAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const current = files.get(path);
    if (sha) {
      if (!current || current.oid !== sha) return err(409, `sha ${sha} does not match the current blob`);
    } else if (current) {
      return err(409, `file ${path} already exists; pass its sha to update it`);
    }
    const blobOid = this.store.storeObject(repo, { type: 'blob', data: content });
    const next = new Map(files);
    next.set(path, { oid: blobOid, mode: '100644' });
    const commitSha = this.store.createCommit(repo, branch, message, next);
    return json(current ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }

  private deleteContents(req: RestRequest, repo: Repo, path: string): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = asString(body.message) || 'delete file';
    const sha = asString(body.sha);
    const branch = asString(body.branch) || repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return err(404, `branch ${branch} not found`);
    const files = this.store.filesAt(repo, tip);
    const current = files.get(path);
    if (!current) return err(404, `path ${path} not found`);
    if (sha && current.oid !== sha) return err(409, `sha ${sha} does not match the current blob`);
    const next = new Map(files);
    next.delete(path);
    const commitSha = this.store.createCommit(repo, branch, message, next);
    return json(200, { commit: { sha: commitSha } });
  }

  private labels(req: RestRequest, repo: Repo, sub: string[]): RestResponse {
    if (req.method === 'GET' && sub.length === 0) {
      return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (req.method === 'POST' && sub.length === 0) {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const name = asString(body.name);
      if (!name) return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, `label ${name} already exists`);
      const color = asString(body.color) || 'ededed';
      repo.labels.set(name, { name, color });
      repo.version += 1;
      return json(201, { name, color, description: '' });
    }
    return err(404, 'not found');
  }

  private issues(req: RestRequest, repo: Repo, sub: string[]): RestResponse {
    const [first, second] = sub;
    if (first === undefined) {
      if (req.method === 'GET') return this.listIssues(req, repo);
      if (req.method === 'POST') return this.createIssue(req, repo);
      return err(404, 'not found');
    }
    const number = parseInt(first, 10);
    if (!Number.isInteger(number)) return err(404, 'not found');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) return err(404, `issue ${number} not found`);
    if (second === undefined) {
      if (req.method === 'GET') return json(200, issueJson(this.store, repo, issue));
      if (req.method === 'PATCH') return this.patchIssue(req, repo, issue);
      return err(404, 'not found');
    }
    if (second === 'comments') {
      if (req.method === 'GET') {
        return json(
          200,
          issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } })),
        );
      }
      if (req.method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const commentBody = asString(parsed.value.body);
        if (!commentBody) return err(422, 'body is required');
        const comment = { id: this.store.nextCommentId(), body: commentBody };
        issue.comments.push(comment);
        repo.version += 1;
        return json(201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } });
      }
      return err(404, 'not found');
    }
    return err(404, 'not found');
  }

  private listIssues(req: RestRequest, repo: Repo): RestResponse {
    const state = req.query.get('state') ?? 'open';
    const direction = req.query.get('direction') ?? 'desc';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const { page } = paginate(list, req.query);
    return json(200, page.map((issue) => issueJson(this.store, repo, issue)));
  }

  private createIssue(req: RestRequest, repo: Repo): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const title = asString(body.title);
    if (!title) return err(422, 'title is required');
    const rawLabels = Array.isArray(body.labels) ? body.labels : [];
    const labels: { name: string }[] = [];
    for (const raw of rawLabels) {
      const name = typeof raw === 'string' ? raw : asString((raw as Record<string, unknown>).name);
      if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
      labels.push({ name });
    }
    const issue = this.store.createIssue(repo, title, asString(body.body), labels);
    return json(201, issueJson(this.store, repo, issue));
  }

  private patchIssue(req: RestRequest, repo: Repo, issue: Issue): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const state = asString(parsed.value.state);
    if (state === 'open' || state === 'closed') {
      issue.state = state;
      repo.version += 1;
    } else if (state !== '') {
      return err(422, `state must be open or closed`);
    }
    if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
    if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
    return json(200, issueJson(this.store, repo, issue));
  }

  private pulls(req: RestRequest, repo: Repo, sub: string[]): RestResponse {
    const [first, second] = sub;
    if (first === undefined) {
      if (req.method === 'GET') return this.listPulls(req, repo);
      if (req.method === 'POST') return this.createPull(req, repo);
      return err(404, 'not found');
    }
    const number = parseInt(first, 10);
    if (!Number.isInteger(number)) return err(404, 'not found');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return err(404, `pull request ${number} not found`);
    if (second === undefined) {
      if (req.method === 'GET') return json(200, pullJson(this.store, repo, pull));
      return err(404, 'not found');
    }
    if (second === 'files' && req.method === 'GET') {
      const baseOid = this.store.mergeBase(repo, pull.head.sha, pull.base.sha);
      const files = this.store.diffFiles(repo, baseOid ?? ZERO_OID, pull.head.sha);
      return json(200, files);
    }
    if (second === 'merge' && req.method === 'PUT') return this.mergePull(req, repo, pull);
    return err(404, 'not found');
  }

  private listPulls(req: RestRequest, repo: Repo): RestResponse {
    const state = req.query.get('state') ?? 'open';
    const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    const { page } = paginate(list, req.query);
    return json(200, page.map((pull) => pullJson(this.store, repo, pull)));
  }

  private createPull(req: RestRequest, repo: Repo): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const head = asString(body.head);
    const base = asString(body.base);
    const title = asString(body.title);
    if (!head || !base || !title) return err(422, 'head, base and title are required');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha) return err(422, `head branch ${head} does not exist`);
    if (!baseSha) return err(422, `base branch ${base} does not exist`);
    const duplicate = repo.pulls.find((pull) => pull.head.ref === head && pull.state === 'open');
    if (duplicate) return err(422, `a pull request from ${head} is already open`);
    const pull = this.store.createPull(repo, title, asString(body.body), head, base);
    return json(201, pullJson(this.store, repo, pull));
  }

  private mergePull(req: RestRequest, repo: Repo, pull: Pull): RestResponse {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    if (pull.state === 'closed') return err(405, `pull request ${pull.number} is already ${pull.merged ? 'merged' : 'closed'}`);
    const result = this.store.squashMerge(repo, pull);
    if (!result.ok) {
      if (result.reason === 'head or base branch not found') return err(404, result.reason);
      return err(405, result.reason);
    }
    return json(200, { sha: result.sha, merged: true, message: `${pull.title} (#${pull.number})` });
  }
}

export { ZERO_OID, repoJson, issueJson, pullJson };
