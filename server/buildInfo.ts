import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

type BuildEnvironment = 'development' | 'test' | 'staging' | 'production' | 'unknown';
type SourceState = 'clean' | 'dirty' | 'unknown';

export interface BuildInfo {
  service: 'MarshGO-Server';
  serviceVersion: string;
  apiContract: 'v1';
  buildId: string | null;
  commitSha: string | null;
  builtAt: string | null;
  environment: BuildEnvironment;
  sourceState: SourceState;
  instanceId: string;
}

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
const serviceVersion = typeof packageMetadata.version === 'string' ? packageMetadata.version : 'unknown';
const instanceId = crypto.randomUUID();

function boundedIdentifier(value: string | undefined, pattern: RegExp): string | null {
  if (!value || value.length > 128 || !pattern.test(value)) return null;
  return value;
}

function normalizedEnvironment(value: string | undefined): BuildEnvironment {
  switch (value) {
    case 'development':
    case 'test':
    case 'staging':
    case 'production':
      return value;
    default:
      return 'unknown';
  }
}

function normalizedSourceState(value: string | undefined): SourceState {
  switch (value) {
    case 'clean':
    case 'dirty':
      return value;
    default:
      return 'unknown';
  }
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const rawBuiltAt = env.MARSHGO_BUILD_TIME;
  const builtAt = rawBuiltAt && rawBuiltAt.length <= 40 && Number.isFinite(Date.parse(rawBuiltAt))
    ? new Date(rawBuiltAt).toISOString()
    : null;

  return {
    service: 'MarshGO-Server',
    serviceVersion,
    apiContract: 'v1',
    buildId: boundedIdentifier(env.MARSHGO_BUILD_ID, /^[A-Za-z0-9._:-]+$/),
    commitSha: boundedIdentifier(env.MARSHGO_BUILD_SHA, /^[a-f0-9]{7,64}$/i),
    builtAt,
    environment: normalizedEnvironment(env.NODE_ENV),
    sourceState: normalizedSourceState(env.MARSHGO_SOURCE_STATE),
    instanceId,
  };
}
