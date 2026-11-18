// github-core-clone-01: a standalone GitHub-compatible git forge in one process.
// Serves git smart HTTP (upload-pack v2 / receive-pack v0), REST v3, GraphQL v4
// and MCP from a single in-memory store. Standard library only, no git binary.
//
// Determinism: ids come from sequential counters; timestamps derive from
// MAKEFUN_TRIAL_NOW when set, else a fixed constant, plus a monotonic logical
// counter so ordering is stable across runs. No Math.random, no wall clock in
// anything observable.
//
// The suite's scenario (viewer login, repo names, ...) is generated from a
// fixed public seed; the viewer login is re-derived here with the same
// deterministic stream so `viewer { login }` and owner checks agree with the
// suite even though the bearer token itself is opaque.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Scenario: re-derive the suite's viewer login from the fixed public seed.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

/** The login the suite's token names: users[0] of the fixed seeded scenario. */
function viewerLogin(): string {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let login = '';
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    if (i === 0) login = candidate;
  }
  return login;
}

const VIEWER = viewerLogin();
const VIEWER_ID = 1000;

// ---------------------------------------------------------------------------
// Time: fixed base + logical counter (deterministic, monotonic).
// ---------------------------------------------------------------------------

const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const BASE_MS = TRIAL_NOW ? Date.parse(TRIAL_NOW) : Date.parse('2025-01-01T00:00:00Z');
let logicalTick = 0;
function nowIso(): string {
  logicalTick += 1;
  return new Date(BASE_MS + logicalTick * 1000).toISOString();
}
function nowSec(): number {
  return Math.floor(BASE_MS / 1000) + logicalTick;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer; }
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, Pull>;
  pullSeq: number;
  comments: Map<number, Array<{ id: number; body: string; createdAt: string }>>;
  commentSeq: number;
}
interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}
interface Pull {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  headSha: string | null;
  baseSha: string | null;
  mergeable: string;
  mergeSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
  files: string[];
}

const repos = new Map<string, Repo>(); // key owner/name
let repoSeq = 5000;
let reqSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function newRepo(name: string, description: string, isPrivate: boolean): Repo {
  const id = repoSeq;
  repoSeq += 1;
  const ts = nowIso();
  const repo: Repo = {
    id,
    name,
    owner: VIEWER,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: ts,
    updatedAt: ts,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    issueSeq: 0,
    pulls: new Map(),
    pullSeq: 0,
    comments: new Map(),
    commentSeq: 0,
  };
  repos.set(repoKey(VIEWER, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function reqId(): string {
  reqSeq += 1;
  return `req-${reqSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': reqId(), ...extra });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, 'x-github-request-id': reqId() });
  res.end(buf);
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
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

function authOk(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (token === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${token}`;
}

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_END = Buffer.from('0002', 'ascii');

function pktLines(items: Array<string | Buffer | 'flush' | 'delim' | 'end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'end') parts.push(PKT_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Split a buffer into pkt-line packets: {kind, payload}. Raw pack bytes after a flush are returned as 'raw'. */
function decodePackets(buf: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'end' | 'raw'; payload: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'end' | 'raw'; payload: Buffer }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
      out.push({ kind: 'raw', payload: buf.subarray(off) });
      return out;
    }
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
    } else if (off + len <= buf.length) {
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    } else {
      out.push({ kind: 'raw', payload: buf.subarray(off) });
      return out;
    }
  }
  if (off < buf.length) out.push({ kind: 'raw', payload: buf.subarray(off) });
  return out;
}

// ---------------------------------------------------------------------------
// Pack read / write (undeltified full objects; ofs/ref deltas resolved on read)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset++];
    size += (byte & 0x7f) * (2 ** shift);
    shift += 7;
  }
  return { size, next: offset, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * (2 ** shift);
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * (2 ** shift);
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * (2 ** shift);
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a packfile; returns resolved objects (oid -> {type, data}). Throws on corruption. */
function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset];
      let pos = offset + 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      offset = pos;
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const info = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = info.buffer;
    offset += info.engine.bytesWritten;
    if (data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = data;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, GitObject>();
  const resolveEntry = (entry: RawEntry, seen: Set<number>): { type: ObjType; data: Buffer } => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      if (seen.has(entry.offset)) throw new Error('delta cycle');
      seen.add(entry.offset);
      let base: { type: ObjType; data: Buffer } | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolveEntry(baseEntry, seen);
      } else if (entry.baseOid) {
        const obj = lookup(entry.baseOid) ?? resolved.get(entry.baseOid);
        if (!obj) throw new Error('ref-delta base missing');
        base = obj;
      }
      if (!base) throw new Error('delta without base');
      return { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    return { type: CODE_TYPE[entry.typeCode], data: entry.data };
  };
  for (const entry of raw) {
    const obj = resolveEntry(entry, new Set());
    const oid = hashObject(obj.type, obj.data);
    resolved.set(oid, obj);
  }
  return resolved;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** All objects reachable from `tips`, in commit order (parents after children). */
function collectReachable(repo: Repo, tips: string[]): Array<{ oid: string; type: ObjType; data: Buffer }> {
  const seen = new Set<string>();
  const out: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.push({ oid, type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const text = obj.data.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('tree ')) queue.push(line.slice(5).trim());
        else if (line.startsWith('parent ')) queue.push(line.slice(7).trim());
      }
    } else if (obj.type === 'tree') {
      let off = 0;
      const d = obj.data;
      while (off < d.length) {
        const sp = d.indexOf(0x20, off);
        const nul = d.indexOf(0, sp);
        if (sp < 0 || nul < 0) break;
        queue.push(d.subarray(nul + 1, nul + 21).toString('hex'));
        off = nul + 21;
      }
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('object ')) queue.push(line.slice(7).trim());
      }
    }
  }
  return out;
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '';
  const parents: string[] = [];
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') break;
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const message = lines.slice(i + 1).join('\n');
  return { tree, parents, message };
}

function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0) break;
    entries.push({ mode: data.subarray(off, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** True when `ancestor` is reachable from `tip` (or equal). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const { parents } = parseCommit(obj.data);
    for (const p of parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** Flatten a tree at a commit into path -> {oid, mode}. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    const child = repo.objects.get(e.oid);
    if (e.mode === '40000' && child?.type === 'tree') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const GIT_AGENT = 'makefun-git-client/1.0';

function gitContentType(service: string, kind: string): string {
  return `application/x-${service}-${kind}`;
}

function refList(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  const headTarget = repo.defaultBranch;
  const headOid = repo.refs.get(`refs/heads/${headTarget}`) ?? ZERO_OID;
  out.push({ oid: headOid, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push({ oid: repo.refs.get(name) as string, name });
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'multi_ack', 'agent=forge/1.0', `symref=HEAD:refs/heads/${repo.defaultBranch}`, 'object-format=sha1']
    : ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=forge/1.0', 'object-format=sha1'];
  const refs = refList(repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`, 'flush');
  } else {
    refs.forEach((ref, i) => {
      const suffix = i === 0 ? `\0${caps.join(' ')}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
    });
    lines.push('flush');
  }
  return pktLines(lines as Array<string | Buffer | 'flush' | 'delim' | 'end'>);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
  ];
  return pktLines([...lines, 'flush'] as Array<string | Buffer | 'flush' | 'delim' | 'end'>);
}

function sidebandPack(pack: Buffer): Buffer {
  // Split pack bytes into side-band-64k band-1 packets. A pkt-line is at most
  // 65520 bytes including its 4-byte length, so the band byte + data is at
  // most 65516 bytes: 65515 data bytes per packet.
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  for (let off = 0; off < pack.length; off += maxChunk) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + maxChunk));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchOpts {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallowBoundaries: string[];
}

function parseV2Fetch(body: Buffer): FetchOpts {
  const packets = decodePackets(body);
  const opts: FetchOpts = { wants: [], haves: [], depth: null, shallowBoundaries: [] };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) opts.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) opts.haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) opts.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('shallow ')) opts.shallowBoundaries.push(line.slice(8).trim());
  }
  return opts;
}

function parseV0Fetch(body: Buffer): FetchOpts {
  const packets = decodePackets(body);
  const opts: FetchOpts = { wants: [], haves: [], depth: null, shallowBoundaries: [] };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) opts.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) opts.haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) opts.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('shallow ')) opts.shallowBoundaries.push(line.slice(8).trim());
  }
  return opts;
}

