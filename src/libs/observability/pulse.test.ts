import { type LogEvent, Pulse } from '@synonymdev/pubky-pulse-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Env } from '@/libs/env/env';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { resetRuntimeConfigForTests, RUNTIME_CONFIG_WINDOW_KEY } from '@/libs/runtime-config/runtime-config';
import { NETWORK_RUNTIME_DEFAULTS } from '@/libs/runtime-config/runtime-config.schema';
import { beforeSendPulse, initPulse, pulseScreenName } from './pulse';

vi.mock('@/libs/env/env', () => ({ Env: { NODE_ENV: 'production', NEXT_PUBLIC_APP_VERSION: 'test' } }));

const PUBLIC_KEY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const LOCAL_ENDPOINT = 'http://127.0.0.1:4007';
const fetchMock = vi.fn();

async function capturedErrors(): Promise<LogEvent[]> {
  await Pulse.flush();
  return fetchMock.mock.calls.flatMap(([, init]) =>
    (JSON.parse(init.body).events ?? []).filter((event: LogEvent) => event.level === 'error'),
  );
}

function inject(overrides: Record<string, unknown> = {}) {
  window[RUNTIME_CONFIG_WINDOW_KEY] = {
    ...NETWORK_RUNTIME_DEFAULTS,
    pulseClientKey: 'pulse_client_local_test_only',
    pulseEndpoint: LOCAL_ENDPOINT,
    ...overrides,
  };
}

function event(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    client_event_id: '00000000-0000-4000-8000-000000000001',
    session_id: '00000000-0000-4000-8000-000000000002',
    user_id: 'anonymous-browser-id',
    level: 'error',
    message: 'Unexpected failure',
    environment: 'web',
    sdk_name: 'pubky-pulse-web',
    sdk_version: '0.6.0',
    is_dev: true,
    timestamp: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  Env.NODE_ENV = 'production';
  vi.useFakeTimers();
  vi.stubGlobal('CompressionStream', undefined);
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  resetRuntimeConfigForTests();
  inject();
});

afterEach(async () => {
  await Pulse.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete window[RUNTIME_CONFIG_WINDOW_KEY];
  resetRuntimeConfigForTests();
});

