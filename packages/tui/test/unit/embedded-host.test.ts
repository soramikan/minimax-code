import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalRuntimeConfig } from '@mavis/local-runtime-v2/process-local';
import type { ProductBuildIdentity } from '@mavis/shared/product-build-identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMcodeBuildIdentity } from '../../src/auth/environment.js';
import { noopTuiObservability } from '../../src/observability/index.js';
import {
  createEmbeddedRuntimeHost,
  projectEmbeddedRuntimeConfig,
  type EmbeddedRuntimeHostOptions,
} from '../../src/runtime/embedded-host.js';
import { createTuiRuntime } from '../../src/runtime/lifecycle.js';
import type { TuiRuntimeLogging } from '../../src/runtime/logging.js';

const hoisted = vi.hoisted(() => ({
  realResolveMcodeBuildIdentity: undefined as unknown as typeof import('../../src/auth/environment.js').resolveMcodeBuildIdentity,
}));

vi.mock('../../src/auth/environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/environment.js')>();
  hoisted.realResolveMcodeBuildIdentity = actual.resolveMcodeBuildIdentity;
  return {
    ...actual,
    resolveMcodeBuildIdentity: vi.fn(actual.resolveMcodeBuildIdentity),
  };
});

const mockResolveMcodeBuildIdentity = vi.mocked(resolveMcodeBuildIdentity);

const roots: string[] = [];

