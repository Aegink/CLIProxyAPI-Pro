import { isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import type { Node } from 'yaml';

type Document = ReturnType<typeof parseDocument>;
type Path = string[];

// Core config_v8.go YAML boundary prefixes; runtime/wire values remain legacy-shaped.
const PATHS = [
  ['host', 'server.host'],
  ['port', 'server.port'],
  ['trusted-proxies', 'server.trusted-proxies'],
  ['tls', 'server.tls'],
  ['commercial-mode', 'server.commercial-mode'],
  ['discovery', 'server.discovery'],
  ['remote-management', 'management'],
  ['api-keys', 'access.api-keys'],
  ['credential-concurrency', 'credentials.concurrency'],
  ['credential-in-flight', 'credentials.in-flight'],
  ['force-model-prefix', 'routing.force-model-prefix'],
  ['request-retry', 'routing.retry.request-retry'],
  ['max-retry-credentials', 'routing.retry.max-retry-credentials'],
  ['max-retry-interval', 'routing.retry.max-retry-interval'],
  ['disable-cooling', 'routing.cooldown.disable-cooling'],
  ['save-cooldown-status', 'routing.cooldown.save-cooldown-status'],
  ['transient-error-cooldown-seconds', 'routing.cooldown.transient-error-cooldown-seconds'],
  ['proxy-url', 'requests.proxy-url'],
  ['passthrough-headers', 'requests.passthrough-headers'],
  ['nonstream-keepalive-interval', 'requests.nonstream-keepalive-interval'],
  ['streaming', 'requests.streaming'],
  ['payload', 'requests.payload'],
  ['auth-dir', 'oauth.auth-dir'],
  ['auth-auto-refresh-workers', 'oauth.auth-auto-refresh-workers'],
  ['oauth-model-alias', 'oauth.model-alias'],
  ['oauth-excluded-models', 'oauth.excluded-models'],
  ['oauth-request-scoped-errors', 'oauth.request-scoped-errors'],
  ['ws-auth', 'oauth.providers.aistudio.ws-auth'],
  ['codex', 'oauth.providers.codex'],
  ['codex-header-defaults', 'oauth.providers.codex.header-defaults'],
  ['claude', 'oauth.providers.claude'],
  ['claude-code', 'oauth.providers.claude.claude-code'],
  ['disable-claude-cloak-mode', 'oauth.providers.claude.disable-claude-cloak-mode'],
  ['claude-header-defaults', 'oauth.providers.claude.header-defaults'],
  ['antigravity', 'oauth.providers.antigravity'],
  ['antigravity-signature-cache-enabled', 'oauth.providers.antigravity.signature-cache-enabled'],
  ['antigravity-signature-bypass-strict', 'oauth.providers.antigravity.signature-bypass-strict'],
  ['quota-exceeded.antigravity-credits', 'oauth.providers.antigravity.antigravity-credits'],
  ['xai', 'oauth.providers.xai'],
  ['devin', 'oauth.providers.devin'],
  ['disable-image-generation', 'multimedia.disable-image-generation'],
  ['gpt-image-2-base-model', 'multimedia.gpt-image-2-base-model'],
  ['video-result-auth-cache-ttl', 'multimedia.video-result-auth-cache-ttl'],
  ['debug', 'observability.logs.debug'],
  ['logging-to-file', 'observability.logs.logging-to-file'],
  ['logs-max-total-size-mb', 'observability.logs.logs-max-total-size-mb'],
  ['request-log', 'observability.logs.request-log'],
  ['error-logs-max-files', 'observability.logs.error-logs-max-files'],
  ['usage-statistics-enabled', 'observability.usage.usage-statistics-enabled'],
  [
    'redis-usage-queue-retention-seconds',
    'observability.usage.redis-usage-queue-retention-seconds',
  ],
  ['pprof', 'observability.pprof'],
] as const;

// Core treats map-typed fields as whole values; only struct fields inherit
// missing canonical leaves from legacy siblings.
const MAP_FIELDS = new Set([
  'oauth-excluded-models',
  'oauth-model-alias',
  'oauth-request-scoped-errors',
]);

function canonicalPath(path: Path): Path {
  const key = path.join('.');
  const mapping = PATHS.find(([old]) => key === old || key.startsWith(`${old}.`));
  return mapping ? `${mapping[1]}${key.slice(mapping[0].length)}`.split('.') : path;
}

function legacyPresent(doc: Document, path: Path): boolean {
  return (
    doc.hasIn(path) &&
    !(path.length === 1 && path[0] === 'api-keys' && isMap(doc.getIn(path, true)))
  );
}

function isV8(doc: Document): boolean {
  return (
    doc.has('config-version') ||
    isMap(doc.get('api-keys', true)) ||
    [
      'server',
      'management',
      'access',
      'credentials',
      'requests',
      'oauth',
      'multimedia',
      'observability',
    ].some((key) => doc.has(key)) ||
    ['retry', 'cooldown', 'force-model-prefix'].some((key) => doc.hasIn(['routing', key]))
  );
}

// Merge only in the disposable editing view. The source AST, including provider
// groups, unknown fields and comments, is never serialized from this view.
function mergeView(doc: Document, path: Path, value: unknown): void {
  if (isMap(value) && !MAP_FIELDS.has(path.join('.'))) {
    if (!isMap(doc.getIn(path, true))) doc.setIn(path, doc.createNode({}));
    for (const pair of value.items) {
      mergeView(doc, [...path, String(pair.key)], pair.value);
    }
  } else {
    doc.setIn(path, (value as Node | null)?.clone() ?? null);
  }
}

function editingView(source: Document): Document {
  if (source.errors.length > 0) throw new Error(source.errors[0].message);
  // Moving canonical nodes can detach alias anchors. Reject this special case
  // explicitly; the raw YAML editor remains available and no save is attempted.
  if (isV8(source)) {
    visit(source, {
      Alias() {
        throw new Error('Visual editing of v8 YAML aliases is not supported; use the YAML editor.');
      },
    });
  }
  const view = source.clone();
  if (isMap(view.get('api-keys', true))) view.delete('api-keys');
  for (const [old, current] of PATHS) {
    if (source.hasIn(current.split('.'))) {
      mergeView(view, old.split('.'), source.getIn(current.split('.'), true));
    }
  }
  return view;
}

export function readVisualConfigLayout(yaml: string): Record<string, unknown> {
  return editingView(parseDocument(yaml)).toJS() as Record<string, unknown>;
}

function deletePath(doc: Document, path: Path): void {
  doc.deleteIn(path);
  for (let length = path.length - 1; length > 0; length--) {
    const parent = path.slice(0, length);
    const value = doc.getIn(parent, true);
    if (!isMap(value) || value.items.length > 0) break;
    doc.deleteIn(parent);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setPath(doc: Document, path: Path, value: unknown): void {
  for (let length = 1; length < path.length; length++) {
    const parentPath = path.slice(0, length);
    const parent = doc.getIn(parentPath, true);
    // Null sections mean defaults; materialize them only when a child changes.
    if (isScalar(parent) && parent.value === null) {
      const map = doc.createNode({});
      map.comment = parent.comment;
      map.commentBefore = parent.commentBefore;
      map.spaceBefore = parent.spaceBefore;
      doc.setIn(parentPath, map);
    }
  }
  doc.setIn(path, value);
}

// Reconcile changed leaves only. Presence selects precedence, including false,
// zero and empty values. Existing legacy leaves retain their scope, especially
// provider defaults which apply to both OAuth and API-key credentials in Core.
export function editVisualConfigLayout(yaml: string) {
  const source = parseDocument(yaml);
  const doc = editingView(source);
  const before = doc.toJS();
  const canonical = isV8(source);
  return {
    doc,
    finish(): string {
      let changed = false;
      const reconcile = (path: Path, previous: unknown, next: unknown): void => {
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        if ((record(previous) || record(next)) && !MAP_FIELDS.has(path.join('.'))) {
          const keys = new Set([
            ...Object.keys(record(previous) ? previous : {}),
            ...Object.keys(record(next) ? next : {}),
          ]);
          for (const key of keys)
            reconcile(
              [...path, key],
              record(previous) ? previous[key] : undefined,
              record(next) ? next[key] : undefined
            );
          return;
        }
        changed = true;
        const current = canonicalPath(path);
        const mapped = current.join('.') !== path.join('.');
        const destination =
          mapped && (source.hasIn(current) || (!legacyPresent(source, path) && canonical))
            ? current
            : path;
        if (next === undefined) {
          const oauthOnly =
            destination === current && current.slice(0, 2).join('.') === 'oauth.providers';
          if (
            (path.length === 1 && path[0] === 'api-keys') ||
            (oauthOnly && Array.isArray(previous))
          ) {
            // Empty OAuth lists retain their scope and the separate shared legacy
            // value; deleting them would reactivate or erase the shared setting.
            setPath(source, destination, source.createNode([]));
          } else {
            deletePath(source, destination);
          }
          if (mapped && destination === current && !oauthOnly && legacyPresent(source, path))
            deletePath(source, path);
        } else {
          // yaml's setIn may store a raw JS scalar/array for a newly inserted key.
          const value = doc.getIn(path, true);
          setPath(source, destination, isNode(value) ? value.clone() : source.createNode(value));
        }
      };
      reconcile([], before, doc.toJS());
      return changed ? source.toString({ indent: 2, lineWidth: 120, minContentWidth: 0 }) : yaml;
    },
  };
}
