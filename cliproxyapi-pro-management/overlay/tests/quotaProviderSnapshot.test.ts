import { describe, expect, test } from 'bun:test';
import {
  isAuthCardQuotaCacheDataCompatible,
  normalizePersistedQuotaState,
  selectPreferredQuotaCacheEntries,
} from '../src/pro/modules/quota/extensions/normalizedQuotaSnapshot';
import type { QuotaCacheEntry } from '../src/pro/modules/quota/extensions/sqliteQuotaCache';

const cacheEntry = (
  id: string,
  data: unknown,
  observedAt: number,
  revision = 1
): QuotaCacheEntry => ({
  id,
  provider: 'gemini-cli',
  fileName: 'gemini.json',
  data,
  cachedAt: observedAt,
  accessedAt: observedAt,
  observedAt,
  storedAt: observedAt,
  version: 1,
  revision,
});

describe('QuotaProvider snapshot persistence', () => {
  test('hydrates a normalized Gemini snapshot without converting it back on write', () => {
    const normalized = normalizePersistedQuotaState(
      'gemini-cli',
      {
        schema_version: 1,
        observed_at_ms: 123,
        items: [
          {
            id: 'gemini-pro-series',
            label: 'Gemini Pro Series',
            remaining_fraction: 0.75,
            remaining_amount: 42,
            reset_at: '2026-07-23T00:00:00Z',
            model_ids: ['gemini-3.1-pro-preview'],
            metadata: { token_type: 'requests' },
          },
        ],
        plan: { id: 'g1-pro-tier', label: 'Google AI Pro', credit_balance: 10 },
        metadata: { project_id: 'project-a' },
      },
      999
    ) as Record<string, unknown>;

    expect(normalized.status).toBe('success');
    expect(normalized.cachedAt).toBe(123);
    expect(normalized.quotaProviderSnapshot).toBe(true);
    expect(normalized.projectId).toBe('project-a');
    expect(normalized.tierId).toBe('g1-pro-tier');
    expect((normalized.buckets as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'gemini-pro-series',
      remainingFraction: 0.75,
      tokenType: 'requests',
    });
  });

  test('leaves legacy provider states untouched', () => {
    const legacy = { status: 'success', buckets: [] };
    expect(normalizePersistedQuotaState('gemini-cli', legacy, 1)).toBe(legacy);
  });

  test('prefers the canonical Gemini snapshot over a duplicate legacy UI cache entry', () => {
    const canonical = cacheEntry(
      'quota-provider:gemini-cli:auth-1',
      {
        schema_version: 1,
        observed_at_ms: 200,
        items: [{ id: 'new', label: 'New quota', remaining_fraction: 0.8 }],
        plan: { id: 'g1-pro-tier', label: 'Google AI Pro' },
      },
      200
    );
    const legacy = cacheEntry(
      'gemini-cli:gemini.json',
      {
        status: 'success',
        buckets: [{ id: 'old', label: 'Old quota', remainingFraction: 0.1 }],
        tierId: 'free-tier',
      },
      100
    );

    for (const entries of [
      [canonical, legacy],
      [legacy, canonical],
    ]) {
      const selected = selectPreferredQuotaCacheEntries('gemini-cli', entries).get('gemini.json');
      expect(selected?.id).toBe(canonical.id);
      const hydrated = normalizePersistedQuotaState(
        'gemini-cli',
        selected?.data,
        selected?.cachedAt ?? 0
      ) as Record<string, unknown>;
      expect(hydrated.tierId).toBe('g1-pro-tier');
      expect((hydrated.buckets as Array<Record<string, unknown>>)[0]?.id).toBe('new');
    }
  });

  test('uses freshness metadata when duplicate entries have the same representation', () => {
    const older = cacheEntry('older', { status: 'success', buckets: [] }, 100, 5);
    const newer = cacheEntry('newer', { status: 'success', buckets: [] }, 200, 1);

    const selected = selectPreferredQuotaCacheEntries('gemini-cli', [older, newer]);
    expect(selected.get('gemini.json')?.id).toBe('newer');
  });

  test('uses observed freshness for the Antigravity auth-card snapshot', () => {
    const inspection: QuotaCacheEntry = {
      ...cacheEntry(
        'antigravity:account.json',
        {
          status: 'success',
          groups: [],
          subscription: { plan: 'pro', tierId: 'g1-pro-tier' },
        },
        300
      ),
      provider: 'antigravity',
      fileName: 'account.json',
      cachedAt: 200,
    };
    const plugin: QuotaCacheEntry = {
      ...cacheEntry(
        'quota-provider:antigravity:idx',
        {
          schema_version: 1,
          provider: 'antigravity',
          items: [],
          plan: { id: 'g1-ultra-tier', kind: 'ultra' },
        },
        400
      ),
      provider: 'antigravity',
      fileName: 'account.json',
      cachedAt: 400,
    };

    const selected = selectPreferredQuotaCacheEntries('antigravity', [plugin, inspection]);
    expect(selected.get('account.json')?.id).toBe(inspection.id);
  });

  test('ignores an Antigravity plugin row when no auth-card snapshot exists', () => {
    const plugin: QuotaCacheEntry = {
      ...cacheEntry(
        'quota-provider:antigravity:idx',
        {
          schema_version: 1,
          provider: 'antigravity',
          items: [],
          plan: { id: 'g1-ultra-tier', kind: 'ultra' },
        },
        400
      ),
      provider: 'antigravity',
      fileName: 'account.json',
    };

    expect(isAuthCardQuotaCacheDataCompatible('antigravity', plugin.data)).toBe(false);
    expect(selectPreferredQuotaCacheEntries('antigravity', [plugin]).size).toBe(0);
  });

  test('uses the auth-card provider shape contract for persisted rows', () => {
    const cases: Array<[string, unknown, boolean]> = [
      ['antigravity', { status: 'success', groups: [] }, true],
      ['antigravity', { schema_version: 1, items: [], plan: { kind: 'ultra' } }, false],
      ['codex', { status: 'success', windows: [] }, true],
      [
        'devin',
        {
          status: 'success',
          windows: [],
          observedAtMs: 100,
          plan: null,
          planStartMs: null,
          planEndMs: null,
        },
        true,
      ],
      ['devin', { status: 'success', observedAtMs: 100 }, false],
      ['gemini-cli', { status: 'success', buckets: [] }, true],
      ['gemini-cli', { schema_version: 1, items: [] }, true],
      ['kimi', { status: 'success', rows: [] }, true],
      ['meta', { status: 'success', data: { windows: [] } }, true],
      ['meta', { status: 'success', data: {} }, false],
      ['xai', { status: 'success', billing: {} }, true],
      ['antigravity', { status: 'error' }, true],
      ['antigravity', { status: 'success' }, false],
    ];

    cases.forEach(([provider, data, expected]) => {
      expect(isAuthCardQuotaCacheDataCompatible(provider, data)).toBe(expected);
    });
  });
});