beforeEach(() => {
  mockResolveMcodeBuildIdentity.mockImplementation(hoisted.realResolveMcodeBuildIdentity);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function buildIdentity(isInternalBuild: boolean): ProductBuildIdentity {
  return {
    buildEnv: 'test',
    variant: isInternalBuild ? 'internal' : 'standard',
    isDev: false,
    isTest: true,
    isStaging: false,
    isProd: false,
    isInternalBuild,
    isInsideBuild: false,
  };
}

function stubBuildIdentity(isInternalBuild: boolean): void {
  mockResolveMcodeBuildIdentity.mockReturnValue(buildIdentity(isInternalBuild));
}

function runtimeConfig(beta: LocalRuntimeConfig['beta'] = {}): LocalRuntimeConfig {
  return {
    provider: {},
    dataDir: '/tmp/mcode-embedded-host-test',
    beta,
  };
}

describe('projectEmbeddedRuntimeConfig Codex OAuth gate', () => {
  it.each([
    // Public/standard builds keep the config-resolved value, which already
    // honors `beta.codexOAuth` opt-in through `resolveBetaFeature`.
    ['standard build, not configured', false, undefined, undefined, false],
    ['standard build, explicit opt-in', false, true, true, true],
    ['standard build, explicit opt-out', false, false, false, false],
    // The TUI internal variant is invisible to `resolveBetaFeature`, so the
    // embedded host applies the internal default itself; explicit `false`
    // remains the feature system's kill switch.
    ['internal build, not configured', true, undefined, undefined, true],
    ['internal build, resolved default', true, false, undefined, true],
    ['internal build, explicit opt-in', true, false, true, true],
    ['internal build, explicit opt-out', true, false, false, false],
    ['internal build, config-layer enabled', true, true, undefined, true],
  ])(
    '%s resolves beta.codexOAuth as %s',
    (_label, isInternalBuild, resolved, configured, expected) => {
      const projected = projectEmbeddedRuntimeConfig(
        runtimeConfig({ codexOAuth: resolved }),
        buildIdentity(isInternalBuild),
        false,
        configured,
      );
      expect(projected.beta?.codexOAuth).toBe(expected);
    },
  );

  it('keeps the remaining product ceilings unchanged', () => {
    const projected = projectEmbeddedRuntimeConfig(
      {
        ...runtimeConfig({ codexOAuth: true, mcodeTools: true }),
        review: { mode: 'inline', modeSource: 'configured' },
        memory: { enabled: true, proactive: true },
      } as LocalRuntimeConfig,
      buildIdentity(false),
      false,
      true,
    );
    expect(projected.beta?.codexOAuth).toBe(true);
    expect(projected.beta?.mcodeTools).toBe(false);
    expect(projected.memory?.enabled).toBe(false);
    expect(projected.memory?.proactive).toBe(true);
  });
});

function fakeEmbeddedHost() {
  return {
    ready: Promise.resolve(),
    cliService: {},
    apiHost: {
      ensureBuiltinAgents: async () => undefined,
      close: async () => undefined,
    },
  } as never;
}

async function projectThroughHost(
  options: EmbeddedRuntimeHostOptions,
): Promise<LocalRuntimeConfig> {
  let projected: LocalRuntimeConfig | undefined;
  await createEmbeddedRuntimeHost(options, async (hostOptions) => {
    projected = hostOptions.configGetter?.();
    return fakeEmbeddedHost();
  });
  if (!projected) throw new Error('Expected the runtime factory to receive host options.');
  return projected;
}

describe('createEmbeddedRuntimeHost Codex OAuth wiring', () => {
  it('keeps the config-resolved opt-in for standard builds', async () => {
    stubBuildIdentity(false);
    const projected = await projectThroughHost({
      dataDir: '/tmp/mcode-embedded-host-test',
      configGetter: () => runtimeConfig({ codexOAuth: true }),
      betaFeatureConfig: { codexOAuth: true },
    });
    expect(projected.beta?.codexOAuth).toBe(true);
  });

  it('applies the internal-build default when beta.codexOAuth is unset', async () => {
    stubBuildIdentity(true);
    const projected = await projectThroughHost({
      dataDir: '/tmp/mcode-embedded-host-test',
      configGetter: () => runtimeConfig({ codexOAuth: false }),
      betaFeatureConfig: { codexOAuth: undefined },
    });
    expect(projected.beta?.codexOAuth).toBe(true);
  });

  it('lets an explicit beta.codexOAuth: false disable internal builds', async () => {
    stubBuildIdentity(true);
    const projected = await projectThroughHost({
      dataDir: '/tmp/mcode-embedded-host-test',
      configGetter: () => runtimeConfig({ codexOAuth: false }),
      betaFeatureConfig: { codexOAuth: false },
    });
    expect(projected.beta?.codexOAuth).toBe(false);
  });
});

describe('createTuiRuntime Codex OAuth feature gate', () => {
  async function projectedCodexOAuth(options: {
    configYaml?: string;
    resolvedCodexOAuth?: boolean;
    internalBuild: boolean;
  }): Promise<boolean | undefined> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-embedded-host-'));
    roots.push(dataDir);
    if (options.configYaml !== undefined) {
      await writeFile(join(dataDir, 'config.yaml'), options.configYaml);
    }
    stubBuildIdentity(options.internalBuild);
    let projected: LocalRuntimeConfig | undefined;
    const logging: TuiRuntimeLogging = {
      logDirectory: join(dataDir, 'logs'),
      runDuringStartup: async <T>(operation: () => Promise<T>) => operation(),
      flush: async () => undefined,
      shutdown: async () => undefined,
    };
    await createTuiRuntime(
      {
        dataDir,
        workspaceDir: dataDir,
        version: '0.0.0-test',
        surface: 'headless',
        observability: noopTuiObservability,
      },
      {
        getConfig: () =>
          runtimeConfig(
            options.resolvedCodexOAuth === undefined
              ? {}
              : { codexOAuth: options.resolvedCodexOAuth },
          ),
        readAuthContext: () => undefined,
        importSharedAuthContext: () => undefined,
        createLogging: () => logging,
        createBrowserProvider: () => undefined,
        factory: async (hostOptions) => {
          projected = hostOptions.configGetter?.();
          return fakeEmbeddedHost();
        },
      },
    );
    return projected?.beta?.codexOAuth;
  }

  it('enables Codex OAuth on a public build when config.yaml opts in', async () => {
    await expect(
      projectedCodexOAuth({
        configYaml: 'beta:\n  codexOAuth: true\n',
        resolvedCodexOAuth: true,
        internalBuild: false,
      }),
    ).resolves.toBe(true);
  });

  it.each([
    ['beta:\n  codexOAuth: false\n', false],
    ['logLevel: info\n', undefined],
  ])(
    'keeps Codex OAuth disabled on a public build with %s',
    async (configYaml, resolvedCodexOAuth) => {
      await expect(
        projectedCodexOAuth({
          configYaml,
          resolvedCodexOAuth,
          internalBuild: false,
        }),
      ).resolves.toBe(false);
    },
  );

  it('enables Codex OAuth by default on an internal build', async () => {
    await expect(
      projectedCodexOAuth({
        configYaml: 'logLevel: info\n',
        internalBuild: true,
      }),
    ).resolves.toBe(true);
  });

  it('reads beta.codexOAuth: false from config.yaml as a kill switch on internal builds', async () => {
    await expect(
      projectedCodexOAuth({
        configYaml: 'beta:\n  codexOAuth: false\n',
        resolvedCodexOAuth: false,
        internalBuild: true,
      }),
    ).resolves.toBe(false);
  });
});
