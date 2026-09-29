import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { QUOTA_TAB_ORDER } from '../src/features/quota/constants';
import { QUOTA_ADAPTERS } from '../src/features/quota/providers';
import { apiClient } from '../src/services/api/client';
import { useQuotaStore } from '../src/stores/useQuotaStore';
import { quotaPersistenceMiddleware as middleware } from '../src/pro/modules/quota/extensions/persistenceMiddleware';
import { PRO_QUOTA_PROVIDER_TYPES } from '../src/pro/modules/quota/quotaStoreMetadata';
import type { QuotaCacheEntry } from '../src/pro/modules/quota/extensions/sqliteQuotaCache';

const quota = (cachedAt: number, label = 'old') => ({
  status: 'success' as const,
  windows: [],
  cachedAt,
  planType: label,
});
const entry = (cachedAt: number, label = 'old'): QuotaCacheEntry => ({
  id: 'codex:a.json',
  provider: 'codex',
  fileName: 'a.json',
  data: quota(cachedAt, label),
  cachedAt,
  accessedAt: cachedAt,
  observedAt: cachedAt,
  storedAt: cachedAt,
  version: 1,
  revision: 1,
});
const devinQuota = (cachedAt: number) => ({
  status: 'success' as const,
  windows: [
    {
      id: 'daily' as const,
      label: 'Daily',
      remainingPercent: 65,
      resetAtMs: 1_800_000_000_000,
      periodHours: 24,
    },
  ],
  observedAtMs: cachedAt,
  plan: 'Core',
  planStartMs: 1_700_000_000_000,
  planEndMs: 1_900_000_000_000,
  cachedAt,
});
const metaQuota = (cachedAt: number) => ({
  status: 'success' as const,
  data: {
    planName: 'Muse Pro',
    isSubscriptionActive: true,
    windows: [
      {
        id: 'window' as const,
        usedPercent: 35,
        resetAt: 1_800_000_000,
        durationMinutes: 300,
      },
    ],
  },
  cachedAt,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let generation = 10;
let items: QuotaCacheEntry[] = [entry(100)];
let read: () => Promise<{ items: QuotaCacheEntry[] }>;
let get: ReturnType<typeof spyOn>;
let put: ReturnType<typeof spyOn>;

beforeEach(() => {
  middleware.stop();
  useQuotaStore.getState().clearQuotaCache();
  generation += 10;
  items = [entry(100)];
  read = async () => ({ items });
  get = spyOn(apiClient, 'get').mockImplementation(async (_url, config) =>
    config?.params?.stats ? { generation } : read()
  );
  put = spyOn(apiClient, 'put').mockResolvedValue({});
  middleware.markStale();
});
afterEach(async () => {
  middleware.stop();
  await tick();
  get.mockRestore();
  put.mockRestore();
});

async function start() {
  middleware.start();
  await middleware.ensureFresh();
}

test('failed reads preserve hydrated state and retry the same generation', async () => {
  await start();
  generation++;
  read = async () => {
    throw new Error('offline');
  };
  await middleware.ensureFresh();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(100));
  items = [entry(200)];
  read = async () => ({ items });
  await middleware.ensureFresh();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(200));
});

test('live refresh during hydration is kept and written', async () => {
  await start();
  generation++;
  const pending = deferred<{ items: typeof items }>();
  read = () => pending.promise;
  const refresh = middleware.ensureFresh();
  await tick();
  useQuotaStore.getState().setCodexQuota({ 'a.json': quota(300, 'live') });
  pending.resolve({ items: [entry(200)] });
  await refresh;
  await tick();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(300, 'live'));
  expect(put.mock.calls.some(([, body]) => body.data.cachedAt === 300)).toBe(true);
});

test('older cache cannot overwrite a newer local success', async () => {
  useQuotaStore.getState().setCodexQuota({ 'a.json': quota(300) });
  await start();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(300));
});

test.each(['file', 'session', 'stop'] as const)(
  '%s invalidation fences pending hydration',
  async (kind) => {
    await start();
    generation++;
    const pending = deferred<{ items: typeof items }>();
    read = () => pending.promise;
    const refresh = middleware.ensureFresh();
    await tick();
    if (kind === 'stop') middleware.stop();
    useQuotaStore.getState().clearQuotaCache(kind === 'file' ? ['a.json'] : undefined);
    pending.resolve({ items: [entry(200)] });
    await refresh;
    expect(useQuotaStore.getState().codexQuota['a.json']).toBeUndefined();
  }
);

