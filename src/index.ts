import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { attachIntrospectionRoutes } from './introspection';

export type UmbrellaMode = 'strict' | 'advisory' | 'off';
export type KernelEnvelope = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  identity: string;
  governanceContext: Record<string, unknown>;
};

type Fetcher = { fetch(request: Request): Promise<Response> };
type KernelNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): Fetcher;
};

export type Bindings = {
  PORTAL_KERNEL: KernelNamespace;
  MAX_OS_1: Fetcher;
  IDENTITY_JWT_SECRET: string;
  IDENTITY_JWT_ISSUER?: string;
  IDENTITY_JWT_AUDIENCE?: string;
  PLANETARY_MODE?: string;
  UMBRELLA_ENFORCEMENT?: string;
};

export type GovernanceMetadata = {
  mode: UmbrellaMode;
  decision: 'allowed' | 'denied' | 'advisory' | 'bypassed';
  deltas: Array<Record<string, unknown>>;
};

export type KernelLane = {
  name: string;
  result: {
    results: Array<{
      result: {
        data: Record<string, unknown>;
        meta: { source: string; governance: UmbrellaMode };
      };
    }>;
  };
};

export type KernelSuccess = {
  ok: true;
  data: Record<string, unknown>;
  lanes: KernelLane[];
  meta: {
    messageId: string;
    type: string;
    umbrella: string;
    identity: { propagated: true };
    governance: GovernanceMetadata;
  };
};

export type KernelFailure = {
  ok: false;
  error: { code: string; message: string };
  meta?: {
    messageId?: string;
    type?: string;
    governance?: GovernanceMetadata;
  };
};

export type KernelResult = KernelSuccess | KernelFailure;

type UniverseState = {
  tick: number;
  properties: Record<string, unknown>;
  lastOperation: null | { messageId: string; type: string };
};

const KERNEL_OBJECT_NAME = 'portal-kernel';
const KERNEL_BRIDGE_URL = 'https://portal-kernel.invalid/api/kernel/message';
const MAX_OS_BRIDGE_URL = 'https://max-os-1.invalid/kernel/message';

const UNIVERSE_STATE_KEY = 'universe';
const INTROSPECTION_PREFIX = 'introspection.';

const UMBRELLA_OPERATIONS: Record<string, string> = {
  '/umbrella/identity/license': 'identity.physics.license',
  '/umbrella/governance/license': 'governance.engine.license',
  '/umbrella/apex/advisory': 'apex.alignment.advisory',
  '/umbrella/sim/pack': 'umbrella.sim.pack',
  '/umbrella/market/forecast': 'umbrella.market.forecast',
  '/umbrella/identity/mirror': 'umbrella.identity.mirror',
  '/umbrella/crossworld/access': 'umbrella.crossworld.access',
  '/umbrella/structural/truth/license': 'structural.truth.license'
};

export const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'OPTIONS']
}));

app.get('/', (c) =>
  c.json({
    status: 'Portal-OS live',
    worker: 'planetary-max',
    mode: c.env.PLANETARY_MODE ?? 'single',
    umbrella: resolveUmbrellaMode(c.env.UMBRELLA_ENFORCEMENT)
  })
);

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'planetary-max',
    umbrella: resolveUmbrellaMode(c.env.UMBRELLA_ENFORCEMENT)
  })
);

app.post('/api/kernel/message', async (c) => {
  const value = await parseEnvelope(c.req.raw, c.req.header('Authorization'), c.env);
  return value instanceof Response ? value : kernelResponse(c.env, value);
});

app.get('/api/autonomy', (c) =>
  routeKernelMessage(c.env, c.req.header('Authorization'), 'autonomy.state', {})
);

app.get('/universe/state', (c) =>
  routeKernelMessage(c.env, c.req.header('Authorization'), 'universe.state', {})
);

app.get('/universe/umbrella', (c) =>
  routeKernelMessage(c.env, c.req.header('Authorization'), 'universe.umbrella', {})
);

for (const [path, type] of Object.entries(UMBRELLA_OPERATIONS)) {
  app.post(path, async (c) => {
    const value = await parsePayload(c.req.raw, c.req.header('Authorization'), c.env);
    return value instanceof Response
      ? value
      : kernelResponse(
          c.env,
          createEnvelope(type, value.payload, value.identity, value.governanceContext, c.env.UMBRELLA_ENFORCEMENT)
        );
  });
}

app.post('/universe/tick', async (c) => {
  const value = await parsePayload(c.req.raw, c.req.header('Authorization'), c.env, true);
  return value instanceof Response
    ? value
    : kernelResponse(
        c.env,
        createEnvelope('universe.tick', value.payload, value.identity, value.governanceContext, c.env.UMBRELLA_ENFORCEMENT)
      );
});

