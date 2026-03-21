/**
 * Browser Stubs for Vite Build
 *
 * Provides stub implementations of Node.js modules and server-only
 * packages for browser builds. Used by the serverOnlyStubs Vite plugin.
 *
 * @module lib/build/browser-stubs
 */

/**
 * Map of stub IDs to their code implementations
 */
export const BROWSER_STUBS: Record<string, string> = {
  // better-sqlite3 stub
  '\0better-sqlite3-stub': `
    export default class Database {
      constructor() {
        throw new Error('better-sqlite3 is only available on the server');
      }
    }
  `,

  // node:fs stub
  '\0node-fs-stub': `
    export const existsSync = () => false;
    export const mkdirSync = () => {};
    export const readFileSync = () => '';
    export const writeFileSync = () => {};
    export const appendFileSync = () => {};
    export const readdirSync = () => [];
    export const statSync = () => ({ isDirectory: () => false, mtime: new Date() });
    export const realpathSync = (p) => p;
    export const unlinkSync = () => {};
    export const rmdirSync = () => {};
    export const copyFileSync = () => {};
    export const renameSync = () => {};
    export const chmodSync = () => {};
    export const createReadStream = () => ({ pipe: () => {}, on: () => {} });
    export const createWriteStream = () => ({ write: () => {}, end: () => {}, on: () => {} });
    export const promises = {
      readFile: async () => '',
      writeFile: async () => {},
      mkdir: async () => {},
      stat: async () => ({ isDirectory: () => false, mtime: new Date() }),
      readdir: async () => [],
      unlink: async () => {},
      rmdir: async () => {},
      copyFile: async () => {},
      rename: async () => {},
      chmod: async () => {},
      realpath: async (p) => p,
      access: async () => {},
    };
    export default { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, realpathSync, unlinkSync, rmdirSync, copyFileSync, renameSync, chmodSync, createReadStream, createWriteStream, promises };
  `,

  // node:os stub
  '\0node-os-stub': `
    export const homedir = () => '/home/user';
    export const tmpdir = () => '/tmp';
    export const platform = () => 'browser';
    export const arch = () => 'wasm';
    export const cpus = () => [];
    export const hostname = () => 'browser';
    export default { homedir, tmpdir, platform, arch, cpus, hostname };
  `,

  // node:path stub
  '\0node-path-stub': `
    export const join = (...args) => args.filter(Boolean).join('/');
    export const resolve = (...args) => args.filter(Boolean).join('/');
    export const dirname = (p) => p.split('/').slice(0, -1).join('/') || '/';
    export const basename = (p, ext) => { const base = p.split('/').pop() || ''; return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base; };
    export const extname = (p) => { const m = p.match(/\\.[^.]+$/); return m ? m[0] : ''; };
    export const sep = '/';
    export const parse = (p) => ({ dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)), root: p.startsWith('/') ? '/' : '' });
    export default { join, resolve, dirname, basename, extname, sep, parse };
  `,

  // node:url stub
  '\0node-url-stub': `
    export const fileURLToPath = (url) => url.replace('file://', '');
    export const pathToFileURL = (path) => new URL('file://' + path);
    export const URL = globalThis.URL;
    export const URLSearchParams = globalThis.URLSearchParams;
    export const parse = (urlString) => new URL(urlString);
    export const format = (urlObj) => urlObj.toString();
    export default { fileURLToPath, pathToFileURL, URL, URLSearchParams, parse, format };
  `,

  // node:events stub
  '\0node-events-stub': `
    export class EventEmitter {
      constructor() { this._events = {}; }
      on(event, listener) { (this._events[event] = this._events[event] || []).push(listener); return this; }
      once(event, listener) { const fn = (...args) => { this.off(event, fn); listener(...args); }; return this.on(event, fn); }
      off(event, listener) { const arr = this._events[event]; if (arr) { const i = arr.indexOf(listener); if (i > -1) arr.splice(i, 1); } return this; }
      emit(event, ...args) { const arr = this._events[event]; if (arr) arr.forEach(fn => fn(...args)); return !!arr; }
      removeAllListeners(event) { if (event) delete this._events[event]; else this._events = {}; return this; }
      listenerCount(event) { return (this._events[event] || []).length; }
    }
    export const setMaxListeners = () => {};
    export const getMaxListeners = () => 10;
    export default EventEmitter;
  `,

  // node:crypto stub
  '\0node-crypto-stub': `
    export const randomBytes = (size) => new Uint8Array(size).map(() => Math.floor(Math.random() * 256));
    export const randomUUID = () => crypto.randomUUID();
    export const createHash = () => ({ update: () => ({ digest: () => '' }) });
    export const createHmac = () => ({ update: () => ({ digest: () => '' }) });
    export default { randomBytes, randomUUID, createHash, createHmac };
  `,

  // node:buffer stub
  '\0node-buffer-stub': `
    export const Buffer = {
      from: (data, encoding) => new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data)),
      alloc: (size) => new Uint8Array(size),
      isBuffer: () => false,
      concat: (arrays) => { const total = arrays.reduce((acc, arr) => acc + arr.length, 0); const result = new Uint8Array(total); let offset = 0; for (const arr of arrays) { result.set(arr, offset); offset += arr.length; } return result; },
    };
    export default { Buffer };
  `,

  // node:stream stub
  '\0node-stream-stub': `
    export class Readable { pipe() { return this; } on() { return this; } }
    export class Writable { write() {} end() {} on() { return this; } }
    export class Transform { pipe() { return this; } on() { return this; } }
    export class Duplex { pipe() { return this; } on() { return this; } write() {} end() {} }
    export const pipeline = (...args) => { const cb = args.pop(); cb && cb(); };
    export default { Readable, Writable, Transform, Duplex, pipeline };
  `,

  // node:util stub
  '\0node-util-stub': `
    export const promisify = (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (err, result) => err ? reject(err) : resolve(result)));
    export const inspect = (obj) => JSON.stringify(obj, null, 2);
    export const format = (...args) => args.map(String).join(' ');
    export const deprecate = (fn) => fn;
    export const inherits = (ctor, superCtor) => { ctor.super_ = superCtor; Object.setPrototypeOf(ctor.prototype, superCtor.prototype); };
    export const types = { isPromise: (v) => v instanceof Promise };
    export default { promisify, inspect, format, deprecate, inherits, types };
  `,

  // node:assert stub
  '\0node-assert-stub': `
    export const ok = (value, message) => { if (!value) throw new Error(message || 'Assertion failed'); };
    export const strictEqual = (actual, expected, message) => { if (actual !== expected) throw new Error(message || 'Assertion failed'); };
    export const deepStrictEqual = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message || 'Assertion failed'); };
    export const fail = (message) => { throw new Error(message || 'Assertion failed'); };
    export default { ok, strictEqual, deepStrictEqual, fail };
  `,

  // node:async_hooks stub
  '\0node-async_hooks-stub': `
    export class AsyncLocalStorage {
      constructor() { this._store = undefined; }
      getStore() { return this._store; }
      run(store, callback, ...args) { const prev = this._store; this._store = store; try { return callback(...args); } finally { this._store = prev; } }
      enterWith(store) { this._store = store; }
      disable() { this._store = undefined; }
    }
    export class AsyncResource {
      constructor() {}
      runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
      emitDestroy() { return this; }
    }
    export const executionAsyncId = () => 1;
    export const triggerAsyncId = () => 0;
    export const createHook = () => ({ enable: () => {}, disable: () => {} });
    export default { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId, createHook };
  `,

  // @anthropic-ai/claude-agent-sdk stub
  '\0claude-agent-sdk-stub': `
    const serverOnly = () => { throw new Error('Claude Agent SDK is only available on the server'); };
    export const unstable_v2_createSession = serverOnly;
    export const unstable_v2_resumeSession = serverOnly;
    export const unstable_v2_prompt = async () => serverOnly();
    export const query = async () => serverOnly();
    export const listSessions = async () => serverOnly();
    export const getSessionInfo = async () => serverOnly();
    export const getSessionMessages = async () => serverOnly();
    export const forkSession = async () => serverOnly();
    export const renameSession = async () => serverOnly();
    export const tagSession = async () => serverOnly();
    export const tool = serverOnly;
    export const createSdkMcpServer = serverOnly;
    export default { unstable_v2_createSession, unstable_v2_resumeSession, unstable_v2_prompt, query };
  `,

  // @anthropic-ai/sdk stub
  '\0anthropic-sdk-stub': `
    export default class Anthropic {
      constructor() {
        throw new Error('Anthropic SDK is only available on the server');
      }
    }
  `,

  // db/client stub
  '\0db-client-stub': `
    export const sqlite = null;
    export const pglite = null;
    export const db = {
      select: () => ({ from: () => ({ where: () => [] }) }),
      insert: () => ({ values: () => ({ returning: () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => [] }) }) }),
      delete: () => ({ where: () => ({ returning: () => [] }) }),
    };
    export const createServerDb = () => db;
  `,

  // api/runtime stub
  '\0api-runtime-stub': `
    const noopService = new Proxy({}, {
      get: () => () => Promise.resolve({ ok: true, value: [] })
    });
    export const getApiRuntime = () => ({ ok: true, value: {} });
    export const getApiRuntimeOrThrow = () => ({});
    export const getApiServices = () => ({ ok: true, value: {
      codespaceService: noopService,
      taskService: noopService,
      agentService: noopService,
      sessionService: noopService,
      worktreeService: noopService,
    }});
    export const getApiServicesOrThrow = () => ({
      codespaceService: noopService,
      taskService: noopService,
      agentService: noopService,
      sessionService: noopService,
      worktreeService: noopService,
    });
    export const getApiStreamsOrThrow = () => ({
      createStream: async () => undefined,
      publish: async () => undefined,
      subscribe: async function* () { yield { type: 'chunk', data: {} }; },
    });
  `,
};