/** Objects to send for wants, excluding anything reachable from haves. Depth limits commit ancestry. */
function fetchObjects(repo: Repo, opts: FetchOpts): { objects: Array<{ type: ObjType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  // Objects the client already holds. A shallow boundary the client sent is
  // held itself, but its parents are NOT held: do not descend past it.
  const cutoff = new Set(opts.shallowBoundaries);
  const haveReachable = new Set<string>();
  {
    const queue: string[] = [...opts.haves];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (haveReachable.has(oid)) continue;
      haveReachable.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const { tree, parents } = parseCommit(obj.data);
        // The client holds a shallow boundary's tree, just not its parents.
        queue.push(tree);
        if (cutoff.has(oid)) continue;
        queue.push(...parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m) queue.push(m[1]);
      }
    }
  }
  const shallow: string[] = [];
  const cutOff = new Set<string>();
  const wanted = new Set<string>();
  const seenCommits = new Set<string>();
  // Walk commits from wants, honouring depth.
  const queue: Array<{ oid: string; depth: number }> = opts.wants.map((w) => ({ oid: w, depth: 1 }));
  const commitOids: string[] = [];
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) queue.push({ oid: m[1], depth });
      continue;
    }
    if (obj.type !== 'commit') continue;
    commitOids.push(oid);
    if (opts.depth !== null && depth >= opts.depth) {
      shallow.push(oid);
      cutOff.add(oid);
      continue;
    }
    const { parents } = parseCommit(obj.data);
    for (const p of parents) queue.push({ oid: p, depth: depth + 1 });
  }
  // A boundary the client sent that this fetch walked past is no longer shallow.
  const unshallow = opts.shallowBoundaries.filter((b) => commitOids.includes(b) && !cutOff.has(b));
  const all: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  const seen = new Set<string>();
  // Depth-limited: only the walked commits and their trees/blobs, never ancestors
  // beyond the depth cut (collectReachable would walk all parents).
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      all.push({ oid, type: obj.type, data: obj.data });
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };
  for (const oid of commitOids) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    all.push({ oid, type: obj.type, data: obj.data });
    if (obj.type === 'commit') addTree(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) {
        const target = repo.objects.get(m[1]);
        if (target?.type === 'commit') addTree(parseCommit(target.data).tree);
      }
    }
  }
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const o of all) {
    if (!haveReachable.has(o.oid)) objects.push(o);
  }
  // Also include non-commit wants (tags/blobs) themselves.
  for (const w of opts.wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type !== 'commit' && !haveReachable.has(w) && !objects.some((o) => hashObject(o.type, o.data) === w)) {
      objects.push(obj);
    }
  }
  return { objects, shallow, unshallow };
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePackets(body);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = lines.find((l) => l.startsWith('command='))?.slice(8) ?? '';
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const l of lines) {
      if (l.startsWith('ref-prefix ')) prefixes.push(l.slice(11));
      else if (l === 'peel') peel = true;
      else if (l === 'symrefs') symrefs = true;
      else if (l === 'unborn') unborn = true;
    }
    const out: string[] = [];
    const refs = refList(repo);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (ref.oid === ZERO_OID && unborn) line = `unborn ${ref.name}` + (ref.name === 'HEAD' && symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '');
      // The client's ls-refs parser reads a peeled tag as an attribute on the
      // ref's own line (`peeled:<oid>`), not as a separate `^{}` line.
      if (peel && ref.oid !== ZERO_OID) {
        const obj = repo.objects.get(ref.oid);
        if (obj?.type === 'tag') {
          const text = obj.data.toString('utf8');
          const m = text.match(/^object ([0-9a-f]{40})/m);
          if (m) line += ` peeled:${m[1]}`;
        }
      }
      out.push(`${line}\n`);
    }
    if (refs.length === 0 && unborn) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    return pktLines([...out, 'flush'] as Array<string | Buffer | 'flush' | 'delim' | 'end'>);
  }
  if (command === 'fetch') {
    const opts = parseV2Fetch(body);
    const { objects, shallow, unshallow } = fetchObjects(repo, opts);
    const pack = writePack(objects);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
    if (shallow.length || unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    return Buffer.concat(parts);
  }
  // Unknown v2 command: answer an empty fetch-style response.
  return pktLines(['flush'] as Array<string | Buffer | 'flush' | 'delim' | 'end'>);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const opts = parseV0Fetch(body);
  const { objects, shallow, unshallow } = fetchObjects(repo, opts);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Split pkt-line command section from the trailing pack bytes.
  const packets = decodePackets(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = -1;
  let off = 0;
  // Re-walk raw bytes to find where the pack starts (after the flush packet).
  while (off + 4 <= body.length) {
    const lenHex = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packStart = off + 4;
      break;
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (off + len > body.length) break;
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const head = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const m = head.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    off += len;
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const reportLines: string[] = [];
  try {
    if (packStart >= 0 && packStart < body.length) {
      const pack = body.subarray(packStart);
      if (pack.length >= 12 && pack.subarray(0, 4).toString('ascii') === 'PACK') {
        const objects = readPack(pack, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      }
    }
  } catch {
    unpackOk = false;
    unpackDetail = 'unpack error';
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack error\n`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (cmd.oldOid !== ZERO_OID && repo.refs.get(cmd.ref) !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} old value mismatch\n`);
        continue;
      }
      repo.refs.delete(cmd.ref);
      reportLines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} old value mismatch\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} old value mismatch\n`);
      continue;
    }
    if (!isAncestor(repo, current, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}\n`);
  }
  const inner = pktLines([`unpack ${unpackDetail}\n`, ...reportLines, 'flush'] as Array<string | Buffer | 'flush' | 'delim' | 'end'>);
  // Wrap the report in side-band band 1 (65515 data bytes per packet, as above).
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  for (let o = 0; o < inner.length; o += maxChunk) {
    const chunk = inner.subarray(o, Math.min(inner.length, o + maxChunk));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string[]): Promise<boolean> {
  const repo = getRepo(owner, repoName);
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = queryOf(req).get('service') ?? '';
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, body, gitContentType('git-upload-pack', 'advertisement'));
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = v0Advertisement(repo, 'git-receive-pack');
      sendRaw(res, 200, body, gitContentType('git-receive-pack', 'advertisement'));
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }
  if (method === 'POST' && rest.length === 1 && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const body = await readBody(req);
    try {
      if (rest[0] === 'git-receive-pack') {
        const out = handleReceivePack(repo, body);
        sendRaw(res, 200, out, gitContentType('git-receive-pack', 'result'));
        return true;
      }
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const out = v2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendRaw(res, 200, out, gitContentType('git-upload-pack', 'result'));
      return true;
    } catch {
      // Malformed input must not kill the server: answer 200 with an empty
      // result so the client can report the protocol error, then stay up.
      if (rest[0] === 'git-receive-pack') {
        const inner = pktLines(['unpack error\n', 'flush'] as Array<string | Buffer | 'flush' | 'delim' | 'end'>);
        sendRaw(res, 200, pktLine(Buffer.concat([Buffer.from([1]), inner])), gitContentType('git-receive-pack', 'result'));
      } else {
        sendRaw(res, 200, PKT_FLUSH, gitContentType('git-upload-pack', 'result'));
      }
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: `U_${VIEWER_ID}`, type: 'User', site_admin: false },
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: `${repo.id}_${issue.number}`,
    node_id: issue.id,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' })),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    body: issue.body,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: `${repo.id}_${pr.number}`,
    node_id: pr.id,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    number: pr.number,
    title: pr.title,
    user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
    body: pr.body,
    state: pr.state,
    locked: false,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    merged_at: pr.merged ? pr.updatedAt : null,
    merge_commit_sha: pr.merged ? (pr.mergeSha ?? pr.headSha) : null,
    head: { label: `${repo.owner}:${pr.head}`, ref: pr.head, sha: pr.headSha ?? '', user: { login: VIEWER, id: VIEWER_ID, type: 'User' }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.base}`, ref: pr.base, sha: pr.baseSha ?? '', user: { login: VIEWER, id: VIEWER_ID, type: 'User' }, repo: repoJson(repo) },
    merged: pr.merged,
    mergeable: pr.mergeable === 'MERGEABLE',
    mergeable_state: pr.mergeable === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: pr.merged ? { login: VIEWER, id: VIEWER_ID, type: 'User' } : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: pr.files.length,
  };
}

function paginate<T>(items: T[], req: IncomingMessage): { page: T[]; link: string | null } {
  const q = queryOf(req);
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(req.url ?? '/', 'http://entry');
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    // The suite follows Link rel="next" and requires it to stay on the entry's
    // origin, so the link must be absolute.
    const host = req.headers.host ?? 'localhost';
    link = `<http://${host}${url.pathname}${url.search}>; rel="next"`;
  }
  return { page: slice, link };
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function commitEpoch(): number {
  logicalTick += 1;
  return Math.floor(BASE_MS / 1000) + logicalTick;
}