app.post('/os/kernel/message', async (c) => {
  const parsed = await parseEnvelope(c.req.raw, c.req.header('Authorization'), c.env);
  if (parsed instanceof Response) return parsed;

  try {
    const preflight = {
      ...parsed,
      type: 'umbrella.os',
      payload: { ...parsed.payload, operation: parsed.type }
    };

    const governed = await callKernel(c.env, preflight);
    const checked = await readKernelResult(governed, preflight, 'PortalKernel');

    if (!checked.ok) return resultResponse(checked, governed.status);

    const response = await c.env.MAX_OS_1.fetch(
      new Request(MAX_OS_BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      })
    );

    return resultResponse(await readKernelResult(response, parsed, 'MAX-OS-1'), response.status);
  } catch {
    return failureResponse('MAX_OS_UNAVAILABLE', 'MAX-OS-1 bridge unavailable', 503);
  }
});

attachIntrospectionRoutes(app);

async function routeKernelMessage(
  env: Bindings,
  authorization: string | undefined,
  type: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const identity = await authenticatedIdentity(authorization, env);
  return identity instanceof Response
    ? identity
    : kernelResponse(
        env,
        createEnvelope(type, payload, identity, { surface: 'worker-api' }, env.UMBRELLA_ENFORCEMENT)
      );
}

async function parseEnvelope(
  request: Request,
  authorization: string | undefined,
  env: Bindings
): Promise<KernelEnvelope | Response> {
  const identity = await authenticatedIdentity(authorization, env);
  if (identity instanceof Response) return identity;

  const body = await readJsonObject(request, 'Request body must be JSON');
  if (body instanceof Response) return body;

  if (
    typeof body.type !== 'string' ||
    !body.type.trim() ||
    (body.payload !== undefined && !isRecord(body.payload))
  ) {
    return failureResponse('INVALID_MESSAGE', 'type and object payload are required', 400);
  }

  return createEnvelope(
    body.type,
    body.payload ?? {},
    identity,
    isRecord(body.governanceContext) ? body.governanceContext : {},
    env.UMBRELLA_ENFORCEMENT
  );
}

async function parsePayload(
  request: Request,
  authorization: string | undefined,
  env: Bindings,
  optionalBody = false
): Promise<{ identity: string; payload: Record<string, unknown>; governanceContext: Record<string, unknown> } | Response> {
  const identity = await authenticatedIdentity(authorization, env);
  if (identity instanceof Response) return identity;

  if (optionalBody && !request.headers.get('Content-Type')?.includes('application/json')) {
    return { identity, payload: {}, governanceContext: {} };
  }

  const body = await readJsonObject(request, 'Request body must be JSON');
  if (body instanceof Response) return body;

  const governanceContext = isRecord(body.governanceContext) ? body.governanceContext : {};
  const { governanceContext: _ignored, ...payload } = body;

  return { identity, payload, governanceContext };
}

async function readJsonObject(
  request: Request,
  message: string
): Promise<Record<string, unknown> | Response> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : failureResponse('INVALID_JSON', message, 400);
  } catch {
    return failureResponse('INVALID_JSON', message, 400);
  }
}

export function createEnvelope(
  type: string,
  payload: Record<string, unknown>,
  identity: string,
  governanceContext: Record<string, unknown>,
  configuredMode?: string
): KernelEnvelope {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    identity,
    governanceContext: {
      ...governanceContext,
      umbrellaMode: resolveUmbrellaMode(configuredMode)
    }
  };
}

async function kernelResponse(env: Bindings, envelope: KernelEnvelope): Promise<Response> {
  try {
    const response = await callKernel(env, envelope);
    return resultResponse(await readKernelResult(response, envelope, 'PortalKernel'), response.status);
  } catch {
    return failureResponse('KERNEL_UNAVAILABLE', 'Kernel bridge unavailable', 503);
  }
}

export async function callKernel(env: Bindings, envelope: KernelEnvelope): Promise<Response> {
  const kernel = env.PORTAL_KERNEL.get(env.PORTAL_KERNEL.idFromName(KERNEL_OBJECT_NAME));
  return kernel.fetch(
    new Request(KERNEL_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope)
    })
  );
}

export async function readKernelResult(
  response: Response,
  envelope: KernelEnvelope,
  fallbackSource: string
): Promise<KernelResult> {
  let value: unknown;

  try {
    value = await response.json();
  } catch {
    return failureResult('INVALID_KERNEL_RESPONSE', 'Kernel returned invalid JSON', envelope);
  }

  if (!isRecord(value)) {
    return failureResult('INVALID_KERNEL_RESPONSE', 'Kernel returned an invalid result', envelope);
  }

  if (value.ok === false) {
    const error = isRecord(value.error) ? value.error : {};
    return failureResult(
      typeof error.code === 'string' ? error.code : 'KERNEL_ERROR',
      typeof error.message === 'string' ? error.message : 'Kernel request failed',
      envelope
    );
  }

  if (!response.ok) {
    return failureResult('KERNEL_ERROR', 'Kernel request failed', envelope);
  }

  const mode = resolveEnvelopeMode(envelope);
  const lanes = Array.isArray(value.lanes)
    ? sanitizeLanes(value.lanes, fallbackSource, mode)
    : [];

  const data = isRecord(value.data) ? value.data : extractLaneData(lanes);

  if (!lanes.length) {
    lanes.push(makeLane(laneForType(envelope.type), data, fallbackSource, mode));
  }

  const meta = isRecord(value.meta) ? value.meta : {};

  return {
    ok: true,
    data,
    lanes,
    meta: {
      messageId: typeof meta.messageId === 'string' ? meta.messageId : envelope.id,
      type: typeof meta.type === 'string' ? meta.type : envelope.type,
      umbrella: typeof meta.umbrella === 'string' ? meta.umbrella : umbrellaUpdateName(envelope.type),
      identity: { propagated: true },
      governance: governanceFromUnknown(meta.governance, envelope)
    }
  };
}