test('markStale during a read survives its completion', async () => {
  await start();
  generation++;
  const pending = deferred<{ items: typeof items }>();
  read = () => pending.promise;
  const refresh = middleware.ensureFresh();
  await tick();
  middleware.markStale();
  pending.resolve({ items: [entry(200)] });
  await refresh;
  read = async () => ({ items: [entry(300)] });
  await middleware.ensureFresh();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(300));
});

test('restart accepts a lower backend generation', async () => {
  await start();
  middleware.stop();
  generation = 1;
  items = [entry(200)];
  await start();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(200));
});

test('same timestamp with changed payload is persisted', async () => {
  await start();
  useQuotaStore.getState().setCodexQuota({ 'a.json': quota(100, 'updated') });
  await tick();
  expect(put.mock.calls.some(([, body]) => body.data.planType === 'updated')).toBe(true);
});

test('persistence providers follow the upstream quota registry', () => {
  expect([...PRO_QUOTA_PROVIDER_TYPES]).toEqual([...QUOTA_TAB_ORDER]);
  expect([...PRO_QUOTA_PROVIDER_TYPES].sort()).toEqual(Object.keys(QUOTA_ADAPTERS).sort());
});

test.each([
  ['devin', 'setDevinQuota', devinQuota(400)],
  ['meta', 'setMetaQuota', metaQuota(500)],
] as const)(
  '%s success is serialized to the shared quota cache',
  async (provider, setter, data) => {
    items = [];
    await start();
    useQuotaStore.getState()[setter]({ 'provider.json': data } as never);
    await tick();

    const call = put.mock.calls.find(([, body]) => body.provider === provider);
    expect(call?.[1]).toMatchObject({
      provider,
      fileName: 'provider.json',
      cachedAt: data.cachedAt,
      observedAt: data.cachedAt,
      data,
    });
  }
);

test('a failed Devin write stays queued and retries', async () => {
  items = [];
  put.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  await start();
  useQuotaStore.getState().setDevinQuota({ 'provider.json': devinQuota(600) });
  await tick();
  expect(put).toHaveBeenCalledTimes(1);

  await new Promise((resolve) => setTimeout(resolve, 1_050));

  expect(put).toHaveBeenCalledTimes(2);
  expect(put.mock.calls[1]?.[1]).toMatchObject({
    provider: 'devin',
    fileName: 'provider.json',
    data: devinQuota(600),
  });
});

test('Devin and Meta cache rows restore into their upstream provider maps', async () => {
  items = [
    {
      ...entry(400),
      id: 'devin:provider.json',
      provider: 'devin',
      fileName: 'provider.json',
      data: devinQuota(400),
      authIndex: 'devin-auth-index',
      identityFingerprint: 'devin-identity',
    } as QuotaCacheEntry,
    {
      ...entry(500),
      id: 'meta:provider.json',
      provider: 'meta',
      fileName: 'provider.json',
      data: metaQuota(500),
      authIndex: 'meta-auth-index',
      identityFingerprint: 'meta-identity',
    } as QuotaCacheEntry,
  ];

  await start();

  expect(useQuotaStore.getState().devinQuota['provider.json']).toEqual(devinQuota(400));
  expect(useQuotaStore.getState().metaQuota['provider.json']).toEqual(metaQuota(500));
  expect(put).not.toHaveBeenCalled();
});

test('backend deletion removes hydrated state without mirroring it', async () => {
  await start();
  expect(put).not.toHaveBeenCalled();
  items = [];
  generation++;
  await middleware.ensureFresh();
  expect(useQuotaStore.getState().codexQuota['a.json']).toBeUndefined();
  expect(put).not.toHaveBeenCalled();
});

test('backend deletion preserves locally refreshed state', async () => {
  await start();
  useQuotaStore.getState().setCodexQuota({ 'a.json': quota(300) });
  await tick();
  items = [];
  generation++;
  await middleware.ensureFresh();
  expect(useQuotaStore.getState().codexQuota['a.json']).toEqual(quota(300));
});
