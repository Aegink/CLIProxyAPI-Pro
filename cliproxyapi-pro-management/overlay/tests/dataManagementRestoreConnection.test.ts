/* eslint-disable @typescript-eslint/no-explicit-any -- Execute production callbacks with a minimal React state harness. */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { apiClient } from '../src/services/api/client';
import { dataManagementApi } from '../src/pro/modules/dataManagement/dataManagement';

// Execute the page's actual callback bodies with state/effects supplied by this
// harness. Domain methods and the HTTP transport are never mocked; rendering is
// intentionally separate from these interrupted-workflow checks.
const page = readFileSync(new URL('../src/pro/modules/dataManagement/DataManagementPage.tsx', import.meta.url), 'utf8');
const guardSource = page.slice(page.indexOf('  const restorePreviewSequenceRef ='), page.indexOf('  const updateSettingsDraft ='));
const callbackSource = page.slice(page.indexOf('  const previewRestoreBuffer ='), page.indexOf('  const previewCleanup ='));
const source = guardSource + callbackSource;
const transpiler = new Bun.Transpiler({ loader: 'tsx' });
const code = transpiler.transformSync(source);

type SeenRequest = { path: string; body: string; passphrase: string | null };
const requestsA: SeenRequest[] = [];
const requestsB: SeenRequest[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const noOp = () => {};

const serve = (requests: SeenRequest[], held?: { ready: () => void; response: Promise<Response> }) => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    requests.push({ path: new URL(request.url).pathname, body: await request.text(), passphrase: request.headers.get('X-CLIProxy-Backup-Passphrase') });
    if (held) { held.ready(); return held.response; }
    return Response.json({ domains: [], secretClasses: [], legacyBackup: false, backupSha256: 'synthetic-hash' });
  } });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const buffer = (value = 'synthetic-backup') => new TextEncoder().encode(value).buffer;
const event = (data: ArrayBuffer | Promise<ArrayBuffer>) => ({ target: { files: [{ name: 'fixture.jsonl', arrayBuffer: () => Promise.resolve(data) }], value: 'file' } });

function harness() {
  const cleanup: Array<() => void> = [];
  const context: any = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => (() => void)) => cleanup.push(effect()),
    apiBase: 'fixture', managementKey: 'test', connectionStatus: 'connected', isCurrentLayer: true,
    apiClient, dataManagementApi,
    showNotification: noOp, loadCore: noOp, loadBackupHistory: noOp, t: (key: string) => key,
    isEncryptedDataBackup: (content: string) => content === 'encrypted-fixture',
    hasDataBackupManifest: () => true,
    restoreBuffer: null, restorePreview: null, restoreWebDAVFileName: '', restorePassphrase: '',
    restoreAllowLegacy: false, restoreEncrypted: false,
  };
  for (const [name] of source.matchAll(/\bsetRestore[A-Za-z]+/g)) {
    const state = name[3].toLowerCase() + name.slice(4);
    context[name] = (value: unknown) => { context[state] = value; };
  }
  const result = new Function('context', `with (context) { ${code}; return {
    handleRestoreFile, previewWebDAVRestore, previewEncryptedRestore, executeRestore,
    cancelRestore, restoreAbortRef,
  }; }`)(context);
  return { ...result, state: context, unmount: () => cleanup.forEach((stop) => stop()) };
}

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true));
  requestsA.length = 0; requestsB.length = 0;
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

test('a delayed file read cannot upload across host, ABA, key-only or logout changes', async () => {
  for (const change of ['host', 'aba', 'key', 'logout']) {
    const a = serve(requestsA), b = serve(requestsB);
    apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
    const run = harness();
    const read = deferred<ArrayBuffer>();
    const pending = run.handleRestoreFile(event(read.promise));
    apiClient.setConfig(change === 'key' ? { apiBase: a, managementKey: 'test-new-key' }
      : change === 'logout' ? { apiBase: '', managementKey: '' }
      : { apiBase: b, managementKey: 'test-b' });
    if (change === 'aba') apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
    read.resolve(buffer());
    await pending;
    expect(requestsA).toHaveLength(0); expect(requestsB).toHaveLength(0);
    expect(run.state.restoreBuffer).toBeNull();
    run.unmount();
  }
});

test('closing or unmounting a pending file read prevents upload and reopening', async () => {
  const a = serve(requestsA);
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  for (const close of ['cancelRestore', 'unmount']) {
    const run = harness();
    const read = deferred<ArrayBuffer>();
    const pending = run.handleRestoreFile(event(read.promise));
    run[close]();
    read.resolve(buffer());
    await pending;
    expect(requestsA).toHaveLength(0);
    expect(run.state.restorePreviewOpen).toBe(false);
    expect(run.state.restoreBuffer).toBeNull();
    run.unmount();
  }
});

