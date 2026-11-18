// store.ts — the forge's in-memory store.
//
// Deterministic: every stored value is a pure function of the request order.
// A logical clock (seconds from SCENARIO_EPOCH_SEC, +1 per mutation) stamps all
// server-created timestamps. No Date.now(), no Math.random() anywhere.

import { createHash } from 'node:crypto';
import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './gitutil.ts';

export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  shallow: Set<string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  version: number;
  /** Cached serializations, invalidated by bumping `version`. */
  cache: Map<string, { version: number; value: unknown }>;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
  comments: { id: number; body: string }[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  headRef: string;
  baseRef: string;
}

export interface GitRefsInput {
  ref: string;
  sha: string;
}


export class Store {
  repos: Map<string, Repo> = new Map();
  /** Global counters — deterministic because they only move on requests. */
  private clock = SCENARIO_EPOCH_SEC;
  private nextRepoId = 5000;
  private nextIssueId = 1_000_000;
  private commentCounter = 1;
  private nextPullId = 1_000_000;
  private requestIdCounter = 0;
  globalIds = new Map<string, string>();
  private idRegistry = new Map<string, { kind: 'repo' | 'issue' | 'pull' | 'comment'; key: string }>();

  /** Next logical timestamp (seconds), monotonically increasing. */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  now(): number {
    return this.clock;
  }

  nextRequestId(): string {
    this.requestIdCounter += 1;
    return `req-${this.requestIdCounter}`;
  }