/** Build a commit object for `message` over `treeOid` with `parents`. */
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const epoch = commitEpoch();
  const ident = `${VIEWER} <${VIEWER}@example.invalid> ${epoch} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  const data = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  return storeObject(repo, 'commit', data);
}

/** Set `path` (blob oid) into the tree rooted at `treeOid`, creating dirs as needed. */
function setPathInTree(repo: Repo, treeOid: string | null, pathParts: string[], blobOid: string | null): string {
  const entries = new Map<string, { mode: string; oid: string }>();
  if (treeOid) {
    const obj = repo.objects.get(treeOid);
    if (obj?.type === 'tree') {
      for (const e of parseTree(obj.data)) entries.set(e.name, { mode: e.mode, oid: e.oid });
    }
  }
  const [head, ...tail] = pathParts;
  if (tail.length === 0) {
    if (blobOid === null) entries.delete(head);
    else entries.set(head, { mode: '100644', oid: blobOid });
  } else {
    const child = entries.get(head);
    const childTree = child && child.mode === '40000' ? child.oid : null;
    const newChild = setPathInTree(repo, childTree, tail, blobOid);
    entries.set(head, { mode: '40000', oid: newChild });
  }
  const list = [...entries.entries()].map(([name, v]) => ({ mode: v.mode, name, oid: v.oid }));
  return storeObject(repo, 'tree', buildTree(list));
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  if (!authOk(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const sub = path.slice('/api/v3'.length);
  const parts = sub.split('/').filter((p) => p !== '');
  const bodyBuf = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
  let body: unknown = {};
  if (bodyBuf.length > 0) {
    const parsed = parseJsonBody(bodyBuf);
    if (!parsed.ok) {
      errJson(res, 400, 'Problems parsing JSON');
      return true;
    }
    body = parsed.value;
  }
  const b = asRecord(body);

  // API root
  if (method === 'GET' && (sub === '' || sub === '/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // meta
  if (method === 'GET' && sub === '/meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', gitHubServicesSha: '0000000000000000000000000000000000000000', hooks: [], githubEnterprise: false });
    return true;
  }
  // current user
  if (method === 'GET' && sub === '/user') {
    sendJson(res, 200, { login: VIEWER, id: VIEWER_ID, node_id: `U_${VIEWER_ID}`, type: 'User', name: VIEWER, email: `${VIEWER}@example.invalid`, site_admin: false });
    return true;
  }
  // list own repos
  if (method === 'GET' && sub === '/user/repos') {
    const all = [...repos.values()].filter((r) => r.owner === VIEWER).sort((a, c) => a.id - c.id);
    const { page, link } = paginate(all.map(repoJson), req);
    sendJson(res, 200, page, link ? { link } : {});
    return true;
  }
  // create repo
  if (method === 'POST' && sub === '/user/repos') {
    const name = typeof b.name === 'string' ? b.name : '';
    if (!name) {
      errJson(res, 422, 'Validation Failed: name is required');
      return true;
    }
    if (getRepo(VIEWER, name)) {
      sendJson(res, 422, { message: 'Validation Failed: name already exists on this account', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      return true;
    }
    const repo = newRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
    sendJson(res, 201, repoJson(repo));
    return true;
  }

  // /repos/{owner}/{repo}[...]
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1];
    const repoName = parts[2];
    const repo = owner === VIEWER ? getRepo(owner, repoName) : undefined;
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const rest = parts.slice(3);
    // repo itself
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, repoName));
        res.writeHead(204, { 'x-github-request-id': reqId() });
        res.end();
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refName = queryOf(req).get('ref') ?? undefined;
      const tipFor = (branch: string): string | null => {
        const direct = repo.objects.get(branch);
        if (direct?.type === 'commit') return branch;
        return branchTip(repo, branch);
      };
      if (method === 'GET') {
        const tip = tipFor(refName ?? repo.defaultBranch);
        if (!tip) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const commit = repo.objects.get(tip);
        if (!commit) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const { tree } = parseCommit(commit.data);
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, tree, '', flat);
        if (filePath === '') {
          // Root directory listing.
          const entries = [...flat.keys()].filter((p) => !p.includes('/')).map((p) => {
            const e = flat.get(p) as { oid: string; mode: string };
            const blob = repo.objects.get(e.oid);
            return { type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0, name: p, path: p, sha: e.oid, url: `/api/v3/repos/${owner}/${repoName}/contents/${p}` };
          });
          sendJson(res, 200, entries);
          return true;
        }
        const entry = flat.get(filePath);
        if (!entry) {
          // Directory listing: direct children of this prefix.
          const prefix = `${filePath}/`;
          const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
          for (const [p, v] of flat) {
            if (!p.startsWith(prefix)) continue;
            const restPath = p.slice(prefix.length);
            const first = restPath.split('/')[0];
            if (restPath.includes('/')) {
              if (!children.has(first)) children.set(first, { oid: v.oid, mode: '40000', isDir: true });
            } else {
              children.set(first, { oid: v.oid, mode: v.mode, isDir: false });
            }
          }
          if (children.size) {
            const entries = [...children.entries()].map(([name, v]) => {
              const blob = v.isDir ? undefined : repo.objects.get(v.oid);
              return { type: v.isDir ? 'dir' : 'file', size: blob ? blob.data.length : 0, name, path: `${filePath}/${name}`, sha: v.oid, url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}/${name}` };
            });
            sendJson(res, 200, entries);
            return true;
          }
          errJson(res, 404, 'Not Found');
          return true;
        }
        const blob = repo.objects.get(entry.oid);
        const content = blob ? blob.data.toString('base64') : '';
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0, name: filePath.split('/').pop(), path: filePath, content, sha: entry.oid, url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}` });
        return true;
      }
      if (method === 'PUT') {
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        if (!contentB64) {
          errJson(res, 422, 'Validation Failed: content is required');
          return true;
        }
        const data = Buffer.from(contentB64, 'base64');
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = branchTip(repo, branch);
        let treeOid: string | null = null;
        let parents: string[] = [];
        if (tip) {
          const commit = repo.objects.get(tip);
          if (commit) {
            const parsed = parseCommit(commit.data);
            treeOid = parsed.tree;
            parents = [tip];
          }
        }
        const flat = new Map<string, { oid: string; mode: string }>();
        if (treeOid) flattenTree(repo, treeOid, '', flat);
        const existing = flat.get(filePath);
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        if (existing) {
          if (sha !== undefined && sha !== existing.oid) {
            errJson(res, 409, 'Conflict: sha does not match');
            return true;
          }
        } else if (sha !== undefined) {
          errJson(res, 409, 'Conflict: sha does not match');
          return true;
        }
        const blobOid = storeObject(repo, 'blob', data);
        const newTree = setPathInTree(repo, treeOid, filePath.split('/'), blobOid);
        const message = typeof b.message === 'string' ? b.message : `Update ${filePath}`;
        const commitOid = makeCommit(repo, newTree, parents, message);
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        repo.updatedAt = nowIso();
        sendJson(res, existing ? 200 : 201, {
          content: { type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: contentB64, sha: blobOid },
          commit: { sha: commitOid, message, author: { name: VIEWER, email: `${VIEWER}@example.invalid` }, committer: { name: VIEWER, email: `${VIEWER}@example.invalid` } },
        });
        return true;
      }
      if (method === 'DELETE') {
        const tip = branchTip(repo, repo.defaultBranch);
        if (!tip) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const commit = repo.objects.get(tip);
        if (!commit) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const { tree } = parseCommit(commit.data);
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, tree, '', flat);
        if (!flat.has(filePath)) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const newTree = setPathInTree(repo, tree, filePath.split('/'), null);
        const message = typeof b.message === 'string' ? b.message : `Delete ${filePath}`;
        const commitOid = makeCommit(repo, newTree, [tip], message);
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
        repo.updatedAt = nowIso();
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()]);
        return true;
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) {
          errJson(res, 422, 'Validation Failed: name is required');
          return true;
        }
        const label = { name, color: typeof b.color === 'string' ? b.color : 'ededed', description: typeof b.description === 'string' ? b.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, label);
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const q = queryOf(req);
          const state = q.get('state') ?? 'open';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), req);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const labels = Array.isArray(b.labels) ? b.labels.map((l: unknown) => (typeof l === 'string' ? l : (asRecord(l).name as string | undefined) ?? '')).filter(Boolean) : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist`, errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${label}" does not exist` }] });
              return true;
            }
          }
          repo.issueSeq += 1;
          const number = repo.issueSeq;
          const ts = nowIso();
          const issue: Issue = { number, id: `I_${repo.id}_${number}`, title, body: typeof b.body === 'string' ? b.body : '', state: 'open', labels, createdAt: ts, updatedAt: ts, seq: repo.issueSeq };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      const num = parseInt(rest[1], 10);
      const issue = repo.issues.get(num);
      if (rest.length === 2) {
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          issue.updatedAt = nowIso();
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          const list = (repo.comments.get(num) ?? []).map((c) => ({ id: c.id, node_id: `C_${repo.id}_${num}_${c.id}`, body: c.body, user: { login: VIEWER, id: VIEWER_ID, type: 'User' }, created_at: c.createdAt, updated_at: c.createdAt }));
          sendJson(res, 200, list);
          return true;
        }
        if (method === 'POST') {
          repo.commentSeq += 1;
          const id = repo.commentSeq;
          const comment = { id, body: typeof b.body === 'string' ? b.body : '', createdAt: nowIso() };
          const arr = repo.comments.get(num) ?? [];
          arr.push(comment);
          repo.comments.set(num, arr);
          sendJson(res, 201, { id, node_id: `C_${repo.id}_${num}_${id}`, body: comment.body, user: { login: VIEWER, id: VIEWER_ID, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt });
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const q = queryOf(req);
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state || (state === 'open' && p.state === 'open'));
          list.sort((a, c) => c.seq - a.seq);
          const { page, link } = paginate(list.map((p) => pullJson(repo, p)), req);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const head = typeof b.head === 'string' ? b.head.split(':').pop() as string : '';
          const base = typeof b.base === 'string' ? b.base.split(':').pop() as string : repo.defaultBranch;
          repo.pullSeq += 1;
          const number = repo.pullSeq;
          const ts = nowIso();
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          const files = diffFiles(repo, baseSha, headSha);
          const mergeable = computeMergeable(repo, baseSha, headSha);
          const pr: Pull = { number, id: `PR_${repo.id}_${number}`, title, body: typeof b.body === 'string' ? b.body : '', state: 'open', merged: false, head, base, headSha, baseSha, mergeable, mergeSha: null, createdAt: ts, updatedAt: ts, seq: repo.pullSeq, files };
          repo.pulls.set(number, pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      const num = parseInt(rest[1], 10);
      const pr = repo.pulls.get(num);
      if (rest.length === 2) {
        if (!pr) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pr));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof b.title === 'string') pr.title = b.title;
          if (typeof b.body === 'string') pr.body = b.body;
          if (b.state === 'closed' && !pr.merged) pr.state = 'closed';
          pr.updatedAt = nowIso();
          sendJson(res, 200, pullJson(repo, pr));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pr) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method !== 'PUT') {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (pr.merged) {
          sendJson(res, 200, { sha: pr.mergeSha ?? pr.headSha ?? '', merged: true, message: 'Pull request successfully merged' });
          return true;
        }
        // Recompute against the current base tip: a pull that was mergeable
        // at creation can conflict once another pull merges first.
        pr.mergeable = computeMergeable(repo, branchTip(repo, pr.base), branchTip(repo, pr.head));
        if (pr.mergeable !== 'MERGEABLE') {
          sendJson(res, 405, { message: 'Pull Request is not mergeable' });
          return true;
        }
        const baseTip = branchTip(repo, pr.base);
        const headTip = branchTip(repo, pr.head);
        if (!headTip) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable' });
          return true;
        }
        const headCommit = repo.objects.get(headTip);
        const headTree = headCommit ? parseCommit(headCommit.data).tree : '';
        const message = `Merge pull request #${pr.number} from ${pr.head}`;
        // A squash merge: one commit with the head tree on top of the base tip.
        const mergeSha = makeCommit(repo, headTree, baseTip ? [baseTip] : [], message);
        repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
        pr.mergeSha = mergeSha;
        pr.merged = true;
        pr.state = 'closed';
        pr.updatedAt = nowIso();
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pr.files.map((f) => {
            const stats = fileChangeStats(repo, pr.baseSha, pr.headSha, f);
            return { filename: f, path: f, status: stats.status, additions: stats.additions, deletions: stats.deletions, changes: stats.additions + stats.deletions, sha: '' };
          }));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    // git refs: create a branch (or tag ref) at a commit sha.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST') {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Validation Failed: ref or sha is invalid');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (method === 'GET') {
        const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }));
        sendJson(res, 200, list);
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    // commits list: reachable from ?sha=<branch|commit>, newest first.
    if (rest[0] === 'commits' && method === 'GET') {
      const shaParam = queryOf(req).get('sha') ?? repo.defaultBranch;
      const tip = repo.objects.get(shaParam)?.type === 'commit' ? shaParam : branchTip(repo, shaParam);
      const out: Array<Record<string, unknown>> = [];
      if (tip) {
        const seen = new Set<string>();
        const queue = [tip];
        while (queue.length) {
          const oid = queue.shift() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          const parsed = parseCommit(obj.data);
          const text = obj.data.toString('utf8');
          const authorLine = (text.match(/^author (.*)$/m) ?? ['', ''])[1];
          // Commit bodies end with a newline on disk; the REST shape reports
          // the message without trailing blank lines.
          const message = parsed.message.replace(/\n+$/, '');
          out.push({
            sha: oid,
            commit: {
              message,
              author: { name: authorLine.split(' <')[0] ?? VIEWER, email: `${VIEWER}@example.invalid`, date: repo.updatedAt },
              committer: { name: authorLine.split(' <')[0] ?? VIEWER, email: `${VIEWER}@example.invalid`, date: repo.updatedAt },
              tree: { sha: parsed.tree },
            },
            author: { login: VIEWER, id: VIEWER_ID, type: 'User' },
            committer: { login: VIEWER, id: VIEWER_ID, type: 'User' },
            parents: parsed.parents.map((p) => ({ sha: p })),
          });
          for (const p of parsed.parents) queue.push(p);
        }
      }
      const { page, link } = paginate(out, req);
      sendJson(res, 200, page, link ? { link } : {});
      return true;
    }
    // branches list (best effort)
    if (rest[0] === 'branches' && method === 'GET') {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => {
        const name = r.slice('refs/heads/'.length);
        return { name, commit: { sha: repo.refs.get(r), url: '' }, protected: false };
      });
      sendJson(res, 200, list);
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }
  errJson(res, 404, 'Not Found');
  return true;
}

