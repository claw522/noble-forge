// gitobj.ts — the git object model: hashing, commit/tree parsing and building, pack
// read/write (with delta resolution), ancestry, fetch object selection and tree merges.
// Pure functions over the store in core.ts; no I/O.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, type GitObject, type RepoRec, type Store } from './core.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_IDS: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

export function hashObject(type: GitObject['type'], data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(store: Store, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.objects.has(oid)) store.objects.set(oid, { type, data });
  return oid;
}

export function getObject(store: Store, oid: string): GitObject | null {
  return store.objects.get(oid) ?? null;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  time: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let time = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) time = Number(match[1]);
    }
  }
  return { tree, parents, message, time };
}

export function buildCommitData(input: { tree: string; parents: string[]; message: string; time: number }): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${input.time} +0000`;
  let text = `tree ${input.tree}\n`;
  for (const parent of input.parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${input.message}`;
  return Buffer.from(text, 'utf8');
}

export function commitOf(store: Store, oid: string): CommitInfo | null {
  const object = getObject(store, oid);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Follow a tag chain to the commit it names (or the object itself when it is a commit). */
export function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = getObject(store, current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function isTreeMode(mode: string): boolean {
  return Number.parseInt(mode, 8) === 0o40000;
}

/** Serialize entries in git's tree order (names compared with '/' appended for trees). */
export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = isTreeMode(a.mode) ? `${a.name}/` : a.name;
    const bn = isTreeMode(b.mode) ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (blob or link) under a tree, by slash path. */
export function flattenTree(store: Store, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = getObject(store, treeOid);
  if (object === null || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) nested trees from a flat path map; answers the root tree id. */
export function buildTreeFromFlat(store: Store, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return storeObject(store, 'tree', buildTreeData(entries));
  };
  return emit(root);
}

/** The blob id at a path in a tree, or null. */
export function blobAtPath(store: Store, treeOid: string, path: string): FlatEntry | null {
  return flattenTree(store, treeOid).get(path) ?? null;
}

// ---------------------------------------------------------------- ancestry

/** All commits reachable from a tip (inclusive), mapped to their generation (0 = tip). */
export function ancestorGenerations(store: Store, tip: string): Map<string, number> {
  const generations = new Map<string, number>();
  let frontier = [tip];
  let generation = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (generations.has(oid)) continue;
      const commit = commitOf(store, oid);
      if (commit === null) continue;
      generations.set(oid, generation);
      next.push(...commit.parents);
    }
    frontier = next;
    generation += 1;
  }
  return generations;
}

export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(store, oid);
    if (commit !== null) stack.push(...commit.parents);
  }
  return false;
}

