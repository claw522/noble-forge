// gitproto.ts — the git smart-HTTP surface: info/refs advertisements, protocol v2
// ls-refs and fetch, protocol v0 fetch, and receive-pack pushes with report-status.
// Objects live in the shared store (gitobj.ts); refs live on the repository record.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchRef, store as defaultStore, type RepoRec, type Store } from './core.ts';
import {
  ZERO_OID,
  commitOf,
  isAncestor,
  isOid,
  peelToCommit,
  readPack,
  selectFetchObjects,
  writePack,
  type FetchRequest,
} from './gitobj.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too large');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole pkt-line buffer; throws on malformation (callers answer 400). */
export function decodePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length < 4) {
      throw new Error('bad pkt-line length');
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split a byte stream into side-band-64k packets on band 1 (payload chunks of <= 65515). */
function sidebandPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) {
    const chunk = data.subarray(offset, offset + 65515);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

// ---------------------------------------------------------------- helpers

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': text.length,
    'x-github-request-id': 'noble-forge',
  });
  res.end(text);
}

const AGENT = 'noble-forge/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The repository's advertised refs: HEAD first, then refs in name order, tags peeled. */
function advertisedRefs(store: Store, repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = branchRef(repo.defaultBranch);
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const peeled = peelToCommit(store, oid);
    if (peeled !== null && peeled !== oid) line.peeled = peeled;
    lines.push(line);
  }
  return lines;
}

function advertisementV0(store: Store, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(store, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} agent=${AGENT}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps} agent=${AGENT}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: RepoRec | null,
  service: string | null,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'service parameter required' });
    return;
  }
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantsV2 ? advertisementV2() : advertisementV0(store, repo, service);
  sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(store: Store, repo: RepoRec, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = branchRef(repo.defaultBranch);
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelToCommit(store, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- fetch

function parseFetchArgs(args: string[]): FetchRequest & { done: boolean } {
  const request: FetchRequest & { done: boolean } = { wants: [], haves: [], clientShallows: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.clientShallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(arg.slice(13).trim(), 10);
    else if (arg === 'done') request.done = true;
  }
  return request;
}

function fetchPack(store: Store, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const selection = selectFetchObjects(store, request);
  return { pack: writePack(store, selection.oids), shallow: selection.shallow, unshallow: selection.unshallow };
}

function handleFetchV2(store: Store, repo: RepoRec, args: string[], res: ServerResponse): void {
  const request = parseFetchArgs(args);
  if (!request.done) {
    // Negotiation round: no common commits are claimed, the client will retry with done.
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]));
    return;
  }
  const { pack, shallow, unshallow } = fetchPack(store, request);
  const parts: Buffer[] = [];
  const shallowRequested = request.depth !== undefined || request.deepen !== undefined || request.deepenSince !== undefined;
  if (shallow.length > 0 || unshallow.length > 0 || shallowRequested) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(store: Store, repo: RepoRec, packets: Packet[], res: ServerResponse): void {
  // v0: want/shallow/deepen lines, a flush, then have lines and done.
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const request = parseFetchArgs(
    args.map((line, index) => {
      if (index === 0 && line.startsWith('want ')) {
        // The first want line may carry capabilities after the object id.
        const parts = line.split(' ');
        return parts.length > 2 ? `want ${parts[1]}` : line;
      }
      return line;
    }),
  );
  const { pack, shallow, unshallow } = fetchPack(store, request);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function handleUploadPack(res: ServerResponse, store: Store, repo: RepoRec | null, body: Buffer, version2: boolean): void {
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let packets: Packet[];
  try {
    packets = decodePackets(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line request' });
    return;
  }
  if (!version2) {
    handleFetchV0(store, repo, packets, res);
    return;
  }
  // v2: a command line, capability lines, a delim, then the command's arguments.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = lines.find((line) => line.startsWith('command='));
  if (command === undefined) {
    sendJson(res, 400, { message: 'missing command' });
    return;
  }
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines: string[] = [];
  if (delimIndex >= 0) {
    for (const packet of packets.slice(delimIndex + 1)) {
      if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  if (command === 'command=ls-refs') {
    handleLsRefs(store, repo, argLines, res);
    return;
  }
  if (command === 'command=fetch') {
    handleFetchV2(store, repo, argLines, res);
    return;
  }
  sendJson(res, 400, { message: `unknown command ${command.slice(8)}` });
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(res: ServerResponse, store: Store, repo: RepoRec | null, body: Buffer): void {
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // The command list is pkt-lines up to a flush; the pack is the raw remainder.
  let offset = 0;
  const commandLines: string[] = [];
  let malformed = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      malformed = true;
      break;
    }
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      malformed = true;
      break;
    }
    commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, ''));
    offset += length;
  }
  if (malformed || commandLines.length === 0) {
    sendJson(res, 400, { message: 'malformed receive-pack request' });
    return;
  }
  const pack = body.subarray(offset);
  const firstLine = commandLines[0]!;
  const nul = firstLine.indexOf('\0');
  const capabilities = nul >= 0 ? firstLine.slice(nul + 1).split(' ') : [];
  if (nul >= 0) commandLines[0] = firstLine.slice(0, nul);
  const wantsReport = capabilities.includes('report-status');
  const wantsSideband = capabilities.includes('side-band-64k');

  const commands: PushCommand[] = [];
  for (const line of commandLines) {
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      sendJson(res, 400, { message: 'malformed ref update command' });
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }

  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (hasUpdates) {
    if (pack.length === 0) {
      unpackError = 'no packfile sent';
    } else {
      try {
        readPack(store, pack);
      } catch (error) {
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!command.ref.startsWith('refs/') || command.ref.includes('..') || command.ref.includes(' ')) {
      fail('invalid ref name');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // A deletion.
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      if (current !== command.oldOid) {
        fail('stale info');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    const target = store.objects.get(command.newOid);
    if (target === undefined) {
      fail('reference not found');
      continue;
    }
    const isBranch = command.ref.startsWith('refs/heads/');
    const commit = peelToCommit(store, command.newOid);
    if (isBranch && commit === null) {
      fail('invalid object');
      continue;
    }
    if (current !== command.oldOid) {
      fail(current === ZERO_OID ? 'reference already exists' : 'stale info');
      continue;
    }
    if (current !== ZERO_OID && commit !== null) {
      const currentCommit = peelToCommit(store, current);
      if (currentCommit !== null && !isAncestor(store, currentCommit, commit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!wantsReport) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportParts: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (wantsSideband) {
    const wrapped = [...sidebandPackets(report), PKT_FLUSH];
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(wrapped));
  } else {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
  }
}

/** The store most handlers use; exported for app.ts wiring symmetry. */
export { defaultStore };