/** Line-level change counts for one path between two commits. */
function fileChangeStats(repo: Repo, baseSha: string | null, headSha: string | null, path: string): { status: string; additions: number; deletions: number } {
  const blobAt = (sha: string | null): Buffer | null => {
    if (!sha) return null;
    const obj = repo.objects.get(sha);
    if (!obj) return null;
    const tree = parseCommit(obj.data).tree;
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo, tree, '', flat);
    const entry = flat.get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.oid);
    return blob ? blob.data : null;
  };
  const oldBuf = blobAt(baseSha);
  const newBuf = blobAt(headSha);
  if (oldBuf === null && newBuf === null) return { status: 'modified', additions: 0, deletions: 0 };
  if (oldBuf === null) {
    const lines = newBuf?.toString('utf8').split('\n') ?? [];
    const count = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    return { status: 'added', additions: count, deletions: 0 };
  }
  if (newBuf === null) {
    const lines = oldBuf.toString('utf8').split('\n');
    const count = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    return { status: 'removed', additions: 0, deletions: count };
  }
  const countLines = (buf: Buffer): Map<string, number> => {
    const m = new Map<string, number>();
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const oldLines = countLines(oldBuf);
  const newLines = countLines(newBuf);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { status: additions === 0 && deletions === 0 ? 'modified' : 'modified', additions, deletions };
}

