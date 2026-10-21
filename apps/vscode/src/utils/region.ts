import * as vscode from "vscode";

import {
  createKimiRegionResolver,
  KIMI_CODE_PROVIDER_NAME,
  type KimiRegionAuthSnapshot,
  type KimiRegionResolution,
  type KimiRegionResolver,
} from "@moonshot-ai/kimi-code-oauth";
import { loadRuntimeConfigSafe, resolveConfigPath } from "@moonshot-ai/kimi-code-sdk";

export interface ExtensionRegionOptions {
  readonly homeDir: string;
  readonly refresh?: boolean;
}

export function readPersistedKimiOAuthRef(
  homeDir: string,
): { readonly key: string; readonly oauthHost?: string } | undefined {
  return loadRuntimeConfigSafe(resolveConfigPath({ homeDir })).config.providers?.[
    KIMI_CODE_PROVIDER_NAME
  ]?.oauth;
}

function readAuth(homeDir: string): KimiRegionAuthSnapshot {
  try {
    const result = loadRuntimeConfigSafe(resolveConfigPath({ homeDir }));
    if (result.fileError !== undefined) return { status: "unknown" };
    const ref = result.config.providers?.[KIMI_CODE_PROVIDER_NAME]?.oauth;
    return ref === undefined ? { status: "logged-out" } : { status: "logged-in", ref };
  } catch {
    return { status: "unknown" };
  }
}

const resolvers = new Map<string, KimiRegionResolver>();

export function resolveExtensionRegion(options: ExtensionRegionOptions): KimiRegionResolution {
  let resolver = resolvers.get(options.homeDir);
  if (resolver === undefined) {
    resolver = createKimiRegionResolver({
      homeDir: options.homeDir,
      readAuth: () => readAuth(options.homeDir),
      readMarker: process.env["KIMI_CODE_REGION_MARKER"] !== "off",
      allowLocalInference: vscode.env.remoteName === undefined,
    });
    resolvers.set(options.homeDir, resolver);
  }
  return options.refresh === true ? resolver.refresh() : resolver.current();
}

export function resetExtensionRegionCache(): void {
  resolvers.clear();
}
