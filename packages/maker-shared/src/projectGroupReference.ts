/** G1-A: private locators only. Parsing never authorizes, resolves or dispatches work. */
import { parseClientEndpointManifest } from './clientEndpointSchema';

export const PROJECT_GROUP_REFERENCE_NAMESPACE = 'cindy.project-reference';
/** Feature payload revision, NOT a Chat Server capability declaration. */
export const PROJECT_GROUP_REFERENCE_SCHEMA_REVISION = 1;
export const PROJECT_GROUP_REFERENCE_FALLBACK =
  'Private reference: authorized resolution required; unavailable on unsupported clients.';

export interface ProjectLocator {
  accountId: string;
  /** Opaque directory DeviceView.deviceId (string), not a device identity key or UUID. */
  deviceId: string;
  projectId: string;
}
export interface WorkItemLocator extends ProjectLocator {
  sessionId: string;
  bindingRevision: number;
}
/** Claimed location of the share, independent of the resource's account/device. Not provenance. */
export interface ProjectGroupSource {
  endpoint: string;
  roomId: string;
  /** Explicit null means the main timeline; omission is not inferred. */
  threadRootId: string | null;
}
export type ProjectGroupReference = (
  | { kind: 'project'; locator: ProjectLocator }
  | { kind: 'work-item'; locator: WorkItemLocator }
) & { source: ProjectGroupSource };
export interface ProjectGroupReferenceCard {
  type: 'card';
  namespace: typeof PROJECT_GROUP_REFERENCE_NAMESPACE;
  schemaRevision: typeof PROJECT_GROUP_REFERENCE_SCHEMA_REVISION;
  fallback: typeof PROJECT_GROUP_REFERENCE_FALLBACK;
  data: ProjectGroupReference;
}

const ID_MAX = 200;
const ROUTE_ID_MAX = 500;
const ENDPOINT_MAX = 2048;
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(record, key)) ? record : null;
}
function id(value: unknown, max = ID_MAX): value is string {
  // No UUID/hex assumptions and no trimming/shortening that could alias another entity.
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/\s/u.test(value) && !hasControl(value);
}

/** Reuse the existing endpoint parser: trim whitespace/trailing slashes, preserve path case. */
export function normalizeProjectGroupEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > ENDPOINT_MAX || hasControl(value)) return null;
  const parsed = parseClientEndpointManifest(JSON.stringify({ schemaVersion: 1, chatApiBaseUrl: value }),
    // Accept isolated HTTP identities too; this does not authorize connecting to an endpoint.
    { allowHttp: true });
  if (!parsed.ok || !parsed.endpoints.chatApiBaseUrl) return null;
  const endpoint = parsed.endpoints.chatApiBaseUrl;
  const url = new URL(endpoint);
  // Base identities must not carry credentials/tokens via a query or fragment.
  return url.search || url.hash ? null : endpoint;
}

export function parseProjectLocator(value: unknown): ProjectLocator | null {
  const v = fields(value, ['accountId', 'deviceId', 'projectId']);
  return v && id(v.accountId) && id(v.deviceId, ROUTE_ID_MAX) && id(v.projectId)
    ? { accountId: v.accountId, deviceId: v.deviceId, projectId: v.projectId } : null;
}
export function parseWorkItemLocator(value: unknown): WorkItemLocator | null {
  const v = fields(value, ['accountId', 'deviceId', 'projectId', 'sessionId', 'bindingRevision']);
  if (!v || !id(v.sessionId) || typeof v.bindingRevision !== 'number'
    || !Number.isSafeInteger(v.bindingRevision) || v.bindingRevision < 0) return null;
  const project = parseProjectLocator({ accountId: v.accountId, deviceId: v.deviceId, projectId: v.projectId });
  return project ? { ...project, sessionId: v.sessionId, bindingRevision: v.bindingRevision } : null;
}
export function parseProjectGroupSource(value: unknown): ProjectGroupSource | null {
  const v = fields(value, ['endpoint', 'roomId', 'threadRootId']);
  if (!v || !id(v.roomId, ROUTE_ID_MAX) || (v.threadRootId !== null && !id(v.threadRootId, ROUTE_ID_MAX))) return null;
  const endpoint = normalizeProjectGroupEndpoint(v.endpoint);
  return endpoint ? { endpoint, roomId: v.roomId, threadRootId: v.threadRootId } : null;
}
/** Null is an explicit parse failure; callers must not reinterpret failed payloads as execution. */
export function parseProjectGroupReference(value: unknown): ProjectGroupReference | null {
  const v = fields(value, ['kind', 'locator', 'source']);
  if (!v) return null;
  const source = parseProjectGroupSource(v.source);
  if (!source) return null;
  if (v.kind === 'project') {
    const locator = parseProjectLocator(v.locator);
    return locator ? { kind: 'project', locator, source } : null;
  }
  if (v.kind === 'work-item') {
    const locator = parseWorkItemLocator(v.locator);
    return locator ? { kind: 'work-item', locator, source } : null;
  }
  return null;
}

export function buildProjectGroupReferenceCard(reference: ProjectGroupReference): ProjectGroupReferenceCard {
  const data = parseProjectGroupReference(reference);
  if (!data) throw new Error('INVALID_PROJECT_GROUP_REFERENCE');
  return { type: 'card', namespace: PROJECT_GROUP_REFERENCE_NAMESPACE,
    schemaRevision: PROJECT_GROUP_REFERENCE_SCHEMA_REVISION, fallback: PROJECT_GROUP_REFERENCE_FALLBACK, data };
}
export function readProjectGroupReferenceCard(value: unknown): ProjectGroupReference | null {
  const v = fields(value, ['type', 'namespace', 'schemaRevision', 'fallback', 'data']);
  return v && v.type === 'card' && v.namespace === PROJECT_GROUP_REFERENCE_NAMESPACE
    && v.schemaRevision === PROJECT_GROUP_REFERENCE_SCHEMA_REVISION
    && v.fallback === PROJECT_GROUP_REFERENCE_FALLBACK ? parseProjectGroupReference(v.data) : null;
}
/** Local equality/grouping key only; NOT a source event ID, send operation ID or execution dedupe key. */
export function projectGroupReferenceKey(reference: ProjectGroupReference): string {
  const normalized = parseProjectGroupReference(reference);
  if (!normalized) throw new Error('INVALID_PROJECT_GROUP_REFERENCE');
  return JSON.stringify(normalized);
}
