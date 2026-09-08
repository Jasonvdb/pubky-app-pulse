import { type LogEvent, Pulse } from '@synonymdev/pubky-pulse-web';
import { Env } from '@/libs/env/env';
import { AppError } from '@/libs/error/error';
import { IGNORED_BROWSER_ERRORS } from '@/libs/observability/sentry.constants';
import { sanitizeForSentry, shouldDropAppErrorFromSentry } from '@/libs/observability/sentry.utils';
import { getDeployEnv, getPulseClientKey, getPulseEndpoint } from '@/libs/runtime-config/runtime-config';

/** Only allow known route shapes: never send user IDs, invite codes, or unknown paths. */
export function pulseScreenName(pathname: string): string {
  const path = pathname.split(/[?#]/)[0].replace(/\/$/, '') || '/';
  const staticRoutes = [
    /^\/$/,
    /^\/(?:home|hot|search|collections(?:\/bookmarks)?|sign-in|logout|share|offline|copyright|who-to-follow|sentry-test)$/,
    /^\/profile(?:\/(?:collections|friends|following|profile|tags|tagged|replies|followers|posts|notifications))?$/,
    /^\/settings(?:\/(?:account|edit|notifications|privacy-safety|muted-users|help))?$/,
    /^\/onboarding\/(?:backup|install|profile|pubky|scan|human|tags)$/,
  ];
  if (staticRoutes.some((route) => route.test(path))) return path;
  if (/^\/(?:post|collections)\/[^/]+\/[^/]+$/.test(path)) {
    return `/${path.split('/')[1]}/[userId]/[postId]`;
  }
  if (/^\/invite\/[^/]+$/.test(path)) return '/invite/[inviteCode]';
  if (/^\/feed\/[^/]+$/.test(path)) return '/feed/[id]';
  if (/^\/profile\/[^/]+(?:\/(?:collections|friends|following|profile|tagged|replies|followers))?$/.test(path)) {
    const tab = path.split('/')[3];
    return `/profile/[pubky]${tab ? `/${tab}` : ''}`;
  }
  return '/unknown';
}

export function beforeSendPulse(event: LogEvent): LogEvent | null {
  const attributes = event.custom_attributes;
  // Err.* already captured these, including errors deliberately excluded by app policy.
  if (attributes?._unhandled && attributes._error_type === 'AppError') return null;
  const error = `${attributes?._error_type ?? ''}: ${event.message}`;
  if (
    event.level === 'error' &&
    IGNORED_BROWSER_ERRORS.some((rule) => (typeof rule === 'string' ? error.includes(rule) : rule.test(error)))
  )
    return null;
  // Network timing/status stays useful without exposing endpoint paths, queries, or credentials.
  if (attributes?._http_url) attributes._http_url = new URL(attributes._http_url).origin;
  event.message = sanitizeForSentry(event.message) as string;
  event.custom_attributes = sanitizeForSentry(attributes) as LogEvent['custom_attributes'];
  return event;
}

export function initPulse(): void {
  try {
    if (typeof window === 'undefined' || Env.NODE_ENV === 'test' || Env.VITEST || Pulse.sessionId) return;
    const apiKey = getPulseClientKey();
    if (!apiKey) return;
    Pulse.configure({
      apiKey,
      endpoint: getPulseEndpoint(),
      appVersion: Env.NEXT_PUBLIC_APP_VERSION,
      isDev: Env.NODE_ENV !== 'production' || getDeployEnv() !== 'production',
      consoleLogging: false,
      networkTracking: true,
      screenNameForPath: pulseScreenName,
      beforeSend: beforeSendPulse,
    });
  } catch {
    // Optional telemetry must never prevent the app from starting.
  }
}

/** Browser-only and inert before initialization, including every build without a client key. */
export function capturePulseError(error: Error): void {
  try {
    if (typeof window === 'undefined' || !Pulse.sessionId) return;
    if (error instanceof AppError && shouldDropAppErrorFromSentry(error)) return;
    Pulse.error(
      error,
      undefined,
      error instanceof AppError
        ? {
            category: error.category,
            code: error.code,
            service: error.service,
            operation: error.operation,
            trace_id: error.traceId,
          }
        : undefined,
    );
  } catch {
    // The capture funnel must not mask the original application error.
  }
}
