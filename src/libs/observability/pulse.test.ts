import { type LogEvent, Pulse } from '@synonymdev/pubky-pulse-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { resetRuntimeConfigForTests, RUNTIME_CONFIG_WINDOW_KEY } from '@/libs/runtime-config/runtime-config';
import { NETWORK_RUNTIME_DEFAULTS } from '@/libs/runtime-config/runtime-config.schema';
import { beforeSendPulse, capturePulseError, initPulse, pulseScreenName } from './pulse';

const sdk = vi.hoisted(() => {
  vi.resetModules();
  return { sessionId: undefined as string | undefined, configure: vi.fn(), error: vi.fn() };
});
vi.mock('@synonymdev/pubky-pulse-web', () => ({ Pulse: sdk }));
vi.mock('@/libs/env/env', () => ({ Env: { NODE_ENV: 'production', NEXT_PUBLIC_APP_VERSION: 'test' } }));

const PUBLIC_KEY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const LOCAL_ENDPOINT = 'http://127.0.0.1:4007';

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
    sdk_version: '0.4.0',
    is_dev: true,
    timestamp: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRuntimeConfigForTests();
  sdk.sessionId = undefined;
  sdk.configure.mockImplementation(() => {
    sdk.sessionId = 'local-test-session';
  });
  sdk.error.mockImplementation(() => {});
  inject();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window[RUNTIME_CONFIG_WINDOW_KEY];
  resetRuntimeConfigForTests();
});

describe('optional Pulse initialization', () => {
  it.each([undefined, '', '   '])('does not initialize or capture when the client key is %j', (pulseClientKey) => {
    inject({ pulseClientKey });
    initPulse();
    const error = Err.server(ServerErrorCode.INTERNAL_ERROR, 'App still works', {
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
    });
    capturePulseError(error);
    expect(error).toBeInstanceOf(AppError);
    expect(Pulse.configure).not.toHaveBeenCalled();
    expect(Pulse.error).not.toHaveBeenCalled();
  });
  it('does not fall back to a hosted endpoint', () => {
    inject({ pulseEndpoint: undefined });
    initPulse();
    expect(Pulse.configure).not.toHaveBeenCalled();
  });
  it('configures once with automatic tracking and privacy hooks, independently of Sentry', () => {
    initPulse();
    initPulse();
    expect(Pulse.configure).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'pulse_client_local_test_only',
      endpoint: LOCAL_ENDPOINT,
      bundleId: 'app.pubky.web',
      appVersion: 'test',
      isDev: true,
      consoleLogging: false,
      networkTracking: true,
      screenNameForPath: pulseScreenName,
      beforeSend: beforeSendPulse,
    });
  });
  it('marks production deploys as non-development', () => {
    inject({ deployEnv: 'production' });
    initPulse();
    expect(Pulse.configure).toHaveBeenCalledWith(expect.objectContaining({ isDev: false }));
  });
  it('cannot break the app when configuration or the SDK fails', () => {
    inject({ pulseEndpoint: 'invalid' });
    expect(initPulse).not.toThrow();
    expect(Pulse.configure).not.toHaveBeenCalled();
    resetRuntimeConfigForTests();
    inject();
    sdk.configure.mockImplementation(() => {
      throw new Error('SDK unavailable');
    });
    expect(initPulse).not.toThrow();
  });
  it('does not initialize or capture on the server', () => {
    vi.stubGlobal('window', undefined);
    initPulse();
    capturePulseError(new Error('server only'));
    expect(Pulse.configure).not.toHaveBeenCalled();
    expect(Pulse.error).not.toHaveBeenCalled();
  });
});

describe('route privacy', () => {
  it.each([
    ['/', '/'],
    ['/home/', '/home'],
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
    (message) => {
      expect(beforeSendPulse(event({ message }))).toBeNull();
    },
  );
  it('drops expected error types and automatically recaptured AppErrors', () => {
    expect(beforeSendPulse(event({ custom_attributes: { _error_type: 'AbortError' } }))).toBeNull();
    expect(beforeSendPulse(event({ custom_attributes: { _error_type: 'AppError', _unhandled: 'error' } }))).toBeNull();
    expect(beforeSendPulse(event({ custom_attributes: { _error_type: 'AppError' } }))).not.toBeNull();
  });
  it('scrubs messages, stacks and attributes but preserves anonymous SDK attribution', () => {
    const input = event({
      message: `Failed for ${PUBLIC_KEY}`,
      custom_attributes: { _error_stack: 'Error: person@example.com', email: 'person@example.com', service: 'Nexus' },
    });
    const result = beforeSendPulse(input)!;
    expect(JSON.stringify(result)).not.toContain(PUBLIC_KEY);
    expect(JSON.stringify(result)).not.toContain('person@example.com');
    expect(result.user_id).toBe('anonymous-browser-id');
    expect(result.session_id).toBe(input.session_id);
    expect(result.custom_attributes?.service).toBe('Nexus');
  });
  it('keeps network status and duration without URL credentials, paths, or query values', () => {
    const result = beforeSendPulse(
      event({
        message: 'sdk:network_request',
        level: 'debug',
        custom_attributes: {
          _http_url: 'https://user:password@example.com/invite/private-code?token=secret#fragment',
          _http_status: '201',
          _duration_ms: '12',
        },
      }),
    );
    expect(result?.custom_attributes).toEqual({
      _http_url: 'https://example.com',
      _http_status: '201',
      _duration_ms: '12',
    });
  });
  it('captures each factory error once with operational metadata but no context payload', () => {
    initPulse();
    const error = Err.server(ServerErrorCode.INTERNAL_ERROR, 'Read failed', {
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
      context: { email: 'private@example.com' },
    });
    expect(Pulse.error).toHaveBeenCalledExactlyOnceWith(error, undefined, {
      category: ErrorCategory.Server,
      code: ServerErrorCode.INTERNAL_ERROR,
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
      trace_id: undefined,
    });
  });
  it('retains Sentry’s AppError drop policy', () => {
    initPulse();
    Err.client(ClientErrorCode.NOT_FOUND, 'Not found', {
      service: ErrorService.Nexus,
      operation: 'fetchNexus',
      context: { statusCode: 404, endpoint: 'https://example.com/v0/post/user/post/tags' },
    });
    expect(Pulse.error).not.toHaveBeenCalled();
  });
  it('supports non-AppError render failures and isolates capture failures', () => {
    initPulse();
    const error = new Error('Render failed');
    capturePulseError(error);
    expect(Pulse.error).toHaveBeenCalledWith(error, undefined, undefined);
    sdk.error.mockImplementation(() => {
      throw new Error('SDK failed');
    });
    expect(() => capturePulseError(error)).not.toThrow();
  });
});
