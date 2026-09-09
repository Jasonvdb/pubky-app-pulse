import { createScreenNameMapper, type LogEvent, Pulse, type PulseEventHint } from '@synonymdev/pubky-pulse-web';
import {
  APP_ROUTES,
  AUTH_ROUTES,
  COLLECTION_ROUTES,
  COPYRIGHT_ROUTES,
  DEV_ROUTES,
  getProfileRoute,
  ONBOARDING_ROUTES,
  PROFILE_ROUTES,
  ROOT_ROUTES,
  SETTINGS_ROUTES,
} from '@/app/routes';
import { Env } from '@/libs/env/env';
import { AppError } from '@/libs/error/error';
import { IGNORED_BROWSER_ERRORS } from '@/libs/observability/sentry.constants';
import { sanitizeForSentry, shouldDropAppErrorFromSentry } from '@/libs/observability/sentry.utils';
import { getDeployEnv, getPulseClientKey, getPulseEndpoint } from '@/libs/runtime-config/runtime-config';

/** Route definitions are a telemetry allowlist: never add user identifiers or arbitrary paths. */
export const pulseScreenName = createScreenNameMapper(
  [
    ROOT_ROUTES,
    '/offline',
    '/profile/tags',
    ...Object.values(APP_ROUTES).filter((route) => route !== APP_ROUTES.FEED),
    ...[
      AUTH_ROUTES,
      COLLECTION_ROUTES,
      COPYRIGHT_ROUTES,
      DEV_ROUTES,
      ONBOARDING_ROUTES,
      PROFILE_ROUTES,
      SETTINGS_ROUTES,
    ].flatMap(Object.values),
    ...Object.values(PROFILE_ROUTES).map((route) => getProfileRoute(route, '[pubky]')),
    '/post/[userId]/[postId]',
    '/collections/[userId]/[postId]',
    '/invite/[inviteCode]',
    '/feed/[id]',
  ],
  { fallback: '/unknown' },
);

export function beforeSendPulse(event: LogEvent, { originalException: error }: PulseEventHint): LogEvent | null {
  if (error instanceof AppError) {
    if (shouldDropAppErrorFromSentry(error)) return null;
    // Keep only reviewed operational metadata; never spread the error or its context.
    for (const [key, value] of Object.entries({
      category: error.category,
      code: error.code,
      service: error.service,
      operation: error.operation,
      trace_id: error.traceId,
    })) {
      if (value !== undefined) (event.custom_attributes ??= {})[key] = value;
    }
  }
  event.message = sanitizeForSentry(event.message) as string;
  event.custom_attributes = sanitizeForSentry(event.custom_attributes) as LogEvent['custom_attributes'];
  return event;
}

export function initPulse(): void {
  try {
    Pulse.init({
      apiKey: getPulseClientKey(),
      endpoint: getPulseEndpoint(),
      enabled: Env.NODE_ENV !== 'test' && !Env.VITEST,
      appVersion: Env.NEXT_PUBLIC_APP_VERSION,
      isDev: Env.NODE_ENV !== 'production' || getDeployEnv() !== 'production',
      consoleLogging: false,
      ignoreErrors: IGNORED_BROWSER_ERRORS,
      networkTracking: { urlMode: 'origin' },
      screenNameForPath: pulseScreenName,
      beforeSend: beforeSendPulse,
    });
  } catch {
    // Runtime-config getters run before the SDK's safe init and must not break startup.
  }
}