test('same-connection plain backup previews and restores through v0 with original payload', async () => {
  const a = serve(requestsA);
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  const run = harness();
  await run.handleRestoreFile(event(buffer()));
  expect(run.state.restorePreviewOpen).toBe(true);
  await run.executeRestore();
  expect(requestsA.map((request) => request.path)).toEqual(['/v0/management/data/backups/preview', '/v0/management/data/backups/restore']);
  expect(requestsA.every((request) => request.body === 'synthetic-backup')).toBe(true);
  expect(run.state.restoreBuffer).toBeNull();
  expect(run.state.restorePreviewOpen).toBe(false);
  run.unmount();
});

test('encrypted backup ownership survives the passphrase dialog and rejects stale preview', async () => {
  const a = serve(requestsA), b = serve(requestsB);
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  const run = harness();
  await run.handleRestoreFile(event(buffer('encrypted-fixture')));
  expect(run.state.restorePassphraseDialogOpen).toBe(true);
  run.state.restorePassphrase = 'synthetic-passphrase';
  apiClient.setConfig({ apiBase: b, managementKey: 'test-b' });
  await run.previewEncryptedRestore();
  expect(requestsA).toHaveLength(0); expect(requestsB).toHaveLength(0);
  run.unmount();
});

test('stale plain and WebDAV restore confirmations cannot act on the next connection', async () => {
  const a = serve(requestsA), b = serve(requestsB);
  for (const webdav of [false, true]) {
    apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
    const run = harness();
    if (webdav) await run.previewWebDAVRestore({ fileName: 'synthetic-remote.jsonl' });
    else await run.handleRestoreFile(event(buffer()));
    apiClient.setConfig({ apiBase: b, managementKey: 'test-b' });
    await run.executeRestore();
    expect(requestsB).toHaveLength(0);
    run.unmount();
  }
  expect(requestsA.every((request) => request.path.endsWith('/preview'))).toBe(true);
});

test('cancel physically aborts a pending preview and ignores its eventual response', async () => {
  const ready = deferred<void>();
  const response = deferred<Response>();
  const a = serve(requestsA, { ready: () => ready.resolve(), response: response.promise });
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  const run = harness();
  const pending = run.handleRestoreFile(event(buffer()));
  await ready.promise;
  const signal = run.restoreAbortRef.current.signal;
  run.cancelRestore();
  await pending;
  expect(signal.aborted).toBe(true);
  expect(run.state.restorePreviewOpen).toBe(false);
  expect(run.state.restoreBuffer).toBeNull();
  response.resolve(Response.json({ domains: [], secretClasses: [] }));
  run.unmount();
});

test('new file selection supersedes an older local read', async () => {
  const a = serve(requestsA);
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  const run = harness();
  const read = deferred<ArrayBuffer>();
  const pending = run.handleRestoreFile(event(read.promise));
  await run.handleRestoreFile(event(buffer('new-backup')));
  read.resolve(buffer('old-backup'));
  await pending;
  expect(requestsA.map((request) => request.body)).toEqual(['new-backup']);
  expect(new TextDecoder().decode(run.state.restoreBuffer)).toBe('new-backup');
  run.unmount();
});


test('closing the passphrase dialog rejects an old unlock callback and clears its secret', async () => {
  const a = serve(requestsA);
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  const run = harness();
  await run.handleRestoreFile(event(buffer('encrypted-fixture')));
  run.state.restorePassphrase = 'synthetic-passphrase';
  const oldBuffer = run.state.restoreBuffer;
  run.cancelRestore();
  expect(run.state.restorePassphrase).toBe('');
  expect(run.state.restorePassphraseDialogOpen).toBe(false);
  // A retained callback from a prior render can still capture the old buffer.
  run.state.restoreBuffer = oldBuffer;
  run.state.restorePassphrase = 'synthetic-passphrase';
  await run.previewEncryptedRestore();
  expect(requestsA).toHaveLength(0);
  run.unmount();
});

test('same-connection encrypted and WebDAV restores preserve passphrase and preview hash', async () => {
  const a = serve(requestsA);
  apiClient.setConfig({ apiBase: a, managementKey: 'test-a' });
  const run = harness();
  await run.handleRestoreFile(event(buffer('encrypted-fixture')));
  run.state.restorePassphrase = 'synthetic-passphrase';
  await run.previewEncryptedRestore();
  await run.executeRestore();
  expect(requestsA.slice(0, 2).every((request) => request.passphrase === 'synthetic-passphrase')).toBe(true);
  await run.previewWebDAVRestore({ fileName: 'synthetic-remote.jsonl' });
  await run.executeRestore();
  expect(JSON.parse(requestsA[3].body)).toEqual({ fileName: 'synthetic-remote.jsonl', allowLegacy: false, expectedSha256: 'synthetic-hash' });
  expect(requestsA[3].path).toBe('/v0/management/data/backups/webdav/restore');
  run.unmount();
});