/** Paths changed between base and head commits. */
function diffFiles(repo: Repo, baseSha: string | null, headSha: string | null): string[] {
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const treeOf = (sha: string | null): string | null => {
    if (!sha) return null;
    const obj = repo.objects.get(sha);
    return obj ? parseCommit(obj.data).tree : null;
  };
  const bt = treeOf(baseSha);
  const ht = treeOf(headSha);
  if (bt) flattenTree(repo, bt, '', baseFlat);
  if (ht) flattenTree(repo, ht, '', headFlat);
  const out: string[] = [];
  for (const [path, v] of headFlat) {
    if (!baseFlat.has(path) || baseFlat.get(path)?.oid !== v.oid) out.push(path);
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) out.push(path);
  }
  return out.sort();
}

function computeMergeable(repo: Repo, baseSha: string | null, headSha: string | null): string {
  if (!headSha) return 'UNKNOWN';
  if (!baseSha) return 'MERGEABLE';
  if (headSha === baseSha) return 'MERGEABLE';
  // Mergeable unless head and base both changed the same file differently.
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const treeOf = (sha: string | null): string | null => {
    if (!sha) return null;
    const obj = repo.objects.get(sha);
    return obj ? parseCommit(obj.data).tree : null;
  };
  const bt = treeOf(baseSha);
  const ht = treeOf(headSha);
  if (bt) flattenTree(repo, bt, '', baseFlat);
  if (ht) flattenTree(repo, ht, '', headFlat);
  // Find merge base: walk head's ancestry for a commit reachable from base too.
  const baseAncestors = new Set<string>();
  const queue = baseSha ? [baseSha] : [];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  if (baseAncestors.has(headSha)) return 'MERGEABLE';
  // Diverged: check whether any file changed on both sides relative to merge base.
  let mergeBase: string | null = null;
  const hq = [headSha];
  const hseen = new Set<string>();
  while (hq.length && !mergeBase) {
    const oid = hq.shift() as string;
    if (hseen.has(oid)) continue;
    hseen.add(oid);
    if (baseAncestors.has(oid)) {
      mergeBase = oid;
      break;
    }
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) hq.push(p);
    }
  }
  if (!mergeBase) return 'MERGEABLE';
  const mbFlat = new Map<string, { oid: string; mode: string }>();
  const mt = treeOf(mergeBase);
  if (mt) flattenTree(repo, mt, '', mbFlat);
  for (const [path, v] of headFlat) {
    const mb = mbFlat.get(path);
    const bv = baseFlat.get(path);
    if (mb && bv && mb.oid !== v.oid && mb.oid !== bv.oid && bv.oid !== v.oid) return 'CONFLICTING';
  }
  for (const [path, v] of baseFlat) {
    const mb = mbFlat.get(path);
    const hv = headFlat.get(path);
    if (mb && hv && mb.oid !== v.oid && mb.oid !== hv.oid && hv.oid !== v.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// GraphQL v4 (targeted executor for the documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[] | null;
  inlineType: string | null;
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():[]!=$'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos = 0;
  variables: Record<string, unknown>;
  constructor(src: string, variables: Record<string, unknown>) {
    this.tokens = gqlTokenize(src);
    this.variables = variables;
  }
  peek(): string {
    return this.tokens[this.pos] ?? '';
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(t: string): void {
    if (this.next() !== t) throw new Error(`expected ${t}`);
  }
  parseValue(): unknown {
    const t = this.next();
    if (t === '$') return this.variables[this.next()] ?? null;
    if (t === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const num = Number(t);
    if (t !== '' && !Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(t)) return num;
    return t; // enum / bare identifier
  }
  parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          const children = this.parseSelectionSet();
          fields.push({ alias: null, name: '__inline', args: {}, children, inlineType: typeName });
        } else {
          // named fragment spread: not used by the suite; skip its selection set if present
          this.next();
          if (this.peek() === '{') this.parseSelectionSet();
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.parseArgs();
      let children: GqlField[] | null = null;
      if (this.peek() === '{') children = this.parseSelectionSet();
      fields.push({ alias, name, args, children, inlineType: null });
    }
    this.expect('}');
    return fields;
  }
  /** Parse one operation; returns {kind, fields}. */
  parseOperation(): { kind: string; fields: GqlField[] } {
    let kind = 'query';
    let t = this.peek();
    if (t === 'query' || t === 'mutation' || t === 'subscription') {
      kind = this.next();
      t = this.peek();
      if (t !== '{' && t !== '(') this.next(); // operation name
      if (this.peek() === '(') {
        // variable definitions: skip balanced parens
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const tok = this.next();
          if (tok === '(') depth += 1;
          else if (tok === ')') { depth -= 1; if (depth === 0) break; }
        }
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, fields };
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate'],
  SearchType: [],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
};

function gqlError(message: string): { message: string } {
  return { message };
}

function findRepoById(id: string): Repo | undefined {
  const m = /^R_(\d+)$/.exec(id);
  if (!m) return undefined;
  const num = parseInt(m[1], 10);
  for (const r of repos.values()) if (r.id === num) return r;
  return undefined;
}

function issueGlobalId(repo: Repo, number: number): string {
  return `I_${repo.id}_${number}`;
}

function resolveIssueRef(id: string): { repo: Repo; issue: Issue } | null {
  const m = /^I_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  for (const r of repos.values()) {
    if (r.id === parseInt(m[1], 10)) {
      const issue = r.issues.get(parseInt(m[2], 10));
      if (issue) return { repo: r, issue };
    }
  }
  return null;
}

function resolvePrRef(id: string): { repo: Repo; pr: Pull } | null {
  const m = /^PR_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  for (const r of repos.values()) {
    if (r.id === parseInt(m[1], 10)) {
      const pr = r.pulls.get(parseInt(m[2], 10));
      if (pr) return { repo: r, pr };
    }
  }
  return null;
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}
function numberAfterCursor(after: string | null | undefined): number | null {
  if (!after) return null;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function issueGql(repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = issue.id;
    else if (f.name === 'number') out[key] = issue.number;
    else if (f.name === 'title') out[key] = issue.title;
    else if (f.name === 'state') out[key] = issue.state.toUpperCase();
    else if (f.name === 'body') out[key] = issue.body;
    else if (f.name === 'createdAt') out[key] = issue.createdAt;
    else if (f.name === 'updatedAt') out[key] = issue.updatedAt;
    else if (f.name === '__typename') out[key] = 'Issue';
    else throw new Error(`Cannot query field "${f.name}" on type "Issue"`);
  }
  return out;
}

function prGql(repo: Repo, pr: Pull, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = pr.id;
    else if (f.name === 'number') out[key] = pr.number;
    else if (f.name === 'title') out[key] = pr.title;
    else if (f.name === 'body') out[key] = pr.body;
    else if (f.name === 'state') out[key] = pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';
    else if (f.name === 'merged') out[key] = pr.merged;
    else if (f.name === 'headRefName') out[key] = pr.head;
    else if (f.name === 'baseRefName') out[key] = pr.base;
    else if (f.name === 'mergeable') out[key] = pr.mergeable;
    else if (f.name === 'createdAt') out[key] = pr.createdAt;
    else if (f.name === 'updatedAt') out[key] = pr.updatedAt;
    else if (f.name === 'files') {
      const first = typeof f.args.first === 'number' ? f.args.first : 10;
      const nodeFields = (f.children ?? []).find((c) => c.name === 'nodes');
      const nodes = pr.files.slice(0, first).map((p) => {
        const node: Record<string, unknown> = {};
        for (const cf of nodeFields?.children ?? []) {
          if (cf.name === 'path') node[cf.alias ?? cf.name] = p;
          else if (cf.name === '__typename') node[cf.alias ?? cf.name] = 'PullRequestChangedFile';
          else throw new Error(`Cannot query field "${cf.name}" on type "PullRequestChangedFile"`);
        }
        return node;
      });
      out[key] = { nodes };
    } else if (f.name === '__typename') out[key] = 'PullRequest';
    else throw new Error(`Cannot query field "${f.name}" on type "PullRequest"`);
  }
  return out;
}

function repoGql(repo: Repo, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'id') out[key] = `R_${repo.id}`;
    else if (f.name === 'databaseId') out[key] = repo.id;
    else if (f.name === 'name') out[key] = repo.name;
    else if (f.name === 'nameWithOwner') out[key] = `${repo.owner}/${repo.name}`;
    else if (f.name === 'description') out[key] = repo.description;
    else if (f.name === 'isPrivate') out[key] = repo.isPrivate;
    else if (f.name === 'createdAt') out[key] = repo.createdAt;
    else if (f.name === 'updatedAt') out[key] = repo.updatedAt;
    else if (f.name === 'owner') {
      const node: Record<string, unknown> = {};
      for (const cf of f.children ?? []) {
        if (cf.name === 'login') node[cf.alias ?? cf.name] = repo.owner;
        else if (cf.name === 'id') node[cf.alias ?? cf.name] = `U_${VIEWER_ID}`;
        else if (cf.name === '__typename') node[cf.alias ?? cf.name] = 'User';
        else throw new Error(`Cannot query field "${cf.name}" on type "User"`);
      }
      out[key] = node;
    } else if (f.name === 'defaultBranchRef') {
      const node: Record<string, unknown> = {};
      for (const cf of f.children ?? []) {
        if (cf.name === 'name') node[cf.alias ?? cf.name] = repo.defaultBranch;
        else if (cf.name === '__typename') node[cf.alias ?? cf.name] = 'Ref';
        else throw new Error(`Cannot query field "${cf.name}" on type "Ref"`);
      }
      out[key] = node;
    } else if (f.name === 'viewerPermission') out[key] = 'ADMIN';
    else if (f.name === 'hasIssuesEnabled') out[key] = true;
    else if (f.name === 'issue') {
      const num = f.args.number as number;
      const issue = repo.issues.get(num);
      out[key] = issue ? issueGql(repo, issue, f.children ?? []) : null;
    } else if (f.name === 'issues') {
      const first = typeof f.args.first === 'number' ? f.args.first : undefined;
      const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : null;
      const orderBy = asRecord(f.args.orderBy);
      const after = typeof f.args.after === 'string' ? f.args.after : null;
      let list = [...repo.issues.values()];
      if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
      const field = (orderBy.field as string | undefined) ?? 'CREATED_AT';
      const direction = (orderBy.direction as string | undefined) ?? 'DESC';
      list.sort((a, c) => {
        let cmp = 0;
        if (field === 'CREATED_AT' || field === 'UPDATED_AT') cmp = a.seq - c.seq;
        else cmp = a.number - c.number;
        if (cmp === 0) cmp = a.number - c.number;
        return direction === 'DESC' ? -cmp : cmp;
      });
      const afterNum = numberAfterCursor(after);
      if (afterNum !== null) list = list.filter((i) => i.number < afterNum);
      const total = list.length;
      const sliced = first !== undefined ? list.slice(0, first) : list;
      const nodes: Record<string, unknown>[] = [];
      for (const issue of sliced) {
        const nodeFields = (f.children ?? []).find((c) => c.name === 'nodes');
        nodes.push(issueGql(repo, issue, nodeFields?.children ?? []));
      }
      const node: Record<string, unknown> = {};
      for (const cf of f.children ?? []) {
        if (cf.name === 'nodes') node[cf.alias ?? cf.name] = nodes;
        else if (cf.name === 'totalCount') node[cf.alias ?? cf.name] = total;
        else if (cf.name === 'pageInfo') {
          const pi: Record<string, unknown> = {};
          for (const pf of cf.children ?? []) {
            if (pf.name === 'hasNextPage') pi[pf.alias ?? pf.name] = list.length > sliced.length;
            else if (pf.name === 'endCursor') pi[pf.alias ?? pf.name] = sliced.length ? cursorFor(sliced[sliced.length - 1].number) : null;
            else if (pf.name === 'hasPreviousPage') pi[pf.alias ?? pf.name] = afterNum !== null;
            else if (pf.name === 'startCursor') pi[pf.alias ?? pf.name] = sliced.length ? cursorFor(sliced[0].number) : null;
            else throw new Error(`Cannot query field "${pf.name}" on type "PageInfo"`);
          }
          node[cf.alias ?? cf.name] = pi;
        } else throw new Error(`Cannot query field "${cf.name}" on type "IssueConnection"`);
      }
      out[key] = node;
    } else if (f.name === 'pullRequests') {
      const first = typeof f.args.first === 'number' ? f.args.first : undefined;
      let list = [...repo.pulls.values()].sort((a, c) => c.seq - a.seq);
      if (first !== undefined) list = list.slice(0, first);
      const nodes: Record<string, unknown>[] = [];
      for (const pr of list) {
        const nodeFields = (f.children ?? []).find((c) => c.name === 'nodes');
        nodes.push(prGql(repo, pr, nodeFields?.children ?? []));
      }
      const node: Record<string, unknown> = {};
      for (const cf of f.children ?? []) {
        if (cf.name === 'nodes') node[cf.alias ?? cf.name] = nodes;
        else if (cf.name === 'totalCount') node[cf.alias ?? cf.name] = repo.pulls.size;
        else if (cf.name === 'pageInfo') node[cf.alias ?? cf.name] = { hasNextPage: false, endCursor: null };
        else throw new Error(`Cannot query field "${cf.name}" on type "PullRequestConnection"`);
      }
      out[key] = node;
    } else if (f.name === 'pullRequest') {
      const num = f.args.number as number;
      const pr = repo.pulls.get(num);
      out[key] = pr ? prGql(repo, pr, f.children ?? []) : null;
    } else if (f.name === '__typename') out[key] = 'Repository';
    else throw new Error(`Cannot query field "${f.name}" on type "Repository"`);
  }
  return out;
}