  nextCommentId(): number {
    const id = this.commentCounter;
    this.commentCounter += 1;
    return id;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** An opaque, stable global id for `kind:key` (base64url of SHA-256 of a namespaced key). */
  globalId(kind: string, key: string): string {
    const full = `${kind}:${key}`;
    const existing = this.globalIds.get(full);
    if (existing) return existing;
    const id = createHash('sha256').update(full, 'utf8').digest().toString('base64url');
    this.globalIds.set(full, id);
    return id;
  }

  resolveGlobalId(id: string): { kind: string; key: string } | undefined {
    return this.idRegistry.get(id);
  }

  registerGlobalId(id: string, kind: 'repo' | 'issue' | 'pull' | 'comment', key: string): void {
    this.idRegistry.set(id, { kind, key });
  }

  /** Create a repo owned by the viewer (REST/MCP creation path). */
  createRepo(owner: string, name: string, description = '', isPrivate = false): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      shallow: new Set(),
      labels: new Map(),
      issues: [],
      pulls: [],
      version: 0,
      cache: new Map(),
    };
    this.repos.set(repo.fullName, repo);
    const gid = this.globalId('Repository', repo.fullName);
    this.registerGlobalId(gid, 'repo', repo.fullName);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }

  // -- git objects ---------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  storeObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: Buffer.from(object.data) });
    return oid;
  }

  /** Build a tree from a flat path -> {oid, mode} map, creating intermediate trees. */
  buildTreeFromPaths(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Set<string>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          subdirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of subdirs) {
        entries.push({ mode: '40000', name: dir, oid: buildDir(`${prefix}${dir}/`) });
      }
      const data = buildTree(entries);
      return this.storeObject(repo, { type: 'tree', data });
    };
    return buildDir('');
  }

  /** Flatten a tree into path -> {oid, mode} (gitlinks skipped). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Create a commit on `branch` of `repo` from a flat file map. */
  createCommit(
    repo: Repo,
    branch: string,
    message: string,
    files: Map<string, { oid: string; mode: string }>,
  ): string {
    const treeOid = this.buildTreeFromPaths(repo, files);
    const head = repo.refs.get(`refs/heads/${branch}`);
    const parents = head && isObjectId(head) ? [head] : [];
    const ts = this.tick();
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({ tree: treeOid, parents, message, author: who, committer: who, timestamp: ts });
    const oid = this.storeObject(repo, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.version += 1;
    repo.cache.clear();
    return oid;
  }

  /** The flat file map at a commit's tree (empty map when the commit is unknown). */
  filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  // -- merge-base / conflicts / diff ----------------------------------------

  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestors = new Set<string>();
    const walk = (oid: string): void => {
      const queue = [oid];
      while (queue.length) {
        const cur = queue.pop()!;
        if (ancestors.has(cur)) continue;
        ancestors.add(cur);
        const object = repo.objects.get(cur);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    };
    walk(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (ancestors.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const object = repo.objects.get(cur);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return undefined;
  }

  /** True when the two sides changed the same path differently relative to the base. */
  hasConflict(repo: Repo, baseOid: string | undefined, headOid: string, baseTipOid: string): boolean {
    if (!baseOid) {
      // No common ancestor: conflict only if both sides touch the same path.
      const headFiles = this.filesAt(repo, headOid);
      const baseFiles = this.filesAt(repo, baseTipOid);
      for (const path of headFiles.keys()) if (baseFiles.has(path)) return true;
      return false;
    }
    const baseFiles = this.filesAt(repo, baseOid);
    const headFiles = this.filesAt(repo, headOid);
    const baseTipFiles = this.filesAt(repo, baseTipOid);
    const all = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of all) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = baseTipFiles.get(path);
      const headChanged = (h?.oid ?? '') !== (b?.oid ?? '') || (h?.mode ?? '') !== (b?.mode ?? '');
      const baseChanged = (t?.oid ?? '') !== (b?.oid ?? '') || (t?.mode ?? '') !== (b?.mode ?? '');
      if (headChanged && baseChanged && (h?.oid ?? '') !== (t?.oid ?? '')) return true;
    }
    return false;
  }

  /** Three-way merge result files (head wins on non-conflicting changes). */
  mergeFiles(
    repo: Repo,
    baseOid: string | undefined,
    headOid: string,
    baseTipOid: string,
  ): Map<string, { oid: string; mode: string }> {
    const baseFiles = baseOid ? this.filesAt(repo, baseOid) : new Map<string, { oid: string; mode: string }>();
    const headFiles = this.filesAt(repo, headOid);
    const baseTipFiles = this.filesAt(repo, baseTipOid);
    const out = new Map<string, { oid: string; mode: string }>(baseTipFiles);
    const all = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of all) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const headChanged = (h?.oid ?? '') !== (b?.oid ?? '') || (h?.mode ?? '') !== (b?.mode ?? '');
      if (headChanged) {
        if (h) out.set(path, h);
        else out.delete(path);
      }
    }
    return out;
  }

  /** File diff between two commits: [{filename, status, additions, deletions, changes}]. */
  diffFiles(repo: Repo, baseOid: string, headOid: string): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const baseFiles = this.filesAt(repo, baseOid);
    const headFiles = this.filesAt(repo, headOid);
    const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
    const all = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...all].sort()) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (!b && h) {
        const lines = lineCount(repo, h.oid);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && !h) {
        const lines = lineCount(repo, b.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const bl = lineCount(repo, b.oid);
        const hl = lineCount(repo, h.oid);
        out.push({ filename: path, status: 'modified', additions: Math.max(0, hl - bl), deletions: Math.max(0, bl - hl), changes: Math.max(1, Math.abs(hl - bl)) });
      }
    }
    return out;
  }

  /** Squash-merge a pull request onto its base branch (shared by REST, GraphQL and MCP). */
  squashMerge(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pull.state === 'closed') return { ok: false, reason: `pull request ${pull.number} is already closed` };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return { ok: false, reason: 'head or base branch not found' };
    const mergeBase = this.mergeBase(repo, headTip, baseTip);
    if (this.hasConflict(repo, mergeBase, headTip, baseTip)) {
      return { ok: false, reason: 'merge conflict: head and base changed the same files differently' };
    }
    const files = this.mergeFiles(repo, mergeBase, headTip, baseTip);
    const mergeSha = this.createCommit(repo, pull.baseRef, `${pull.title} (#${pull.number})`, files);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(this.now() * 1000).toISOString();
    pull.mergeCommitSha = mergeSha;
    repo.version += 1;
    return { ok: true, sha: mergeSha };
  }

  // -- issues / pulls -------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: { name: string }[]): Issue {
    const number = repo.issues.length + 1;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
    };
    repo.issues.push(issue);
    repo.version += 1;
    const gid = this.globalId('Issue', `${repo.fullName}#${number}`);
    this.registerGlobalId(gid, 'issue', `${repo.fullName}#${number}`);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID;
    const number = repo.pulls.length + 1;
    const pull: Pull = {
      id: this.nextPullId++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      headRef,
      baseRef,
    };
    repo.pulls.push(pull);
    repo.version += 1;
    const gid = this.globalId('PullRequest', `${repo.fullName}#${number}`);
    this.registerGlobalId(gid, 'pull', `${repo.fullName}#${number}`);
    return pull;
  }

}

function lineCount(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (!object) return 0;
  const text = object.data.toString('utf8');
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}