/** The best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(store: Store, a: string, b: string): string | null {
  const ancestorsA = ancestorGenerations(store, a);
  let frontier = [b];
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const commit = commitOf(store, oid);
      if (commit !== null) next.push(...commit.parents);
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------- packs

/** A complete, self-contained pack holding the given objects (plain entries, no deltas). */
export function writePack(store: Store, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = getObject(store, oid);
    if (object === null) continue;
    const size = object.data.length;
    const headBytes: number[] = [];
    let first = (TYPE_IDS[object.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headBytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `offset`; answers the data and the compressed length. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; length: number } {
  const rest = buffer.subarray(offset);
  // inflateSync ignores trailing bytes and throws on a truncated stream, so success is
  // monotonic in length and the exact stream length is binary-searchable.
  let lo = 1;
  let hi = rest.length;
  try {
    inflateSync(rest);
  } catch {
    throw new Error('pack entry does not inflate');
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(rest.subarray(0, lo)), length: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Parse a pack into the store (receive-pack's unpack). Answers the object ids it carried.
 * Throws on any malformation; the caller turns that into an `unpack` failure report.
 */
export function readPack(store: Store, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, string>();
  const written: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset varint back to the base entry.
      byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOid = byOffset.get(entryStart - back) ?? null;
      if (baseOid === null) throw new Error('ofs-delta base not in pack');
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data: raw, length } = inflateAt(pack, offset);
    offset += length;
    if (raw.length !== size) throw new Error('pack entry size mismatch');
    let type: GitObject['type'];
    let data = raw;
    if (typeId === 6 || typeId === 7) {
      const base = getObject(store, baseOid!);
      if (base === null) throw new Error('delta base missing');
      type = base.type;
      data = applyDelta(base.data, raw);
    } else {
      type = ID_TYPES[typeId]!;
      if (type === undefined) throw new Error(`bad pack entry type ${typeId}`);
    }
    const oid = storeObject(store, type, data);
    byOffset.set(entryStart, oid);
    written.push(oid);
  }
  return written;
}

// ---------------------------------------------------------------- fetch selection

export interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallows: string[];
  depth?: number;
  deepen?: number;
  deepenSince?: number;
}

export interface FetchSelection {
  /** Object ids to pack (commits, trees, blobs, tags). */
  oids: string[];
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Client shallow commits that stop being boundary commits. */
  unshallow: string[];
}

/** The full object closure (commits, trees, blobs) under some commits. */
function closureOfCommits(store: Store, roots: Iterable<string>, grafted: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  const addTree = (treeOid: string): void => {
    const stackTrees = [treeOid];
    while (stackTrees.length > 0) {
      const oid = stackTrees.pop()!;
      if (out.has(oid)) continue;
      const object = getObject(store, oid);
      if (object === null || object.type !== 'tree') continue;
      out.add(oid);
      for (const entry of parseTree(object.data)) {
        if (isTreeMode(entry.mode)) stackTrees.push(entry.oid);
        else out.add(entry.oid);
      }
    }
  };
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const commit = commitOf(store, oid);
    if (commit === null) continue;
    out.add(oid);
    addTree(commit.tree);
    if (!grafted.has(oid)) stack.push(...commit.parents);
  }
  return out;
}

/**
 * Choose the objects a fetch sends: the wants' history minus the haves' closure, cut at
 * `depth` (or extended by `deepen` past the client's shallow boundary), with the new
 * shallow boundary reported the way upload-pack reports it.
 */
export function selectFetchObjects(store: Store, request: FetchRequest): FetchSelection {
  const clientShallows = new Set(request.clientShallows);
  // Exclusion: everything under the haves (traversal grafted at the client's shallow
  // boundary), plus the shallow commits and their trees, which the client already holds.
  const haveClosure = closureOfCommits(store, request.haves, clientShallows);
  const shallowClosure = closureOfCommits(store, clientShallows, clientShallows);
  const excluded = new Set<string>([...haveClosure, ...shallowClosure]);
  const excludedCommits = new Set<string>();
  for (const oid of excluded) {
    const object = getObject(store, oid);
    if (object !== null && object.type === 'commit') excludedCommits.add(oid);
  }

  const sendCommits = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();

  const bfs = (starts: string[], maxGeneration: number, stopAtShallowBoundary: boolean): string[] => {
    // Returns the frontier commits reached but not expanded (boundary candidates).
    const frontier: string[] = [];
    const seen = new Set<string>();
    let level = starts.filter((oid) => commitOf(store, oid) !== null);
    let generation = 0;
    while (level.length > 0) {
      const next: string[] = [];
      for (const oid of level) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (stopAtShallowBoundary && clientShallows.has(oid)) {
          frontier.push(oid);
          continue;
        }
        if (excludedCommits.has(oid)) continue;
        sendCommits.add(oid);
        const commit = commitOf(store, oid)!;
        if (generation >= maxGeneration) {
          if (commit.parents.length > 0) frontier.push(oid);
          continue;
        }
        for (const parent of commit.parents) {
          if (!excludedCommits.has(parent) && commitOf(store, parent) !== null) next.push(parent);
        }
      }
      level = next;
      generation += 1;
    }
    return frontier;
  };

  // A frontier commit is a real boundary only when some parent stays unsent and unknown.
  const markBoundary = (candidates: Iterable<string>): void => {
    for (const oid of candidates) {
      const commit = commitOf(store, oid);
      if (commit !== null && commit.parents.some((parent) => !sendCommits.has(parent) && !excludedCommits.has(parent))) shallow.add(oid);
    }
  };

  if (request.deepen !== undefined) {
    // `deepen N` sets the total depth from the wants: the client's shallow commits are
    // traversed but not resent, so a depth-1 clone deepened by `deepen 2` gains exactly
    // one generation.
    const seen = new Set<string>();
    let level = request.wants.filter((oid) => commitOf(store, oid) !== null);
    let generation = 0;
    const frontier: string[] = [];
    while (level.length > 0) {
      const next: string[] = [];
      for (const oid of level) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const held = clientShallows.has(oid);
        if (!held && excludedCommits.has(oid)) continue;
        if (!held) sendCommits.add(oid);
        const commit = commitOf(store, oid)!;
        if (generation >= request.deepen - 1) {
          if (!held && commit.parents.length > 0) frontier.push(oid);
          continue;
        }
        for (const parent of commit.parents) {
          if (commitOf(store, parent) !== null) next.push(parent);
        }
      }
      level = next;
      generation += 1;
    }
    markBoundary(frontier);
    // A shallow commit whose parents all arrived (or were already held) and at least
    // one of which this fetch delivered stops being a boundary: report it unshallowed.
    for (const oid of clientShallows) {
      const commit = commitOf(store, oid);
      if (commit === null || commit.parents.length === 0) continue;
      const delivered = commit.parents.some((parent) => sendCommits.has(parent));
      const complete = commit.parents.every((parent) => sendCommits.has(parent) || excludedCommits.has(parent));
      if (delivered && complete) unshallow.add(oid);
    }
  } else if (request.depth !== undefined) {
    const frontier = bfs(request.wants, request.depth - 1, false);
    markBoundary(frontier);
  } else if (request.deepenSince !== undefined) {
    // Commits strictly newer than the timestamp, with the first older commits as boundary.
    const seen = new Set<string>();
    const stack = [...request.wants];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || excludedCommits.has(oid)) continue;
      seen.add(oid);
      const commit = commitOf(store, oid);
      if (commit === null) continue;
      if (commit.time > request.deepenSince) {
        sendCommits.add(oid);
        stack.push(...commit.parents);
      } else {
        shallow.add(oid);
      }
    }
  } else {
    bfs(request.wants, Number.POSITIVE_INFINITY, false);
  }

  // Wanted refs may name tag objects or trees/blobs directly; include them as-is.
  const extra = new Set<string>();
  for (const want of request.wants) {
    const object = getObject(store, want);
    if (object !== null && object.type !== 'commit' && !excluded.has(want)) extra.add(want);
  }

  // The pack holds exactly the chosen commits plus their own tree closures: history
  // beyond the chosen commits (a deeper ancestry, a cut shallow frontier) is NOT sent.
  const oids: string[] = [];
  const sent = new Set<string>();
  const pushTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (sent.has(oid) || excluded.has(oid)) continue;
      const object = getObject(store, oid);
      if (object === null || object.type !== 'tree') continue;
      sent.add(oid);
      oids.push(oid);
      for (const entry of parseTree(object.data)) {
        if (isTreeMode(entry.mode)) stack.push(entry.oid);
        else if (!sent.has(entry.oid) && !excluded.has(entry.oid)) {
          sent.add(entry.oid);
          oids.push(entry.oid);
        }
      }
    }
  };
  for (const oid of sendCommits) {
    if (sent.has(oid) || excluded.has(oid)) continue;
    sent.add(oid);
    oids.push(oid);
    const commit = commitOf(store, oid);
    if (commit !== null) pushTree(commit.tree);
  }
  for (const oid of extra) if (!sent.has(oid)) oids.push(oid);
  return { oids, shallow: [...shallow], unshallow: [...unshallow] };
}