/**
 * Map of module sources to their stub IDs
 */
export const MODULE_STUB_MAP: Record<string, string> = {
  'better-sqlite3': '\0better-sqlite3-stub',
  'node:fs': '\0node-fs-stub',
  fs: '\0node-fs-stub',
  'node:os': '\0node-os-stub',
  os: '\0node-os-stub',
  'node:path': '\0node-path-stub',
  path: '\0node-path-stub',
  'node:url': '\0node-url-stub',
  url: '\0node-url-stub',
  'node:events': '\0node-events-stub',
  events: '\0node-events-stub',
  'node:crypto': '\0node-crypto-stub',
  crypto: '\0node-crypto-stub',
  'node:buffer': '\0node-buffer-stub',
  buffer: '\0node-buffer-stub',
  'node:stream': '\0node-stream-stub',
  stream: '\0node-stream-stub',
  'node:util': '\0node-util-stub',
  util: '\0node-util-stub',
  'node:assert': '\0node-assert-stub',
  assert: '\0node-assert-stub',
  'node:async_hooks': '\0node-async_hooks-stub',
  async_hooks: '\0node-async_hooks-stub',
  '@anthropic-ai/claude-agent-sdk': '\0claude-agent-sdk-stub',
  '@anthropic-ai/sdk': '\0anthropic-sdk-stub',
};

/**
 * Server-only tool modules that should be stubbed
 */
export const SERVER_TOOL_MODULES = ['bash-tool', 'file-tools', 'search-tools'];

/**
 * Get the stub ID for a given module source
 */
export function getStubId(source: string): string | null {
  // Direct module mapping
  if (MODULE_STUB_MAP[source]) {
    return MODULE_STUB_MAP[source];
  }

  // db/client pattern
  if (source.includes('db/client') || source === '@/db/client') {
    return '\0db-client-stub';
  }

  // api/runtime pattern
  if (
    source.includes('api/runtime') ||
    source === '@/app/routes/api/runtime' ||
    source === '@/server/runtime'
  ) {
    return '\0api-runtime-stub';
  }

  return null;
}

/**
 * Get the stub code for a given stub ID
 */
export function getStubCode(id: string): string | null {
  return BROWSER_STUBS[id] ?? null;
}