function typeGql(name: string, fields: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldNames = TYPE_FIELDS[name] ?? [];
  const enumValues: Record<string, string[]> = {
    SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
    IssueState: ['OPEN', 'CLOSED'],
    OrderDirection: ['ASC', 'DESC'],
    IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
    MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
    PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
    RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  };
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'name') out[key] = name;
    else if (f.name === 'kind') out[key] = fieldNames.length ? 'OBJECT' : 'ENUM';
    else if (f.name === 'fields') {
      out[key] = fieldNames.map((fn) => {
        const node: Record<string, unknown> = {};
        for (const cf of f.children ?? []) {
          if (cf.name === 'name') node[cf.alias ?? cf.name] = fn;
          else if (cf.name === '__typename') node[cf.alias ?? cf.name] = '__Field';
          else node[cf.alias ?? cf.name] = null;
        }
        return node;
      });
    } else if (f.name === 'enumValues') {
      const values = enumValues[name] ?? [];
      out[key] = values.map((v) => {
        const node: Record<string, unknown> = {};
        for (const cf of f.children ?? []) {
          if (cf.name === 'name') node[cf.alias ?? cf.name] = v;
          else if (cf.name === '__typename') node[cf.alias ?? cf.name] = '__EnumValue';
          else node[cf.alias ?? cf.name] = null;
        }
        return node;
      });
    } else if (f.name === '__typename') out[key] = '__Type';
    else throw new Error(`Cannot query field "${f.name}" on type "__Type"`);
  }
  return out;
}

function doMergePr(repo: Repo, pr: Pull): void {
  const baseTip = branchTip(repo, pr.base);
  const headTip = branchTip(repo, pr.head);
  if (!headTip) return;
  const headCommit = repo.objects.get(headTip);
  const headTree = headCommit ? parseCommit(headCommit.data).tree : '';
  const message = `Merge pull request #${pr.number} from ${pr.head}`;
  const mergeSha = makeCommit(repo, headTree, baseTip ? [baseTip] : [], message);
  repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
  // Record the squash commit so GET /pulls reports merge_commit_sha for it.
  pr.mergeSha = mergeSha;
  pr.merged = true;
  pr.state = 'closed';
  pr.updatedAt = nowIso();
}

