import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiClient } from '../../src/services/api/client';
import { useQuotaStore } from '../../src/stores/useQuotaStore';
import { quotaPersistenceMiddleware } from '../../src/pro/modules/quota/extensions/persistenceMiddleware';

type QuotaCacheEntry = {
  provider: string;
  fileName: string;
  data: unknown;
  revision?: number;
};

type RunConfig = {
  coreUrl: string;
  managementKey: string;
  runId: string;
};

type RunResult = {
  passed: boolean;
  files: { devin: string; meta: string };
  backend: { devin: QuotaCacheEntry; meta: QuotaCacheEntry };
  restored: { devin: unknown; meta: unknown };
};

const listeners = new Set<(value: unknown) => void>();
const publish = (value: unknown) => listeners.forEach((listener) => listener(value));

const assertLoopback = (value: string) => {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`Core URL must use loopback, received ${url.hostname}`);
  }
};

const waitForEntry = async (provider: string, fileName: string): Promise<QuotaCacheEntry> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await apiClient.get<{ items?: QuotaCacheEntry[] }>('/usage/quota-cache', {
      params: { provider, fileName },
    });
    const entry = response.items?.find(
      (candidate) => candidate.provider === provider && candidate.fileName === fileName
    );
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${provider}:${fileName}`);
};

const deleteEntry = (provider: string, fileName: string) =>
  apiClient.delete('/usage/quota-cache', { params: { provider, fileName } });

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
};

const isEquivalent = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const run = async ({ coreUrl, managementKey, runId }: RunConfig): Promise<RunResult> => {
  assertLoopback(coreUrl);
  if (!managementKey) throw new Error('managementKey is required');
  if (!runId) throw new Error('runId is required');

  apiClient.setConfig({ apiBase: coreUrl, managementKey });
  const files = {
    devin: `e2e-devin-${runId}.json`,
    meta: `e2e-meta-${runId}.json`,
  };
  const cachedAt = Date.now();
  const devin = {
    status: 'success' as const,
    windows: [
      {
        id: 'daily' as const,
        label: 'Daily',
        remainingPercent: 61,
        resetAtMs: cachedAt + 86_400_000,
        periodHours: 24,
      },
    ],
    observedAtMs: cachedAt,
    plan: 'E2E Core',
    planStartMs: cachedAt - 3_600_000,
    planEndMs: cachedAt + 2_592_000_000,
    cachedAt,
  };
  const meta = {
    status: 'success' as const,
    data: {
      planName: 'E2E Muse',
      isSubscriptionActive: true,
      windows: [
        {
          id: 'window' as const,
          usedPercent: 27,
          resetAt: Math.floor((cachedAt + 18_000_000) / 1000),
          durationMinutes: 300,
        },
      ],
    },
    cachedAt,
  };

  quotaPersistenceMiddleware.stop();
  useQuotaStore.getState().clearQuotaCache();
  await deleteEntry('devin', files.devin);
  await deleteEntry('meta', files.meta);

  try {
    quotaPersistenceMiddleware.markStale();
    quotaPersistenceMiddleware.start();
    await quotaPersistenceMiddleware.ensureFresh();

    useQuotaStore.getState().setDevinQuota({ [files.devin]: devin });
    useQuotaStore.getState().setMetaQuota({ [files.meta]: meta });

    const [backendDevin, backendMeta] = await Promise.all([
      waitForEntry('devin', files.devin),
      waitForEntry('meta', files.meta),
    ]);

    quotaPersistenceMiddleware.stop();
    useQuotaStore.getState().clearQuotaCache();
    quotaPersistenceMiddleware.markStale();
    quotaPersistenceMiddleware.start();
    await quotaPersistenceMiddleware.ensureFresh();

    const restoredDevin = useQuotaStore.getState().devinQuota[files.devin];
    const restoredMeta = useQuotaStore.getState().metaQuota[files.meta];
    const passed =
      isEquivalent(backendDevin.data, devin) &&
      isEquivalent(backendMeta.data, meta) &&
      isEquivalent(restoredDevin, devin) &&
      isEquivalent(restoredMeta, meta);

    const result = {
      passed,
      files,
      backend: { devin: backendDevin, meta: backendMeta },
      restored: { devin: restoredDevin, meta: restoredMeta },
    };
    publish(result);
    return result;
  } finally {
    quotaPersistenceMiddleware.stop();
    useQuotaStore.getState().clearQuotaCache();
    await deleteEntry('devin', files.devin);
    await deleteEntry('meta', files.meta);
  }
};

Object.assign(window, { quotaProviderPersistenceE2E: { run } });

function Harness() {
  const [result, setResult] = useState<unknown>({ ready: true });
  useEffect(() => {
    listeners.add(setResult);
    return () => listeners.delete(setResult);
  }, []);
  return (
    <main style={{ fontFamily: 'monospace', padding: 24 }}>
      <h1>Quota provider persistence E2E</h1>
      <pre id="result">{JSON.stringify(result, null, 2)}</pre>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
