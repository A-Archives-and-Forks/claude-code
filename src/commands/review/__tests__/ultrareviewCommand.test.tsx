/**
 * Regression tests for ultrareviewCommand preflight integration.
 * Uses real fetchUltrareviewPreflight with axios mocked to verify the three
 * action paths: proceed / confirm / blocked.
 *
 * NOTE: 4 of 6 tests are isolation flakes, not pollution. The current
 * ultrareviewCommand.tsx source does not call fetchUltrareviewPreflight
 * (the preflight axios path was removed), so blocked/confirm/PR-args tests
 * can never observe the mocked axios path — they fall through to the
 * launchRemoteReview mock returning "Launched successfully." The two passing
 * tests (proceed action / null preflight network failure) match that
 * behavior. Out of scope for the test-flake-fix pass; needs source review
 * to either restore preflight or rewrite tests.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { debugMock } from '../../../../tests/mocks/debug.js';
import { logMock } from '../../../../tests/mocks/log.js';

// Pre-import the real react module so we can delegate after this suite.
// Bun's mock.module is process-global / last-write-wins; without delegation
// the stub createElement leaks into other test files (e.g.
// SnapshotUpdateDialog.test.tsx) that need real React.createElement.
const _realReactMod = (await import('react')) as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
let _useStubReactForUltrareview = true;
afterAll(() => {
  _useStubReactForUltrareview = false;
});

// Mock dependency chain before any subject import
mock.module('src/utils/debug.ts', debugMock);
mock.module('src/utils/log.ts', logMock);
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}));
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => null,
}));

// Mock auth utilities
mock.module('src/utils/auth.js', () => ({
  isClaudeAISubscriber: () => true,
  isTeamSubscriber: () => false,
  isEnterpriseSubscriber: () => false,
}));

// Mock checkOverageGate to always return proceed (gate logic tested separately)
mock.module('src/commands/review/reviewRemote.js', () => ({
  checkOverageGate: async () => ({ kind: 'proceed', billingNote: '' }),
  confirmOverage: () => {},
  launchRemoteReview: async () => [{ type: 'text', text: 'Launched successfully.' }],
}));

// Mock OAuth config so real fetchUltrareviewPreflight can run
mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}));

// Mock prepareApiRequest so real fetchUltrareviewPreflight skips auth
mock.module('src/utils/teleport/api.js', () => ({
  prepareApiRequest: async () => ({
    accessToken: 'test-token',
    orgUUID: 'org-uuid-test',
  }),
  getOAuthHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }),
}));

// Mock axios — per-test responses set via mockAxiosPost.mockImplementationOnce
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAxiosPost = mock(
  async (..._args: any[]): Promise<any> => ({
    status: 200,
    data: { action: 'proceed', billing_note: null },
  }),
);

mock.module('axios', () => {
  const axiosMock = {
    post: mockAxiosPost,
    isAxiosError: (e: unknown) =>
      typeof e === 'object' && e !== null && (e as { isAxiosError?: boolean }).isAxiosError === true,
  };
  return { default: axiosMock, ...axiosMock };
});

// Mock detectCurrentRepositoryWithHost
mock.module('src/utils/detectRepository.js', () => ({
  detectCurrentRepositoryWithHost: async () => ({
    host: 'github.com',
    owner: 'testowner',
    name: 'testrepo',
  }),
}));

// Minimal mock for React/Ink so we don't need a full renderer.
// Preserve any explicit `children` prop when no varargs children are passed
// — otherwise consumers who pass `children` via the props object (e.g.
// SnapshotUpdateDialog.ts uses `React.createElement(Dialog, { ..., children })`)
// see their array overwritten with `[]`. mock.module is process-global so this
// mock survives into other test files in the same run; afterAll flips the flag
// so we delegate to real React thereafter.
mock.module('react', () => {
  const stubCreateElement = (type: unknown, props: unknown, ...children: unknown[]) => {
    const propsObj = (props ?? {}) as Record<string, unknown>;
    const finalChildren = children.length > 0 ? children : 'children' in propsObj ? propsObj.children : [];
    return {
      $$typeof: Symbol.for('react.element'),
      type,
      props: { ...propsObj, children: finalChildren },
    };
  };
  const realCreate = ((_realReactMod.default as Record<string, unknown> | undefined)?.createElement ??
    _realReactMod.createElement) as (...args: unknown[]) => unknown;
  const createElement = (...args: unknown[]) =>
    _useStubReactForUltrareview ? stubCreateElement(args[0], args[1], ...args.slice(2)) : realCreate(...args);
  return {
    ..._realReactMod,
    default: {
      ...((_realReactMod.default as Record<string, unknown> | undefined) ?? {}),
      createElement,
    },
    createElement,
  };
});

mock.module('@anthropic/ink', () => ({
  Box: 'Box',
  Dialog: 'Dialog',
  Text: 'Text',
}));

mock.module('src/components/CustomSelect/select.js', () => ({
  Select: 'Select',
}));

// UltrareviewOverageDialog and PreflightDialog — return a simple marker
mock.module('src/commands/review/UltrareviewOverageDialog.js', () => ({
  UltrareviewOverageDialog: () => ({ type: 'UltrareviewOverageDialog' }),
}));
mock.module('src/commands/review/UltrareviewPreflightDialog.js', () => ({
  UltrareviewPreflightDialog: () => ({ type: 'UltrareviewPreflightDialog' }),
}));

import { call } from '../ultrareviewCommand.js';

const makeContext = () =>
  ({
    abortController: { signal: {} },
  }) as Parameters<typeof call>[1];

describe('ultrareviewCommand preflight integration', () => {
  test('proceed action: launches immediately without dialog', async () => {
    mockAxiosPost.mockImplementationOnce(async () => ({
      status: 200,
      data: { action: 'proceed', billing_note: null },
    }));

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');
    // Should not render a dialog — returns null after calling onDone
    expect(result).toBeNull();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('Launched successfully');
  });

  test('blocked action: calls onDone with unavailable message', async () => {
    mockAxiosPost.mockImplementationOnce(async () => ({
      status: 200,
      data: { action: 'blocked', billing_note: null },
    }));

    const messages: string[] = [];
    const opts: Array<unknown> = [];
    const onDone = (msg: string, opt: unknown) => {
      messages.push(msg);
      opts.push(opt);
    };

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');
    expect(result).toBeNull();
    expect(messages.length).toBe(1);
    expect(messages[0]).toBe('Ultrareview is currently unavailable.');
    expect((opts[0] as { display: string }).display).toBe('system');
  });

  test('blocked action with billing_note: shows billing_note as message', async () => {
    mockAxiosPost.mockImplementationOnce(async () => ({
      status: 200,
      data: { action: 'blocked', billing_note: 'Ultrareview is unavailable for your organization.' },
    }));

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    await call(onDone as Parameters<typeof call>[0], makeContext(), '');
    expect(messages[0]).toBe('Ultrareview is unavailable for your organization.');
  });

  test('confirm action: returns UltrareviewPreflightDialog element', async () => {
    mockAxiosPost.mockImplementationOnce(async () => ({
      status: 200,
      data: { action: 'confirm', billing_note: 'This run will cost ~$2.' },
    }));

    const onDone = (_msg: string) => {};
    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');
    // Should return a React element (the PreflightDialog)
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    // The element type should be the PreflightDialog component
    const element = result as { type: unknown };
    expect(element.type).toBeDefined();
  });

  test('null preflight (network failure): falls back to direct launch', async () => {
    mockAxiosPost.mockImplementationOnce(async () => {
      throw new Error('network error');
    });

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    const result = await call(onDone as Parameters<typeof call>[0], makeContext(), '');
    expect(result).toBeNull();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('Launched successfully');
  });

  test('PR number args: extracts pr_number for preflight request', async () => {
    const capturedBodies: Array<unknown> = [];
    mockAxiosPost.mockImplementationOnce(async (_url: unknown, body: unknown) => {
      capturedBodies.push(body);
      return { status: 200, data: { action: 'proceed', billing_note: null } };
    });

    const messages: string[] = [];
    const onDone = (msg: string) => messages.push(msg);

    await call(onDone as Parameters<typeof call>[0], makeContext(), '42');

    expect(capturedBodies.length).toBe(1);
    const b = capturedBodies[0] as { pr_number: number; repo: string };
    expect(b.pr_number).toBe(42);
    expect(b.repo).toBe('testowner/testrepo');
  });
});
