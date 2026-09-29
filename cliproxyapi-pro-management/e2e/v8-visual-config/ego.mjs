// run.sh supplies config. Reuse the caller's one task space and keep it open.
const task = await taskSpace(config.space);
const page = task.page('p1');
const fs = await import('node:fs/promises');
await fs.mkdir(config.artifactDir, { recursive: true });
const receipt = { scenarios: [], http: [], status: 'running' };
const ensure = (value, message) => {
  if (!value) throw new Error(message);
};
const settle = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
const load = async (yaml) => {
  const result = await page.evaluate((yaml) => window.visualV8.load(yaml), yaml);
  ensure(result.ok, `load failed: ${JSON.stringify(result)}`);
  await settle();
  return page.evaluate(() => window.visualV8.values());
};
const save = async (patch) => {
  await page.evaluate((patch) => window.visualV8.patch(patch), patch);
  await settle();
  const yaml = await page.evaluate(() => window.visualV8.save());
  return { yaml, parsed: await page.evaluate((yaml) => window.visualV8.parse(yaml), yaml) };
};
const fixture = `# retained document comment
config-version: 8
server:
  host: 127.0.0.1
  port: 8317
  tls: {enable: false, cert: old.crt}
management: {allow-remote: false, disable-control-panel: true}
access:
  api-keys: [client-old]
api-keys:
  # retained provider comment
  codex:
    - name: codex-group
      base-url: https://example.invalid
      keys: [{api-key: provider-secret}]
  meta:
    - name: meta-group
      keys: [{api-key: meta-secret}]
requests:
  proxy-url: http://127.0.0.1:9999
  passthrough-headers: false
  streaming: {keepalive-seconds: 3, bootstrap-retries: 2}
  payload:
    # retained payload comment
    unknown: untouched
    default:
      - models: [{name: sample}]
        params: {temperature: 0.2}
routing:
  retry: {request-retry: 0, max-retry-interval: 3}
  cooldown: {disable-cooling: false}
oauth:
  auth-dir: /tmp/visual-auth
  providers:
    aistudio: {ws-auth: false}
    codex: {header-defaults: {user-agent: canonical-agent}}
observability:
  logs: {debug: false, logs-max-total-size-mb: 64}
multimedia: {disable-image-generation: false}
custom-extension: {keep: value}
`;
try {
  await page.goto(config.url);
  await page.waitForFunction(() => !!window.visualV8?.parse);
  for (const [name, yaml] of [
    ['duplicate-key', 'config-version: 8\naccess: {api-keys: [a]}\naccess: {api-keys: [b]}\n'],
    [
      'detached-provider-anchor',
      'config-version: 8\napi-keys: {codex: &provider []}\ncustom: *provider\n',
    ],
  ]) {
    const result = await page.evaluate((yaml) => window.visualV8.load(yaml), yaml);
    ensure(!result.ok, `${name} must explicitly reject visual editing`);
    receipt.scenarios.push({ name, rejected: result.error });
  }
  const values = await load(fixture);
  ensure(
    values.apiKeysText === 'client-old' && values.proxyUrl === 'http://127.0.0.1:9999',
    'canonical access/requests read'
  );
  ensure(
    values.port === '8317' && values.tlsCert === 'old.crt' && values.rmDisableControlPanel,
    'server/management read'
  );
  ensure(
    values.requestRetry === '0' &&
      !values.wsAuth &&
      values.codexHeaderUserAgent === 'canonical-agent',
    'retry/OAuth read'
  );
  ensure(
    values.logsMaxTotalSizeMb === '64' && values.streaming.keepaliveSeconds === '3',
    'logs/streaming read'
  );
  ensure((await save({})).yaml === fixture, 'no-op must be byte-identical');
  const first = await save({
    apiKeysText: 'client-new',
    proxyUrl: '',
    requestRetry: '4',
    tlsCert: 'new.crt',
    rmAllowRemote: true,
    debug: true,
    codexHeaderUserAgent: 'oauth-new',
    streaming: { keepaliveSeconds: '5', bootstrapRetries: '2', nonstreamKeepaliveInterval: '' },
  });
  ensure(
    first.parsed['api-keys'].codex[0].keys[0]['api-key'] === 'provider-secret' &&
      first.parsed['api-keys'].meta.length === 1,
    'provider groups survived'
  );
  ensure(
    first.parsed.access['api-keys'][0] === 'client-new' &&
      first.parsed.requests['proxy-url'] === '',
    'client keys/proxy write'
  );
  ensure(
    first.parsed.routing.retry['request-retry'] === 4 && first.parsed.server.tls.cert === 'new.crt',
    'retry/TLS write'
  );
  ensure(
    first.parsed.management['allow-remote'] && first.parsed.observability.logs.debug,
    'management/log writes'
  );
  ensure(
    first.parsed.oauth.providers.codex['header-defaults']['user-agent'] === 'oauth-new',
    'OAuth canonical write'
  );
  ensure(
    first.yaml.includes('# retained provider comment') &&
      first.yaml.includes('# retained payload comment'),
    'comments preserved'
  );
  ensure(first.parsed['custom-extension'].keep === 'value', 'unknown fields preserved');
  await load(first.yaml);
  ensure((await save({})).yaml === first.yaml, 'reload no-op byte-identical');
  const cleared = await save({ apiKeysText: '' });
  ensure(
    Array.isArray(cleared.parsed.access['api-keys']) &&
      cleared.parsed.access['api-keys'].length === 0 &&
      cleared.parsed['api-keys'].codex.length === 1,
    'clear keys preserves provider map'
  );
  receipt.scenarios.push({
    name: 'canonical',
    before: fixture,
    after: first.yaml,
    cleared: cleared.yaml,
  });

  const mixed =
    fixture +
    `proxy-url: http://legacy.invalid
request-retry: 9
debug: true
codex-header-defaults: {user-agent: legacy-agent, beta-features: legacy-beta}
requests-extra: unknown
payload:
  filter:
    - models: [{name: old-model}]
      params: [old-param]
`;
  const mixedValues = await load(mixed);
  ensure(
    mixedValues.requestRetry === '0' &&
      !mixedValues.debug &&
      mixedValues.codexHeaderUserAgent === 'canonical-agent',
    'canonical false/zero/leaf presence precedence'
  );
  ensure(
    mixedValues.codexHeaderBetaFeatures === 'legacy-beta' &&
      mixedValues.payloadFilterRules.length === 1,
    'mixed missing leaves inherit legacy'
  );
  const mixedSaved = await save({
    codexHeaderBetaFeatures: 'shared-new',
    maxRetryInterval: '',
    payloadDefaultRules: [],
  });
  ensure(
    mixedSaved.parsed['codex-header-defaults']['beta-features'] === 'shared-new' &&
      !('beta-features' in mixedSaved.parsed.oauth.providers.codex['header-defaults']),
    'legacy provider scope retained'
  );
  ensure(
    !('max-retry-interval' in mixedSaved.parsed.routing.retry),
    'clear canonical numeric value'
  );
  ensure(
    !('default' in mixedSaved.parsed.requests.payload) &&
      mixedSaved.parsed.payload.filter.length === 1 &&
      mixedSaved.parsed.requests.payload.unknown === 'untouched',
    'mixed payload edited in correct layout'
  );
  receipt.scenarios.push({ name: 'mixed', before: mixed, after: mixedSaved.yaml });

  const legacy =
    '# legacy comment\napi-keys: [legacy-client]\nproxy-url: http://old.invalid\ncodex-header-defaults: {user-agent: shared-old}\n';
  await load(legacy);
  const legacySaved = await save({
    apiKeysText: 'legacy-new',
    proxyUrl: 'http://new.invalid',
    codexHeaderUserAgent: 'shared-new',
  });
  ensure(
    legacySaved.parsed['api-keys'][0] === 'legacy-new' &&
      !legacySaved.parsed.access &&
      !legacySaved.parsed.oauth,
    'legacy layout/scope retained'
  );
  receipt.scenarios.push({ name: 'legacy', before: legacy, after: legacySaved.yaml });

  await load('{}');
  const emptySaved = await save({ debug: true, wsAuth: false });
  ensure(emptySaved.parsed.debug === true && emptySaved.parsed['ws-auth'] === false,
    'empty legacy document writes primitive values');
  receipt.scenarios.push({ name: 'empty-legacy', after: emptySaved.yaml });

  await load('config-version: 8\nantigravity: {sensitive-words: [shared]}\noauth:\n  providers:\n    antigravity: {sensitive-words: [oauth]}\n');
  const oauthCleared = await save({ antigravitySensitiveWords: [] });
  ensure(oauthCleared.parsed.oauth.providers.antigravity['sensitive-words'].length === 0 &&
    oauthCleared.parsed.antigravity['sensitive-words'][0] === 'shared',
    'clearing OAuth override preserves shared legacy scope');
  receipt.scenarios.push({ name: 'oauth-clear-scope', after: oauthCleared.yaml });

  for (const [name, yaml, patch, path, expected] of [
    ['v8-null-routing', 'config-version: 8\nrouting: null\n', { requestRetry: '3' }, ['routing', 'retry', 'request-retry'], 3],
    ['legacy-null-tls', 'tls: null\n', { tlsEnable: true }, ['tls', 'enable'], true],
    ['legacy-null-plugins', 'plugins: null\n', { pluginsEnabled: true }, ['plugins', 'enabled'], true],
    ['legacy-null-routing', 'routing: null\n', { routingStrategy: 'fill-first' }, ['routing', 'strategy'], 'fill-first'],
  ]) {
    await load(yaml);
    ensure((await save({})).yaml === yaml, `${name}: no-op preserves null`);
    const updated = await save({ ...patch, debug: true });
    ensure(path.reduce((value, key) => value?.[key], updated.parsed) === expected,
      `${name}: nested edit survives null parent`);
    ensure((updated.parsed.observability?.logs?.debug ?? updated.parsed.debug) === true,
      `${name}: unrelated edit is not discarded`);
    await load(updated.yaml);
    ensure((await save({})).yaml === updated.yaml, `${name}: reload is stable`);
    receipt.scenarios.push({ name, before: yaml, after: updated.yaml });
  }

  if (config.coreUrl) {
    ensure(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.coreUrl).hostname),
      'Core HTTP target must be disposable loopback'
    );
    const headers = { Authorization: `Bearer ${config.managementKey}` };
    const call = async (path, options = {}) => {
      const response = await fetch(`${config.coreUrl}${path}`, options);
      const body = await response.text();
      receipt.http.push({ path, method: options.method || 'GET', status: response.status, body });
      return { status: response.status, body };
    };
    const original = await call('/v0/management/config.yaml', { headers });
    ensure(original.status === 200, 'fetch actual Core YAML');
    try {
      const originalValues = await load(original.body);
      const updated = await save({ apiKeysText: 'visual-e2e-replacement-key', requestRetry: '4' });
      const saved = await call('/v0/management/config.yaml', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/yaml' },
        body: updated.yaml,
      });
      ensure(saved.status === 200, 'Core accepts visual YAML');
      let effective;
      for (let attempt = 0; attempt < 30; attempt++) {
        effective = await call('/v0/management/config', { headers });
        if (
          effective.status === 200 &&
          JSON.parse(effective.body)['api-keys']?.includes('visual-e2e-replacement-key')
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      ensure(
        JSON.parse(effective.body)['request-retry'] === 4,
        'effective retry matches visual output'
      );
      // Config writes precede the asynchronous file-watcher access reload.
      let authenticated;
      for (let attempt = 0; attempt < 50; attempt++) {
        authenticated = await call('/v1/models', {
          headers: { Authorization: 'Bearer visual-e2e-replacement-key' },
        });
        if (authenticated.status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      ensure(authenticated.status === 200, 'new client key authenticates after reload');
      ensure(
        (await call('/v1/models', { headers: { Authorization: 'Bearer visual-e2e-invalid-key' } }))
          .status === 401,
        'invalid key rejected'
      );
      const canonicalKeys = await call('/v8/management/config/access/api-keys', { headers });
      ensure(
        canonicalKeys.status === 200 &&
          JSON.parse(canonicalKeys.body).includes('visual-e2e-replacement-key'),
        'canonical access endpoint matches visual client key'
      );
      const persisted = await call('/v0/management/config.yaml', { headers });
      ensure(persisted.status === 200, 'read persisted visual YAML');
      const providers = await page.evaluate(
        ({ before, after }) => ({
          before: window.visualV8.parse(before)['api-keys'],
          after: window.visualV8.parse(after)['api-keys'],
        }),
        { before: original.body, after: persisted.body }
      );
      if (providers.before && !Array.isArray(providers.before)) {
        ensure(
          JSON.stringify(providers.before) === JSON.stringify(providers.after),
          'real Core preserves all upstream provider groups'
        );
      }
      const oldKey = originalValues.apiKeysText
        .split('\n')
        .find((key) => key && key !== 'visual-e2e-replacement-key');
      if (oldKey)
        ensure(
          (await call('/v1/models', { headers: { Authorization: `Bearer ${oldKey}` } })).status ===
            401,
          'old key revoked'
        );
      receipt.scenarios.push({
        name: 'actual-core-http',
        before: original.body,
        after: updated.yaml,
      });
    } finally {
      const restored = await call('/v0/management/config.yaml', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/yaml' },
        body: original.body,
      });
      ensure(restored.status === 200, 'restore disposable Core config');
    }
  }
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = String(error);
  throw error;
} finally {
  receipt.snapshots = await page.evaluate(() => window.visualV8?.receipt() ?? []);
  await fs.writeFile(`${config.artifactDir}/receipt.json`, JSON.stringify(receipt, null, 2));
  try {
    await page.screenshot({ path: `${config.artifactDir}/visual-config.png` });
  } catch (error) {
    receipt.screenshotError = String(error);
    await fs.writeFile(`${config.artifactDir}/receipt.json`, JSON.stringify(receipt, null, 2));
  }
  console.log(
    JSON.stringify({
      status: receipt.status,
      artifact: `${config.artifactDir}/receipt.json`,
      space: task.spaceId,
    })
  );
}