describe('optional Pulse initialization', () => {
  it.each([undefined, '', '   '])(
    'does not initialize or capture when the client key is %j',
    async (pulseClientKey) => {
      inject({ pulseClientKey });
      initPulse();
      const error = Err.server(ServerErrorCode.INTERNAL_ERROR, 'App still works', {
        service: ErrorService.Nexus,
        operation: 'fetchNexus',
      });
      Pulse.captureException(error);
      expect(error).toBeInstanceOf(AppError);
      expect(Pulse.sessionId).toBeUndefined();
      expect(await capturedErrors()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);
    },
  );
  it.each([undefined, '', '   '])('uses the SDK default endpoint when the override is %j', (pulseEndpoint) => {
    inject({ pulseEndpoint });
    const init = vi.spyOn(Pulse, 'init');
    initPulse();
    expect(Pulse.sessionId).toBeDefined();
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pulse_client_local_test_only', endpoint: undefined }),
    );
    expect(init.mock.calls[0][0]).not.toHaveProperty('bundleId');
  });
  it('configures once with automatic tracking and privacy hooks, independently of Sentry', () => {
    const init = vi.spyOn(Pulse, 'init');
    initPulse();
    const sessionId = Pulse.sessionId;
    initPulse();
    expect(Pulse.sessionId).toBe(sessionId);
    expect(init).toHaveBeenCalledWith({
      apiKey: 'pulse_client_local_test_only',
      endpoint: LOCAL_ENDPOINT,
      enabled: true,
      appVersion: 'test',
      isDev: true,
      consoleLogging: false,
      ignoreErrors: expect.any(Array),
      networkTracking: { urlMode: 'origin' },
      screenNameForPath: pulseScreenName,
      beforeSend: beforeSendPulse,
    });
  });
  it('marks production deploys as non-development', () => {
    const init = vi.spyOn(Pulse, 'init');
    inject({ deployEnv: 'production' });
    initPulse();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ isDev: false }));
  });
  it('cannot break the app when runtime-config getters fail before SDK init', () => {
    const init = vi.spyOn(Pulse, 'init');
    inject({ pulseEndpoint: 'invalid' });
    expect(initPulse).not.toThrow();
    expect(init).not.toHaveBeenCalled();
  });
  it('disables collectors in app test environments', () => {
    Env.NODE_ENV = 'test';
    initPulse();
    expect(Pulse.sessionId).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });
  it('does not initialize or capture on the server', () => {
    vi.stubGlobal('window', undefined);
    initPulse();
    Pulse.captureException(new Error('server only'));
    expect(Pulse.sessionId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('route privacy', () => {
  it.each([
    ['/', '/'],
    ['/home/', '/home'],
    ['/feed', '/unknown'],
    ['/offline', '/offline'],
    ['/profile/tags', '/profile/tags'],
    ['/search?q=private#secret', '/search'],
    ['/settings/privacy-safety', '/settings/privacy-safety'],
    ['/onboarding/backup', '/onboarding/backup'],
    ['/profile/followers', '/profile/followers'],
    ['/profile/posts', '/profile/posts'],
    ['/profile/notifications', '/profile/notifications'],
    [`/profile/${PUBLIC_KEY}`, '/profile/[pubky]'],
    [`/profile/${PUBLIC_KEY}/followers`, '/profile/[pubky]/followers'],
    [`/post/${PUBLIC_KEY}/private-post`, '/post/[userId]/[postId]'],
    [`/collections/${PUBLIC_KEY}/private-post`, '/collections/[userId]/[postId]'],
    ['/collections/bookmarks', '/collections/bookmarks'],
    ['/feed/private-feed', '/feed/[id]'],
    ['/invite/private-code', '/invite/[inviteCode]'],
    ['/unknown/private-path', '/unknown'],
    ['/profile/user/private-tab', '/unknown'],
    ['/settings/private-setting', '/unknown'],
  ])('maps %s to %s', (path, expected) => {
    expect(pulseScreenName(path)).toBe(expected);
  });
});

describe('shared capture and privacy policy', () => {
  it.each(['ResizeObserver loop limit exceeded', 'Loading chunk 123 failed', 'AbortError', 'Failed to fetch'])(
    'drops the same expected error as Sentry: %s',
    async (message) => {
      initPulse();
      Pulse.captureException(new Error(message));
      expect(await capturedErrors()).toEqual([]);
    },
  );
  it('scrubs messages, stacks and attributes but preserves anonymous SDK attribution', () => {
    const input = event({
      message: `Failed for ${PUBLIC_KEY}`,
      custom_attributes: { _error_stack: 'Error: person@example.com', email: 'person@example.com', service: 'Nexus' },
    });
    const result = beforeSendPulse(input, {})!;
    expect(JSON.stringify(result)).not.toContain(PUBLIC_KEY);
    expect(JSON.stringify(result)).not.toContain('person@example.com');
    expect(result.user_id).toBe('anonymous-browser-id');
    expect(result.session_id).toBe(input.session_id);
    expect(result.custom_attributes?.service).toBe('Nexus');
  });
  it('captures each factory error once with operational metadata but no context payload', async () => {
    initPulse();
    const error = Err.server(ServerErrorCode.INTERNAL_ERROR, 'Read failed', {
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
      context: { email: 'private@example.com' },
    });
    Pulse.captureException(error);
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    const events = await capturedErrors();
    expect(events).toHaveLength(1);
    expect(events[0].custom_attributes).toMatchObject({
      category: ErrorCategory.Server,
      code: ServerErrorCode.INTERNAL_ERROR,
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
    });
    expect(events[0].custom_attributes).not.toHaveProperty('trace_id');
    expect(JSON.stringify(events)).not.toContain('private@example.com');
  });
  it('retains Sentry’s AppError drop policy on later automatic recapture', async () => {
    initPulse();
    const error = Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
      context: { statusCode: 404, endpoint: 'https://example.com/v0/post/user/post/tags' },
    });
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    expect(await capturedErrors()).toEqual([]);
  });
  it('supports non-AppError render failures without arbitrary exception fields', async () => {
    initPulse();
    const error = new Error('Render failed');
    Object.assign(error, { context: { password: 'private-password' } });
    Pulse.captureException(error);
    const events = await capturedErrors();
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('Render failed');
    expect(JSON.stringify(events)).not.toContain('private-password');
  });
});