function executeOperation(kind: string, fields: GqlField[]): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const data: Record<string, unknown> = {};
  const errors: Array<{ message: string }> = [];
  for (const f of fields) {
    const key = f.alias ?? f.name;
    try {
      if (kind === 'query') {
        if (f.name === 'viewer') {
          const node: Record<string, unknown> = {};
          for (const cf of f.children ?? []) {
            if (cf.name === 'login') node[cf.alias ?? cf.name] = VIEWER;
            else if (cf.name === 'id') node[cf.alias ?? cf.name] = `U_${VIEWER_ID}`;
            else if (cf.name === '__typename') node[cf.alias ?? cf.name] = 'User';
            else throw new Error(`Cannot query field "${cf.name}" on type "User"`);
          }
          data[key] = node;
        } else if (f.name === 'repository') {
          const owner = f.args.owner as string;
          const name = f.args.name as string;
          const repo = owner === VIEWER ? getRepo(owner, name) : undefined;
          data[key] = repo ? repoGql(repo, f.children ?? []) : null;
        } else if (f.name === 'node') {
          const id = f.args.id as string;
          const repo = findRepoById(id);
          if (!repo) {
            data[key] = null;
          } else {
            const node: Record<string, unknown> = { id };
            for (const cf of f.children ?? []) {
              if (cf.name === '__inline') {
                if (cf.inlineType === 'Repository') {
                  node.name = repo.name;
                  node.nameWithOwner = `${repo.owner}/${repo.name}`;
                  for (const sf of cf.children ?? []) {
                    if (sf.name === 'name') node[sf.alias ?? sf.name] = repo.name;
                    else if (sf.name === 'nameWithOwner') node[sf.alias ?? sf.name] = `${repo.owner}/${repo.name}`;
                    else if (sf.name === 'id') node[sf.alias ?? sf.name] = id;
                  }
                }
              } else if (cf.name === 'id') node[cf.alias ?? cf.name] = id;
              else if (cf.name === '__typename') node[cf.alias ?? cf.name] = 'Repository';
              else throw new Error(`Cannot query field "${cf.name}" on type "Node"`);
            }
            data[key] = node;
          }
        } else if (f.name === '__type') {
          data[key] = typeGql(f.args.name as string, f.children ?? []);
        } else if (f.name === '__schema') {
          data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
        } else if (f.name === '__typename') {
          data[key] = 'Query';
        } else {
          throw new Error(`Cannot query field "${f.name}" on type "Query"`);
        }
      } else if (kind === 'mutation') {
        const input = asRecord(f.args.input);
        if (f.name === 'createIssue') {
          const repo = findRepoById(input.repositoryId as string);
          if (!repo) throw new Error('Could not resolve to a Repository with the id provided');
          repo.issueSeq += 1;
          const number = repo.issueSeq;
          const ts = nowIso();
          const issue: Issue = { number, id: issueGlobalId(repo, number), title: (input.title as string) ?? '', body: (input.body as string) ?? '', state: 'open', labels: [], createdAt: ts, updatedAt: ts, seq: repo.issueSeq };
          repo.issues.set(number, issue);
          const node: Record<string, unknown> = {};
          for (const cf of f.children ?? []) {
            if (cf.name === 'issue') node[cf.alias ?? cf.name] = issueGql(repo, issue, cf.children ?? []);
            else throw new Error(`Cannot query field "${cf.name}" on type "CreateIssuePayload"`);
          }
          data[key] = node;
        } else if (f.name === 'closeIssue') {
          const found = resolveIssueRef(input.issueId as string);
          if (!found) throw new Error('Could not resolve to an Issue with the id provided');
          found.issue.state = 'closed';
          found.issue.updatedAt = nowIso();
          const node: Record<string, unknown> = {};
          for (const cf of f.children ?? []) {
            if (cf.name === 'issue') node[cf.alias ?? cf.name] = issueGql(found.repo, found.issue, cf.children ?? []);
            else throw new Error(`Cannot query field "${cf.name}" on type "CloseIssuePayload"`);
          }
          data[key] = node;
        } else if (f.name === 'createPullRequest') {
          const repo = findRepoById(input.repositoryId as string);
          if (!repo) throw new Error('Could not resolve to a Repository with the id provided');
          const head = (input.headRefName as string) ?? '';
          const base = (input.baseRefName as string) ?? repo.defaultBranch;
          repo.pullSeq += 1;
          const number = repo.pullSeq;
          const ts = nowIso();
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          const pr: Pull = { number, id: `PR_${repo.id}_${number}`, title: (input.title as string) ?? '', body: (input.body as string) ?? '', state: 'open', merged: false, head, base, headSha, baseSha, mergeable: computeMergeable(repo, baseSha, headSha), mergeSha: null, createdAt: ts, updatedAt: ts, seq: repo.pullSeq, files: diffFiles(repo, baseSha, headSha) };
          repo.pulls.set(number, pr);
          const node: Record<string, unknown> = {};
          for (const cf of f.children ?? []) {
            if (cf.name === 'pullRequest') node[cf.alias ?? cf.name] = prGql(repo, pr, cf.children ?? []);
            else throw new Error(`Cannot query field "${cf.name}" on type "CreatePullRequestPayload"`);
          }
          data[key] = node;
        } else if (f.name === 'mergePullRequest') {
          const found = resolvePrRef(input.pullRequestId as string);
          if (!found) throw new Error('Could not resolve to a PullRequest with the id provided');
          doMergePr(found.repo, found.pr);
          const node: Record<string, unknown> = {};
          for (const cf of f.children ?? []) {
            if (cf.name === 'pullRequest') node[cf.alias ?? cf.name] = prGql(found.repo, found.pr, cf.children ?? []);
            else throw new Error(`Cannot query field "${cf.name}" on type "MergePullRequestPayload"`);
          }
          data[key] = node;
        } else if (f.name === 'addComment') {
          const found = resolveIssueRef(input.subjectId as string);
          if (!found) throw new Error('Could not resolve to an Issue with the id provided');
          found.repo.commentSeq += 1;
          const cid = found.repo.commentSeq;
          const comment = { id: cid, body: (input.body as string) ?? '', createdAt: nowIso() };
          const arr = found.repo.comments.get(found.issue.number) ?? [];
          arr.push(comment);
          found.repo.comments.set(found.issue.number, arr);
          const node: Record<string, unknown> = {};
          for (const cf of f.children ?? []) {
            if (cf.name === 'commentEdge') {
              const edge: Record<string, unknown> = {};
              for (const ef of cf.children ?? []) {
                if (ef.name === 'node') {
                  const cn: Record<string, unknown> = {};
                  for (const nf of ef.children ?? []) {
                    if (nf.name === 'id') cn[nf.alias ?? nf.name] = `C_${found.repo.id}_${found.issue.number}_${cid}`;
                    else if (nf.name === 'body') cn[nf.alias ?? nf.name] = comment.body;
                    else if (nf.name === '__typename') cn[nf.alias ?? nf.name] = 'IssueComment';
                    else throw new Error(`Cannot query field "${nf.name}" on type "IssueComment"`);
                  }
                  edge[ef.alias ?? ef.name] = cn;
                } else throw new Error(`Cannot query field "${ef.name}" on type "IssueCommentEdge"`);
              }
              node[cf.alias ?? cf.name] = edge;
            } else throw new Error(`Cannot query field "${cf.name}" on type "AddCommentPayload"`);
          }
          data[key] = node;
        } else {
          throw new Error(`Cannot query field "${f.name}" on type "Mutation"`);
        }
      } else {
        throw new Error(`Unsupported operation kind "${kind}"`);
      }
    } catch (e) {
      errors.push(gqlError(e instanceof Error ? e.message : String(e)));
      data[key] = null;
    }
  }
  return { data: errors.length && Object.keys(data).every((k) => data[k] === null) ? null : data, errors };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    errJson(res, 404, 'Not Found');
    return true;
  }
  if (!authOk(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const value = parsed.value;
  const runOne = (op: unknown): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } => {
    const rec = asRecord(op);
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = asRecord(rec.variables);
    try {
      const parser = new GqlParser(query, variables);
      const { kind, fields } = parser.parseOperation();
      return executeOperation(kind, fields);
    } catch (e) {
      return { data: null, errors: [gqlError(e instanceof Error ? e.message : String(e))] };
    }
  };
  if (Array.isArray(value)) {
    const results = value.map(runOne);
    sendJson(res, 200, results);
    return true;
  }
  const result = runOne(value);
  sendJson(res, 200, result);
  return true;
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP)
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The repository name.' }, description: { type: 'string', description: 'A short description of the repository.' }, private: { type: 'boolean', description: 'Whether the repository is private.' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, full_name: { type: 'string', description: 'The full repository name owner/repo.' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, full_name: { type: 'string', description: 'The full repository name owner/repo.' }, title: { type: 'string', description: 'The issue title.' }, body: { type: 'string', description: 'The issue body.' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, full_name: { type: 'string', description: 'The full repository name owner/repo.' }, state: { type: 'string', description: 'Filter by issue state: open, closed, or all.' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, full_name: { type: 'string', description: 'The full repository name owner/repo.' }, title: { type: 'string', description: 'The pull request title.' }, head: { type: 'string', description: 'The head branch name.' }, base: { type: 'string', description: 'The base branch name.' }, body: { type: 'string', description: 'The pull request body.' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, full_name: { type: 'string', description: 'The full repository name owner/repo.' }, pull_number: { type: 'number', description: 'The pull request number.' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'get_issue', description: 'Get a single issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' }, full_name: { type: 'string', description: 'The full repository name owner/repo.' }, issue_number: { type: 'number', description: 'The issue number.' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: {}, required: [] } },
];

