import { afterEach, expect, test } from 'bun:test';
import type { AxiosRequestConfig } from 'axios';
import { apiClient } from '../src/services/api/client';
import { proApiClient } from '../src/pro/shared/proManagementTransport';
import { computeProManagementApiUrl } from '../src/pro/shared/proManagementUrl';

type CapturedRequest = AxiosRequestConfig & { headers: Record<string, unknown> };
type Adapter = (config: CapturedRequest) => Promise<unknown>;
const internalClient = apiClient as unknown as {
  instance: { defaults: { adapter: Adapter | Adapter[] | undefined } };
};
const originalAdapter = internalClient.instance.defaults.adapter;
const response = (config: CapturedRequest) => ({
  data: {}, status: 200, statusText: 'OK', headers: {}, config,
});

afterEach(() => {
  internalClient.instance.defaults.adapter = originalAdapter;
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

test('normalizes both management suffixes while preserving deployment prefixes', () => {
  expect(computeProManagementApiUrl('')).toBe('');
  expect(computeProManagementApiUrl('localhost:8317')).toBe('http://localhost:8317/v0/management');
  for (const suffix of ['', '/', '/v0/management/', '/v8/management/']) {
    expect(computeProManagementApiUrl(`https://server.example/cpa${suffix}`)).toBe(
      'https://server.example/cpa/v0/management'
    );
  }
});

test('native v8 and Pro v0 share configured server, authentication and request options', async () => {
  const requests: CapturedRequest[] = [];
  internalClient.instance.defaults.adapter = async (config) => {
    requests.push(config);
    return response(config);
  };
  apiClient.setConfig({ apiBase: 'https://server.example/cpa/v0/management/', managementKey: 'test-key' });
  await apiClient.get('/credentials');
  await proApiClient.get('/usage/quota-cache', { baseURL: 'https://untrusted.example', params: { stats: 1 } });
  await proApiClient.post('/data/backups/export', { passphrase: 'test-only' }, { responseType: 'blob', timeout: 65_000 });
  expect(requests.map((request) => request.baseURL)).toEqual([
    'https://server.example/cpa/v8/management',
    'https://server.example/cpa/v0/management',
    'https://server.example/cpa/v0/management',
  ]);
  for (const request of requests) {
    expect(request.headers.Authorization).toBe('Bearer test-key');
    expect(request.signal).toBeDefined();
  }
  expect(requests[1].params).toEqual({ stats: 1 });
  expect(requests[2].responseType).toBe('blob');
  expect(requests[2].timeout).toBe(65_000);
  expect(JSON.parse(requests[2].data)).toEqual({ passphrase: 'test-only' });
  const revision = apiClient.getConnectionRevision();
  apiClient.setConfig({ apiBase: 'https://server.example/cpa/v8/management', managementKey: 'test-key' });
  expect(apiClient.getConnectionRevision()).toBe(revision);
});

test('Pro requests cannot supply an absolute or protocol-relative destination', () => {
  for (const url of ['https://untrusted.example', '//untrusted.example', '/\\untrusted.example', ' /usage', 'usage']) {
    expect(() => proApiClient.get(url)).toThrow('relative API path');
  }
});

test('every Pro HTTP method carries the fixed namespace', async () => {
  const requests: CapturedRequest[] = [];
  internalClient.instance.defaults.adapter = async (config) => {
    requests.push(config);
    return response(config);
  };
  apiClient.setConfig({ apiBase: 'https://server.example', managementKey: 'test-key' });
  await proApiClient.get('/usage/quota-cache');
  await proApiClient.post('/usage/quota-cache', {});
  await proApiClient.put('/usage/quota-cache', {});
  await proApiClient.patch('/usage/quota-cache', {});
  await proApiClient.delete('/usage/quota-cache');
  await proApiClient.getRaw('/data/backups/export', { responseType: 'blob' });
  await proApiClient.postForm('/data/backups/restore', new FormData());
  expect(requests).toHaveLength(7);
  expect(requests.every((request) => request.baseURL === 'https://server.example/v0/management')).toBe(true);
});

test('a queued Pro write is cancelled before dispatch after a connection switch', async () => {
  let dispatches = 0;
  internalClient.instance.defaults.adapter = async (config) => {
    dispatches += 1;
    return response(config);
  };
  apiClient.setConfig({ apiBase: 'https://a.example', managementKey: 'key-a' });
  const pending = proApiClient.put('/usage/quota-cache', { fileName: 'a.json' });
  apiClient.setConfig({ apiBase: 'https://b.example', managementKey: 'key-b' });
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  expect(dispatches).toBe(0);
  await proApiClient.get('/usage/quota-cache');
  expect(dispatches).toBe(1);
});

test('ABA connection changes also fence queued Pro requests', async () => {
  let dispatches = 0;
  internalClient.instance.defaults.adapter = async (config) => {
    dispatches += 1;
    return response(config);
  };
  apiClient.setConfig({ apiBase: 'https://a.example', managementKey: 'key-a' });
  const pending = proApiClient.put('/usage/quota-cache', {});
  apiClient.setConfig({ apiBase: 'https://b.example', managementKey: 'key-b' });
  apiClient.setConfig({ apiBase: 'https://a.example', managementKey: 'key-a' });
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  expect(dispatches).toBe(0);
});

test('in-flight Pro requests keep physical cancellation on connection changes', async () => {
  let ready = false;
  let aborted = false;
  internalClient.instance.defaults.adapter = (config) => new Promise((resolve) => {
    config.signal?.addEventListener?.('abort', () => {
      aborted = true;
      resolve(response(config));
    });
    ready = true;
  });
  apiClient.setConfig({ apiBase: 'https://a.example', managementKey: 'key-a' });
  const pending = proApiClient.get('/usage/quota-cache');
  while (!ready) await Promise.resolve();
  apiClient.setConfig({ apiBase: 'https://b.example', managementKey: 'key-b' });
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  expect(aborted).toBe(true);
});