function sanitizeLanes(value: unknown[], source: string, mode: UmbrellaMode): KernelLane[] {
  return value
    .filter(isRecord)
    .map((candidate) =>
      makeLane(
        typeof candidate.name === 'string' ? candidate.name : 'kernel',
        extractCandidateData(candidate),
        source,
        mode
      )
    );
}

function extractCandidateData(value: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(value.data)) return value.data;

  const result =
    isRecord(value.result) && Array.isArray(value.result.results)
      ? value.result.results[0]
      : undefined;

  return isRecord(result) &&
    isRecord(result.result) &&
    isRecord(result.result.data)
    ? result.result.data
    : {};
}

export function extractLaneData(lanes: KernelLane[]): Record<string, unknown> {
  return lanes[0]?.result.results[0]?.result.data ?? {};
}

export function resultResponse(result: KernelResult, upstreamStatus: number): Response {
  return Response.json(result, {
    status: result.ok
      ? upstreamStatus >= 200 && upstreamStatus < 300
        ? upstreamStatus
        : 200
      : errorStatus(result.error.code, upstreamStatus)
  });
}

function errorStatus(code: string, upstream = 500): number {
  if (code === 'UNAUTHENTICATED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'INVALID_JSON' || code === 'INVALID_MESSAGE') return 400;
  if (code === 'INVALID_KERNEL_RESPONSE') return 502;
  return upstream >= 400 ? upstream : 500;
}

export function failureResponse(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

function failureResult(code: string, message: string, envelope?: KernelEnvelope): KernelFailure {
  return {
    ok: false,
    error: { code, message },
    ...(envelope
      ? {
          meta: {
            messageId: envelope.id,
            type: envelope.type,
            governance: defaultGovernance(resolveEnvelopeMode(envelope))
          }
        }
      : {})
  };
}

async function authenticatedIdentity(
  header: string | undefined,
  env: Pick<Bindings, 'IDENTITY_JWT_SECRET' | 'IDENTITY_JWT_ISSUER' | 'IDENTITY_JWT_AUDIENCE'>
): Promise<string | Response> {
  const token = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim();
  if (!token) return failureResponse('UNAUTHENTICATED', 'Bearer token required', 401);

  if (!env.IDENTITY_JWT_SECRET || !(await verifyJwt(token, env))) {
    return failureResponse(
      env.IDENTITY_JWT_SECRET ? 'UNAUTHENTICATED' : 'IDENTITY_UNAVAILABLE',
      env.IDENTITY_JWT_SECRET ? 'Bearer token required' : 'Identity verification is not configured',
      env.IDENTITY_JWT_SECRET ? 401 : 503
    );
  }

  return token;
}

async function verifyJwt(
  token: string,
  env: Pick<Bindings, 'IDENTITY_JWT_SECRET' | 'IDENTITY_JWT_ISSUER' | 'IDENTITY_JWT_AUDIENCE'>
): Promise<boolean> {
  try {
    const [encodedHeader, encodedClaims, signature] = token.split('.');
    if (!encodedHeader || !encodedClaims || !signature) return false;

    const header = JSON.parse(new TextDecoder().decode(base64Url(encodedHeader)));
    const claims = JSON.parse(new TextDecoder().decode(base64Url(encodedClaims)));

    if (header.alg !== 'HS256') return false;
    if (typeof claims.sub !== 'string' || !claims.sub.trim()) return false;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return false;

    if (env.IDENTITY_JWT_ISSUER && claims.iss !== env.IDENTITY_JWT_ISSUER) return false;

    if (
      env.IDENTITY_JWT_AUDIENCE &&
      !(
        claims.aud === env.IDENTITY_JWT_AUDIENCE ||
        (Array.isArray(claims.aud) && claims.aud.includes(env.IDENTITY_JWT_AUDIENCE))
      )
    ) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.IDENTITY_JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    return crypto.subtle.verify(
      'HMAC',
      key,
      base64Url(signature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)
    );
  } catch {
    return false;
  }
}

function base64Url(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function resolveUmbrellaMode(value: string | undefined): UmbrellaMode {
  return value === 'advisory' || value === 'off' || value === 'strict' ? value : 'strict';
}

function resolveEnvelopeMode(envelope: KernelEnvelope): UmbrellaMode {
  return resolveUmbrellaMode(
    typeof envelope.governanceContext.umbrellaMode === 'string'
      ? envelope.governanceContext.umbrellaMode
      : undefined
  );
}

function defaultGovern