// ---------------------------------------------------------------- tree diff and merge

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
}

/** Path-level changes between two trees (base -> head). */
export function diffTrees(store: Store, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  const head = headTree === null ? new Map<string, FlatEntry>() : flattenTree(store, headTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const before = base.get(path);
    if (before === undefined) changes.push({ path, status: 'added' });
    else if (before.oid !== entry.oid || before.mode !== entry.mode) changes.push({ path, status: 'modified' });
  }
  for (const path of base.keys()) if (!head.has(path)) changes.push({ path, status: 'removed' });
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export type MergeOutcome = { ok: true; tree: string } | { ok: false };

/**
 * A three-way merge of two trees against their merge-base tree, at path granularity:
 * a path changed on only one side takes that side; changed on both to the same value
 * takes it; changed on both differently is a conflict.
 */
export function mergeTrees(store: Store, baseTree: string, ourTree: string, theirTree: string): MergeOutcome {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, FlatEntry>();
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
    a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) result.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) result.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) result.set(path, o);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, tree: buildTreeFromFlat(store, result) };
}

/** The tree of a commit, or null. */
export function treeOfCommit(store: Store, commitOid: string): string | null {
  const commit = commitOf(store, commitOid);
  return commit === null ? null : commit.tree;
}

/** A repository's branch tip tree, or null when the branch is unborn/absent. */
export function tipTree(store: Store, repo: RepoRec, branch: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const commit = peelToCommit(store, tip);
  return commit === null ? null : treeOfCommit(store, commit);
}
