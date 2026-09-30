import { expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { apiClient } from '../src/services/api/client';
import { authFilesApi } from '../src/services/api/authFiles';
import { sqliteQuotaCache } from '../src/pro/modules/quota/extensions/sqliteQuotaCache';
import { GEMINI_CLI_CONFIG } from '../src/pro/modules/quota/extensions/geminiCliQuotaConfig';
import { dataManagementApi } from '../src/pro/modules/dataManagement/dataManagement';
import { apiKeyPolicyApi } from '../src/pro/modules/apiKeyPolicy/apiKeyPolicy';
import { accountInspectionApi, buildAccountInspectionLogsWebSocketUrl } from '../src/pro/modules/inspection/api';
import { routingPolicyApi } from '../src/pro/modules/routing/routingPolicy';
import { proxyPoolApi } from '../src/pro/modules/proxyPool/proxyPool';
import { oauthPolicyApi } from '../src/pro/modules/oauthPolicy/oauthPolicy';
import { loadModelPriceRules } from '../src/pro/modules/monitoring/features/usage';
import { buildUsageStreamUrl } from '../src/pro/modules/monitoring/features/hooks/useUsageData';
import { checkManagementPanelUpdate } from '../src/pro/system/managementUpdate';
import { useManagementModelsStore } from '../src/pro/system/useManagementModelsStore';

test('real HTTP requests keep native routes v8 and all Pro service domains v0', async () => {
  const paths: string[] = [];
  const authorizations: Array<string | null> = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => {
    const { pathname } = new URL(request.url);
    paths.push(`${request.method} ${pathname}`);
    authorizations.push(request.headers.get('Authorization'));
    const native = ['/cpa/v8/management/config', '/cpa/v8/management/credentials'].includes(pathname);
    if (!native && !pathname.startsWith('/cpa/v0/management/')) {
      return new Response('wrong namespace', { status: 404 });
    }
    return Response.json({
      items: [], files: [], data: [], generation: 1, domains: [],
      snapshot: { schema_version: 1, items: [{ id: 'probe', label: 'Probe', remaining_fraction: 0.5 }] },
    });
  } });
  const base = `http://127.0.0.1:${server.port}/cpa`;
  try {
    apiClient.setConfig({ apiBase: `${base}/v8/management`, managementKey: 'http-test-key' });
    await apiClient.get('/config');
    await authFilesApi.list({ name: 'http-test.json' });
    await sqliteQuotaCache.getAll();
    await sqliteQuotaCache.getStats();
    expect(await sqliteQuotaCache.set('codex', 'http-test.json', { status: 'success', windows: [] })).toBe(true);
    await dataManagementApi.overview();
    await apiKeyPolicyApi.bindings();
    await accountInspectionApi.getStatus();
    await routingPolicyApi.get();
    await proxyPoolApi.load();
    await oauthPolicyApi.load();
    await loadModelPriceRules();
    await checkManagementPanelUpdate();
    await useManagementModelsStore.getState().fetchModels(base, true);
    await GEMINI_CLI_CONFIG.fetchQuota(
      { name: 'gemini.json', authIndex: 'http-test', type: 'gemini' },
      ((key: string) => key) as TFunction
    );
    await authFilesApi.testConnection({ name: 'http-test.json', model: 'test-model' });

    expect(paths).toContain('GET /cpa/v8/management/config');
    expect(paths).toContain('GET /cpa/v8/management/credentials');
    for (const path of [
      '/usage/quota-cache', '/data/overview', '/api-key-policy-bindings',
      '/account-inspection/status', '/routing-policy', '/pro/proxy-pool/config',
      '/pro/proxy-pool/status', '/proxy-url', '/config', '/models',
      '/pro/oauth-policy/config', '/pro/oauth-policy/status', '/pro/oauth-policy/effective',
      '/usage/model-price-rules',
    ]) expect(paths).toContain(`GET /cpa/v0/management${path}`);
    expect(paths).toContain('PUT /cpa/v0/management/usage/quota-cache');
    expect(paths).toContain('POST /cpa/v0/management/management-panel/check-update');
    expect(paths).toContain('POST /cpa/v0/management/quota/fetch');
    expect(paths).toContain('POST /cpa/v0/management/auth-files/test');
    expect(authorizations.every((value) => value === 'Bearer http-test-key')).toBe(true);
  } finally {
    server.stop(true);
    apiClient.setConfig({ apiBase: '', managementKey: '' });
    useManagementModelsStore.getState().clearCache();
  }
});

test('SSE and WebSocket URLs preserve proxy prefixes and the Pro namespace', () => {
  for (const suffix of ['', '/v0/management/', '/v8/management/']) {
    const base = `https://example.com/cpa${suffix}`;
    expect(buildUsageStreamUrl(base, 7, 3)).toBe(
      'https://example.com/cpa/v0/management/usage/stream?after_id=7&generation=3'
    );
    expect(buildAccountInspectionLogsWebSocketUrl(base, true)).toBe(
      'wss://example.com/cpa/v0/management/account-inspection/logs?details=1'
    );
  }
});
