// gitproto.ts — git smart HTTP: protocol v2 upload-pack (ls-refs, fetch) and
// v0 receive-pack (push), plus v0/v2 ref advertisements.
//
// All responses are built from the store; nothing here reads the wall clock or
// randomness. Fetch responses are cached per (repo version, request key) so the
// clone workload's 50 identical shallow fetches share one pack.

import {
  collectReachable,
  commitDistances,
  decodePktLines,
  emptyPack,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseTag,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitutil.ts';
import { DEFAULT_BRANCH, VIEWER, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  /** The commit a tag ref peels to (undefined when the ref is not an annotated tag). */
  peeled?: string;
}

/** All refs of a repo, HEAD first, then sorted; tag refs carry their peeled commit. */
export function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  lines.push({ name: 'HEAD', oid: mainTip ?? ZERO_OID });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        let target = parseTag(object.data).object;
        let guard = 0;
        while (guard++ < 10) {
          const next = repo.objects.get(target);
          if (!next || next.type !== 'tag') break;
          target = parseTag(next.data).object;
        }
        line.peeled = target;
      }
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const V2_CAPS = ['version 2\n', 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n'] as const;

/** The v2 capability advertisement: constant for every repo. */
export const V2_ADVERTISEMENT: Buffer = encodePktLines([...V2_CAPS, 'flush']);

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta shallow`;
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** v0 ref advertisement for upload-pack (with the # service= preamble). */
export function advertiseV0Upload(repo: Repo): Buffer {
  const cacheKey = `adv-v0-upload:${repo.version}`;
  const cached = repo.cache.get(cacheKey);
  if (cached) return cached.value as Buffer;
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${UPLOAD_V0_CAPS}\n`));
  } else {
    const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
    parts.push(pktLine(`${mainTip} HEAD\u0000${UPLOAD_V0_CAPS}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  const out = Buffer.concat(parts);
  repo.cache.set(cacheKey, { version: repo.version, value: out });
  return out;
}

/** v0 ref advertisement for receive-pack (with the # service= preamble). */
export function advertiseV0Receive(repo: Repo): Buffer {
  const cacheKey = `adv-v0-receive:${repo.version}`;
  const cached = repo.cache.get(cacheKey);
  if (cached) return cached.value as Buffer;
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), Buffer.from('0000', 'ascii')];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_V0_CAPS}\n`));
  } else {
    const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
    parts.push(pktLine(`${mainTip} HEAD\u0000${RECEIVE_V0_CAPS}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  const out = Buffer.concat(parts);
  repo.cache.set(cacheKey, { version: repo.version, value: out });
  return out;
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  let command = '';
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  if (command !== 'ls-refs') throw new Error(`unsupported v2 command ${JSON.stringify(command)}`);
  const cacheKey = `ls-refs:${repo.version}:${peel ? 1 : 0}:${symrefs ? 1 : 0}:${prefixes.join('|')}`;
  const cached = repo.cache.get(cacheKey);
  if (cached) return cached.value as Buffer;
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const out = encodePktLines([...lines, 'flush']);
  repo.cache.set(cacheKey, { version: repo.version, value: out });
  return out;
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0 share the send-set computation)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchRequest(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) request.depth = n;
    }
  }
  if (command !== 'fetch') throw new Error(`unsupported v2 command ${JSON.stringify(command)}`);
  return request;
}

/** The objects a fetch must send, plus the shallow-info bookkeeping. */
function computeSend(
  repo: Repo,
  request: FetchRequest,
): { send: Map<string, GitObject>; newShallow: string[]; unshallow: string[]; common: string | null } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const dist = commitDistances(request.wants, lookup);
  const shallowSet = new Set(request.shallow);
  // Held: reachable from haves, stopping at the client's shallow boundaries.
  const held = collectReachable(request.haves, lookup, { stopAt: shallowSet, allowMissing: true });
  // Common: the first have (in request order) reachable from a want.
  const reachableFromWants = collectReachable(request.wants, lookup, { allowMissing: true });
  let common: string | null = null;
  for (const have of request.haves) {
    if (reachableFromWants.has(have)) {
      common = have;
      break;
    }
  }
  // Send: objects reachable from wants within the depth, minus held.
  const send = new Map<string, GitObject>();
  const includeObject = (oid: string): void => {
    if (held.has(oid) || send.has(oid)) return;
    const object = lookup(oid);
    if (object) send.set(oid, object);
  };
  const newShallow: string[] = [];
  for (const want of request.wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      includeObject(want);
      const target = parseTag(object.data).object;
      const targetObj = lookup(target);
      if (targetObj?.type === 'commit') {
        const d = dist.get(target);
        if (d !== undefined && (request.depth === null || d <= request.depth - 1)) {
          includeCommit(target, d);
        }
      } else if (targetObj) {
        includeObject(target);
      }
      continue;
    }
    if (object.type === 'commit') {
      const d = dist.get(want);
      if (d !== undefined && (request.depth === null || d <= request.depth - 1)) includeCommit(want, d);
      continue;
    }
    includeObject(want);
  }
  function includeCommit(oid: string, d: number): void {
    if (request.depth !== null && d === request.depth - 1) newShallow.push(oid);
    includeObject(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') return;
    // Tree + blobs of this commit (reachable from its tree).
    const treeOid = parseCommitShim(object.data).tree;
    for (const reachable of collectReachable([treeOid], lookup, { allowMissing: true })) includeObject(reachable);
  }
  // Any commit within depth whose tree/blobs were not yet included: walk the distance map.
  if (request.depth !== null) {
    for (const [oid, d] of dist) {
      if (d > request.depth - 1 || d === 0) continue;
      if (send.has(oid)) continue;
      includeCommit(oid, d);
    }
  } else {
    for (const oid of reachableFromWants) {
      if (lookup(oid)?.type === 'commit') includeObject(oid);
      else includeObject(oid);
    }
  }
  // Unshallow: an old boundary whose parents are all in (sent ∪ held).
  const sentOrHeld = new Set([...send.keys(), ...held]);
  const unshallow: string[] = [];
  for (const boundary of request.shallow) {
    if (!held.has(boundary) && !send.has(boundary)) continue;
    const object = lookup(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommitShim(object.data).parents;
    if (parents.every((parent) => sentOrHeld.has(parent))) unshallow.push(boundary);
  }
  return { send, newShallow: [...new Set(newShallow)].sort(), unshallow, common };
}

/** Minimal commit parse for the fetch path (tree + parents only). */
function parseCommitShim(data: Buffer): { tree: string; parents: string[] } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
  }
  return { tree, parents };
}

/** Split pack bytes into sideband band-1 pkt-lines (32 KiB chunks, well under the 65520 cap). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return parts;
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const request = parseFetchRequest(body);
  const cacheKey = `fetch-v2:${repo.version}:${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
  const cached = repo.cache.get(cacheKey);
  if (cached) return cached.value as Buffer;
  const { send, newShallow, unshallow, common } = computeSend(repo, request);
  const pack = send.size === 0 ? emptyPack() : writePack([...send.values()]);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (common) {
      parts.push(pktLine(`ACK ${common}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(Buffer.from('0000', 'ascii'));
  }
  if (newShallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  const wantedRefs: { oid: string; ref: string }[] = [];
  for (const ref of listRefs(repo)) {
    if (ref.name === 'HEAD') continue;
    if (request.wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const wanted of wantedRefs) parts.push(pktLine(`${wanted.oid} ${wanted.ref}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  const out = Buffer.concat(parts);
  repo.cache.set(cacheKey, { version: repo.version, value: out });
  return out;
}

/** v0 fetch: plain NAK/ACK/shallow lines, then the sideband pack, then a flush. */
export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let inWants = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inWants = false;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      request.wants.push(rest.split(' ')[0]!);
    } else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) request.depth = n;
    }
  }
  void inWants;
  const cacheKey = `fetch-v0:${repo.version}:${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
  const cached = repo.cache.get(cacheKey);
  if (cached) return cached.value as Buffer;
  const { send, newShallow, unshallow, common } = computeSend(repo, request);
  const pack = send.size === 0 ? emptyPack() : writePack([...send.values()]);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktLine(common ? `ACK ${common}\n` : 'NAK\n'));
  }
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  const out = Buffer.concat(parts);
  repo.cache.set(cacheKey, { version: repo.version, value: out });
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; sideband: boolean } {
  let commands: PushCommand[] = [];
  let packStart = -1;
  let sideband = false;
  try {
    // Parse pkt-lines one at a time and stop at the flush: the pack bytes that
    // follow are raw, not pkt-lines, and must not be decoded as such.
    let offset = 0;
    let first = true;
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line length in push');
      const hex = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
      const len = parseInt(hex, 16);
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len === 1 || len === 2) {
        offset += 4;
        continue;
      }
      if (len < 4 || offset + len > body.length) throw new Error('truncated pkt-line in push');
      const payload = body.subarray(offset + 4, offset + len);
      offset += len;
      let line = payload.toString('utf8').replace(/\n$/, '');
      let caps = '';
      if (first) {
        const nul = line.indexOf('\u0000');
        if (nul >= 0) {
          caps = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
        first = false;
        sideband = caps.split(' ').includes('side-band-64k');
      }
      const parts = line.split(' ');
      if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
        throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    if (commands.length === 0) throw new Error('push has no commands');
  } catch (err) {
    // A malformed push body must not crash the server: report an unpack error.
    const inner = encodePktLines([`unpack ${(err as Error).message.replace(/\n/g, ' ')}\n`, 'flush']);
    return { status: 200, body: wrapReport(inner, true), sideband: true };
  }

  const packBytes = packStart >= 0 && packStart < body.length ? body.subarray(packStart) : null;
  let unpackError: string | null = null;
  if (packBytes && packBytes.length > 0) {
    try {
      const objects = readPack(Buffer.from(packBytes), (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: Buffer.from(object.data) });
      }
    } catch (err) {
      unpackError = (err as Error).message.replace(/\n/g, ' ');
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const reportLines: string[] = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    let mutated = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      const currentOid = current ?? ZERO_OID;
      let verdict: { ok: boolean; reason: string } | null = null;
      if (command.oldOid !== currentOid) {
        verdict = { ok: false, reason: 'non-fast-forward' };
      } else if (command.newOid === ZERO_OID) {
        if (!current) verdict = { ok: false, reason: 'remote ref does not exist' };
        else verdict = { ok: true, reason: '' };
      } else {
        const newObject = lookup(command.newOid);
        if (!newObject) {
          verdict = { ok: false, reason: 'object not found' };
        } else if (command.oldOid === ZERO_OID) {
          verdict = { ok: true, reason: '' };
        } else {
          // Fast-forward: the new tip's ancestry must include the old tip.
          let newCommit = command.newOid;
          if (newObject.type === 'tag') {
            let target = parseTag(newObject.data).object;
            let guard = 0;
            while (guard++ < 10) {
              const next = lookup(target);
              if (!next || next.type !== 'tag') break;
              target = parseTag(next.data).object;
            }
            newCommit = target;
          }
          const targetObj = lookup(newCommit);
          if (!targetObj || targetObj.type !== 'commit') {
            verdict = { ok: false, reason: 'object not found' };
          } else if (isAncestor(command.oldOid, newCommit, lookup)) {
            verdict = { ok: true, reason: '' };
          } else {
            verdict = { ok: false, reason: 'non-fast-forward' };
          }
        }
      }
      if (verdict.ok) {
        mutated = true;
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${verdict.reason}\n`);
      }
    }
    if (mutated) {
      repo.version += 1;
      repo.cache.clear();
    }
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  return { status: 200, body: wrapReport(inner, sideband), sideband };
}

/** The report-status stream, inside band-1 sideband frames when the client asked. */
function wrapReport(inner: Buffer, sideband: boolean): Buffer {
  if (!sideband) return inner;
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const chunk = inner.subarray(offset, Math.min(offset + CHUNK, inner.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export { hashObject, VIEWER };
