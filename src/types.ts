export interface InitOptions {
  /** The organisation's public key: `live_pk_...` for production or `test_pk_...` for sandbox. */
  publishableKey: string;

  /** Override the API base URL (for example for a staging server). */
  baseUrl?: string;

  /**
   * Include the device location. Off by default: the merchant turns it on only after the user has
   * consented, and the app must already hold the location permission. The SDK never asks for it.
   */
  location?: boolean;

  /** How long to wait for the session request before failing open. Defaults to 5000. */
  timeoutMs?: number;

  /** Log what the SDK does to the console. */
  debug?: boolean;
}

export interface DeviceSession {
  /**
   * Send this to your backend with the transaction, and pass it as `device_session_id` when you
   * screen. `null` when a session could not be created (the SDK fails open: screen without it).
   */
  deviceSessionId: string | null;

  /** The app-scoped device ID, when it could be read. */
  deviceId: string | null;

  /** Whether we had seen this device before. Only set when a session was created. */
  isKnownDevice?: boolean;

  /** When the session stops being usable, as an ISO date. Only set when a session was created. */
  expiresAt?: string;

  /** Why there is no session, when `deviceSessionId` is `null`. */
  error?: SessionError;
}

export type SessionError =
  | 'not_initialised'
  | 'timeout'
  | 'network_error'
  | 'unauthorised'
  | 'rate_limited'
  | 'rejected'
  | 'server_error'
  | 'native_error';

export interface GetDeviceSessionOptions {
  /** Ignore a session still being valid and create a new one. */
  forceRefresh?: boolean;
}

/** The signals the native side collects, grouped the way the API expects. */
export interface SignalBundle {
  device?: Record<string, unknown>;
  integrity?: Record<string, unknown>;
  network?: Record<string, unknown>;
  location?: Record<string, unknown>;
  scam_signals?: Record<string, unknown>;
}

export interface AppInfo {
  appId: string;
  appVersion: string;
  appBuild: string;
}
