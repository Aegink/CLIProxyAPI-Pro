import { expect, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import { proxyPoolApi, defaultProxyPoolConfig } from '../src/pro/modules/proxyPool/proxyPool';

test.each(['preflight', 'poll'] as const)(
  'proxy save does not continue on a new connection after %s cancellation',
  async (phase) => {
    let ready!: () => void;
    const reachedPendingRequest = new Promise<void>((resolve) => { ready = resolve; });
    let callsA = 0;
    const writesA: string[] = [];
    const callsB: string[] = [];
    const draft = defaultProxyPoolConfig();
    draft.nodes = [{
      id: 'a-node', label: 'from A',
      url: 'http://test-user:test-password@a-proxy.invalid:8080',
      enabled: true, weight: 1, order: 10,
    }];
    const a = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
      callsA += 1;
      if (request.method === 'PATCH') writesA.push(await request.text());
      if (phase === 'preflight' || callsA === 3) {
        ready();
        return new Promise<Response>(() => {});
      }
      return Response.json({ ready: true, listen: draft.listen, generation: 1, nodes: [] });
    } });
    const b = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => {
      callsB.push(request.method);
      return Response.json({ ready: true, listen: draft.listen, generation: 2, nodes: [] });
    } });
    try {
      apiClient.setConfig({ apiBase: `http://127.0.0.1:${a.port}`, managementKey: 'test-a' });
      const pending = proxyPoolApi.save(draft);
      await reachedPendingRequest;
      apiClient.setConfig({ apiBase: `http://127.0.0.1:${b.port}`, managementKey: 'test-b' });
      await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
      expect(callsB).toHaveLength(0);
      expect(writesA).toHaveLength(phase === 'poll' ? 1 : 0);
    } finally {
      a.stop(true);
      b.stop(true);
      apiClient.setConfig({ apiBase: '', managementKey: '' });
    }
  }
);

test('an ordinary unavailable preflight retains same-connection save fallback', async () => {
  const draft = defaultProxyPoolConfig();
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
    requests += 1;
    if (requests === 1) return new Response('unavailable', { status: 503 });
    return Response.json({ ready: true, listen: draft.listen, generation: 1, nodes: [] });
  } });
  try {
    apiClient.setConfig({ apiBase: `http://127.0.0.1:${server.port}`, managementKey: 'test-a' });
    await expect(proxyPoolApi.save(draft)).resolves.toMatchObject({ ready: true });
    expect(requests).toBe(3);
  } finally {
    server.stop(true);
    apiClient.setConfig({ apiBase: '', managementKey: '' });
  }
});
