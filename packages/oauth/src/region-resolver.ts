import { kimiCodeEnvBaseUrl } from './managed-kimi-code';
import {
  clearKimiRegionCache,
  readKimiRegionCache,
  writeKimiRegionCache,
} from './region-cache';
import {
  collectLocalRegionSignals,
  detectKimiRegionFromLocalSignals,
  type LocalRegionSignals,
} from './region-local';
import {
  resolveKimiRegionDetailed,
  type KimiRegionResolution,
} from './region';

export interface KimiRegionOAuthRef {
  readonly key: string;
  readonly oauthHost?: string;
}

export type KimiRegionAuthSnapshot =
  | { readonly status: 'unknown' }
  | { readonly status: 'logged-out' }
  | { readonly status: 'logged-in'; readonly ref: KimiRegionOAuthRef };

export interface CreateKimiRegionResolverOptions {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readAuth: () => KimiRegionAuthSnapshot;
  readonly readMarker?: boolean;
  readonly allowLocalInference?: boolean;
  readonly collectSignals?: () => LocalRegionSignals;
}

export interface KimiRegionResolver {
  current(): KimiRegionResolution;
  refresh(): KimiRegionResolution;
}

interface CachedResolution {
  readonly authBasis: string;
  readonly resolution: KimiRegionResolution;
}

function authBasis(auth: KimiRegionAuthSnapshot): string {
  if (auth.status !== 'logged-in') return auth.status;
  return JSON.stringify([auth.status, auth.ref.key, auth.ref.oauthHost]);
}

export function createKimiRegionResolver(
  options: CreateKimiRegionResolverOptions,
): KimiRegionResolver {
  const env = options.env ?? process.env;
  const collectSignals = options.collectSignals ?? collectLocalRegionSignals;
  let cached: CachedResolution | undefined;

  function readAuth(): KimiRegionAuthSnapshot {
    try {
      return options.readAuth();
    } catch {
      return { status: 'unknown' };
    }
  }

  function resolve(auth: KimiRegionAuthSnapshot): KimiRegionResolution {
    const ref = auth.status === 'logged-in' ? auth.ref : undefined;
    const explicit = resolveKimiRegionDetailed({
      env,
      configuredOAuthHost: ref?.oauthHost,
      configuredOAuthKey: ref?.key,
      homeDir: options.homeDir,
      readMarker: options.readMarker,
    });
    if (explicit.source === 'env') return explicit;
    if (auth.status === 'unknown') return { region: 'mainland-cn', source: 'default' };
    if (auth.status === 'logged-in') {
      clearKimiRegionCache(options.homeDir);
      return explicit;
    }
    if (
      explicit.source === 'marker' ||
      options.readMarker === false ||
      options.allowLocalInference === false ||
      kimiCodeEnvBaseUrl(env) !== undefined
    ) {
      return explicit;
    }
    const persisted = readKimiRegionCache(options.homeDir);
    if (persisted !== undefined) {
      return { region: persisted.region, source: persisted.source };
    }
    try {
      const detection = detectKimiRegionFromLocalSignals(collectSignals());
      if (!detection.confident) return { region: detection.region, source: 'fallback' };
      writeKimiRegionCache(options.homeDir, detection.region);
      return { region: detection.region, source: 'local-signals' };
    } catch {
      return { region: 'mainland-cn', source: 'fallback' };
    }
  }

  function current(): KimiRegionResolution {
    if (cached === undefined) return refresh();
    return cached.resolution;
  }

  function refresh(): KimiRegionResolution {
    const auth = readAuth();
    const basis = authBasis(auth);
    if (cached?.authBasis === basis) return cached.resolution;
    cached = { authBasis: basis, resolution: resolve(auth) };
    return cached.resolution;
  }

  return { current, refresh };
}