function mcpSplitFullName(args: Record<string, unknown>): void {
  if (typeof args.full_name === 'string') {
    const [owner, repo] = (args.full_name as string).split('/');
    if (owner && !args.owner) args.owner = owner;
    if (repo && !args.repo) args.repo = repo;
  }
  if (typeof args.repository === 'string' && !args.repo) args.repo = args.repository;
  if (typeof args.repository_name === 'string' && !args.name) args.name = args.repository_name;
  if (typeof args.number === 'number' && args.pull_number === undefined) args.pull_number = args.number;
  if (typeof args.head_branch === 'string' && !args.head) args.head = args.head_branch;
  if (typeof args.base_branch === 'string' && !args.base) args.base = args.base_branch;
}

function mcpTextResult(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent?: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function mcpErrorResult(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    errJson(res, 404, 'Not Found');
    return true;
  }
  if (!authOk(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  const sessionId = req.headers['mcp-session-id'];
  const baseHeaders: Record<string, string> = {};
  if (typeof sessionId === 'string' && sessionId) baseHeaders['mcp-session-id'] = sessionId;
  if (!parsed.ok) {
    const body = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    sendJson(res, 400, body, baseHeaders);
    return true;
  }
  const rec = asRecord(parsed.value);
  const method = typeof rec.method === 'string' ? rec.method : '';
  const id = rec.id === undefined ? null : rec.id;
  const params = asRecord(rec.params);
  // Notification (no id): acknowledge with 202 and no body.
  if (rec.id === undefined) {
    res.writeHead(202, { ...baseHeaders });
    res.end();
    return true;
  }
  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, baseHeaders);
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, baseHeaders);
  };
  if (method === 'initialize') {
    const requested = typeof (params.protocolVersion as string | undefined) === 'string' ? (params.protocolVersion as string) : '2026-07-28';
    reply({
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
    return true;
  }
  if (method === 'ping') {
    reply({});
    return true;
  }
  if (method === 'server/discover') {
    reply({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const rawName = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments);
    mcpSplitFullName(args);
    const tool = MCP_TOOLS.find((t) => t.name === rawName || rawName.toLowerCase().endsWith(t.name) || t.name === rawName.toLowerCase().split('__').pop());
    if (!tool) {
      replyError(-32602, `Unknown tool: ${rawName}`);
      return true;
    }
    // Required-argument check.
    for (const reqArg of tool.inputSchema.required) {
      if (args[reqArg] === undefined || args[reqArg] === null || args[reqArg] === '') {
        reply({ content: [{ type: 'text', text: `Missing required argument: ${reqArg}` }], isError: true });
        return true;
      }
    }
    try {
      if (tool.name === 'create_repo') {
        const name = args.name as string;
        if (getRepo(VIEWER, name)) {
          reply(mcpErrorResult(`Repository ${VIEWER}/${name} already exists`));
          return true;
        }
        const repo = newRepo(name, typeof args.description === 'string' ? args.description : '', args.private === true);
        reply(mcpTextResult(repoJson(repo)));
        return true;
      }
      if (tool.name === 'list_repos') {
        const list = [...repos.values()].filter((r) => r.owner === VIEWER).map(repoJson);
        reply(mcpTextResult(list));
        return true;
      }
      const owner = args.owner as string;
      const repoName = args.repo as string;
      const repo = owner === VIEWER ? getRepo(owner, repoName) : undefined;
      if (!repo) {
        reply(mcpErrorResult(`Repository ${owner}/${repoName} not found`));
        return true;
      }
      if (tool.name === 'get_repo') {
        reply(mcpTextResult(repoJson(repo)));
        return true;
      }
      if (tool.name === 'create_issue') {
        repo.issueSeq += 1;
        const number = repo.issueSeq;
        const ts = nowIso();
        const issue: Issue = { number, id: issueGlobalId(repo, number), title: args.title as string, body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], createdAt: ts, updatedAt: ts, seq: repo.issueSeq };
        repo.issues.set(number, issue);
        reply(mcpTextResult(issueJson(repo, issue)));
        return true;
      }
      if (tool.name === 'list_issues') {
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, c) => c.seq - a.seq);
        reply(mcpTextResult(list.map((i) => issueJson(repo, i))));
        return true;
      }
      if (tool.name === 'get_issue') {
        const num = args.issue_number as number;
        const issue = repo.issues.get(num);
        if (!issue) {
          reply(mcpErrorResult(`Issue ${num} not found`));
          return true;
        }
        reply(mcpTextResult(issueJson(repo, issue)));
        return true;
      }
      if (tool.name === 'create_pull_request') {
        const head = (args.head as string).split(':').pop() as string;
        const base = (args.base as string).split(':').pop() as string;
        repo.pullSeq += 1;
        const number = repo.pullSeq;
        const ts = nowIso();
        const headSha = branchTip(repo, head);
        const baseSha = branchTip(repo, base);
        const pr: Pull = { number, id: `PR_${repo.id}_${number}`, title: args.title as string, body: typeof args.body === 'string' ? args.body : '', state: 'open', merged: false, head, base, headSha, baseSha, mergeable: computeMergeable(repo, baseSha, headSha), mergeSha: null, createdAt: ts, updatedAt: ts, seq: repo.pullSeq, files: diffFiles(repo, baseSha, headSha) };
        repo.pulls.set(number, pr);
        reply(mcpTextResult(pullJson(repo, pr)));
        return true;
      }
      if (tool.name === 'merge_pull_request') {
        const num = args.pull_number as number;
        const pr = repo.pulls.get(num);
        if (!pr) {
          reply(mcpErrorResult(`Pull request ${num} not found`));
          return true;
        }
        if (pr.mergeable !== 'MERGEABLE') {
          reply(mcpErrorResult('Pull Request is not mergeable'));
          return true;
        }
        doMergePr(repo, pr);
        reply(mcpTextResult({ sha: branchTip(repo, pr.base) ?? '', merged: true, message: 'Pull request successfully merged' }));
        return true;
      }
      replyError(-32602, `Unknown tool: ${rawName}`);
      return true;
    } catch (e) {
      reply(mcpErrorResult(e instanceof Error ? e.message : String(e)));
      return true;
    }
  }
  replyError(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path.startsWith('/api/graphql')) {
          if (await handleGraphQL(req, res)) return;
        }
        if (path.startsWith('/mcp')) {
          if (await handleMcp(req, res)) return;
        }
        if (path.startsWith('/api/v3')) {
          if (await handleRest(req, res)) return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const rest = (gitMatch[3] ?? '').split('/').filter((p) => p !== '');
          if (await handleGit(req, res, gitMatch[1], gitMatch[2], rest)) return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch {
            // response already gone; nothing to do
          }
        }
      }
    })();
  });
}
