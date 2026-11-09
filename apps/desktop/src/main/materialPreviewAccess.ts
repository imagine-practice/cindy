import { randomBytes } from 'node:crypto';

type ReadGrant = () => Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>;
type RangeParser = (value: string | null, size: number) =>
  { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' } | null;
const grants = new Map<string, { read: ReadGrant; expires: number }>();
const lifetime = 10 * 60 * 1000;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Main-only capabilities. Expiry bounds retention, never substitutes for live authorization. */
export function issueMaterialPreview(read: ReadGrant): string {
  for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key);
  const token = randomBytes(32).toString('hex');
  grants.set(token, { read, expires: Date.now() + lifetime });
  const timer = setTimeout(() => grants.delete(token), lifetime);
  timer.unref();
  return `xdt-file://material/${token}`;
}

/** Main-only loader shared by the protocol and the narrowly scoped PDF IPC adapter. */
export async function readMaterialPreviewGrant(raw: unknown): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  if (typeof raw !== 'string' || !/^xdt-file:\/\/material\/[a-f0-9]{64}$/.test(raw)) throw Error('Invalid material grant');
  const token = raw.slice('xdt-file://material/'.length), grant = grants.get(token);
  if (!grant || grant.expires <= Date.now()) { grants.delete(token); throw Error('Material grant unavailable'); }
  try { return await grant.read(); }
  catch (error) { grants.delete(token); throw error; }
}

/** Reserved host on the existing controlled file channel; never falls through to raw paths. */
export async function readMaterialPreview(request: Request, parseRange: RangeParser): Promise<Response> {
  const url = new URL(request.url);
  const denied = () => new Response(null, { status: 403, headers });
  if (request.method !== 'GET' || url.protocol !== 'xdt-file:' || url.host !== 'material' ||
      url.username || url.password || url.search || url.hash || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return denied();
  const token = url.pathname.slice(1), grant = grants.get(token);
  if (!grant || grant.expires <= Date.now()) { grants.delete(token); return denied(); }
  try {
    const { bytes, mime } = await readMaterialPreviewGrant(request.url);
    const range = parseRange(request.headers.get('Range'), bytes.length);
    const common = { ...headers, 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
    if (range?.kind === 'unsatisfiable') return new Response(null, {
      status: 416, headers: { ...common, 'Content-Range': `bytes */${bytes.length}` },
    });
    const body = range ? bytes.slice(range.start, range.end + 1) : bytes;
    return new Response(body, { status: range ? 206 : 200, headers: {
      ...common, 'Content-Length': String(body.length),
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` } : {}),
    } });
  } catch {
    // No paths, grants, or business error details in protocol errors/logs.
    grants.delete(token);
    return denied();
  }
}
