import { Platform } from 'react-native';
import { nativeDevice } from './native';
import type {
  AppInfo,
  DeviceSession,
  GetDeviceSessionOptions,
  InitOptions,
  SessionError,
  SignalBundle,
} from './types';
import { SDK_VERSION } from './version';

const DEFAULT_BASE_URL = 'https://backend.prembly.com';
const SESSIONS_PATH = '/api/v1/fraud/transaction-monitoring/sdk/v1/sessions';
const DEFAULT_TIMEOUT_MS = 5000;
// Treat a session as expired a little early, so it is still valid when the backend screens.
const REFRESH_MARGIN_MS = 30_000;

interface Config {
  publishableKey: string;
  baseUrl: string;
  location: boolean;
  timeoutMs: number;
  debug: boolean;
}

interface CachedSession {
  customerId: string | null;
  includeLocation: boolean;
  session: DeviceSession;
  expiresAtMs: number;
}

class PremblyTMClient {
  private config: Config | null = null;
  private customerId: string | null = null;
  private cached: CachedSession | null = null;
  private inFlight: Promise<DeviceSession> | null = null;
  private appInfo: AppInfo | null = null;

  /**
   * Set up the SDK once, early (for example when the app starts). A bad key throws, because that is
   * a mistake to fix while developing. Nothing after this throws: a session that cannot be created
   * comes back as `deviceSessionId: null`, so a payment is never blocked by the SDK.
   */
  init(options: InitOptions): void {
    const key = (options?.publishableKey ?? '').trim();
    if (!key.startsWith('live_pk_') && !key.startsWith('test_pk_')) {
      throw new Error(
        'PremblyTM.init: publishableKey must be your public key (live_pk_... or test_pk_...). ' +
          'Never put a secret key (live_sk_ / test_sk_) in an app.'
      );
    }
    this.config = {
      publishableKey: key,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      location: options.location ?? false,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      debug: options.debug ?? false,
    };
    this.cached = null;
    this.inFlight = null;
  }

  /** Tell the SDK which customer is using the app, or `null` when they sign out. */
  identify(customerId: string | null): void {
    const next = customerId?.trim() ? customerId.trim() : null;
    if (next !== this.customerId) {
      this.customerId = next;
      this.cached = null;
    }
  }

  /** Turn location collection on or off, for example when the user changes their consent. */
  setLocationEnabled(enabled: boolean): void {
    if (this.config && this.config.location !== enabled) {
      this.config.location = enabled;
      this.cached = null;
    }
  }

  /** Forget the customer and any cached session (for example on sign-out). */
  reset(): void {
    this.customerId = null;
    this.cached = null;
    this.inFlight = null;
  }

  /** The app-scoped device ID, or `null` if it could not be read. */
  async getDeviceId(): Promise<string | null> {
    try {
      return await nativeDevice().getDeviceId();
    } catch (error) {
      this.log('getDeviceId failed', error);
      return null;
    }
  }

  /**
   * The signals the SDK would send, without sending anything. For testing and for showing users
   * what is collected. Honours the location setting from `init` / `setLocationEnabled`.
   */
  async getSignalsPreview(): Promise<SignalBundle | null> {
    try {
      const includeLocation = this.config?.location ?? false;
      return JSON.parse(
        await nativeDevice().collectSignals(includeLocation)
      ) as SignalBundle;
    } catch (error) {
      this.log('getSignalsPreview failed', error);
      return null;
    }
  }

  /**
   * Collect the device signals and create a session. Call it before a sensitive action (sign-in,
   * payment, adding a beneficiary) and send `deviceSessionId` to your backend. A session is reused
   * until shortly before it expires, so calling this often is cheap. Never throws.
   */
  async getDeviceSession(
    options: GetDeviceSessionOptions = {}
  ): Promise<DeviceSession> {
    const config = this.config;
    if (!config) {
      return this.failed('not_initialised', null);
    }

    if (!options.forceRefresh && this.isCacheValid(config)) {
      return this.cached!.session;
    }
    // Share one request between callers that ask at the same moment.
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.createSession(config).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private isCacheValid(config: Config): boolean {
    const cached = this.cached;
    return (
      cached !== null &&
      cached.customerId === this.customerId &&
      cached.includeLocation === config.location &&
      cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()
    );
  }

  private async createSession(config: Config): Promise<DeviceSession> {
    let deviceId: string | null = null;
    let body: Record<string, unknown>;
    let app: AppInfo;
    try {
      deviceId = await nativeDevice().getDeviceId();
      const signals = JSON.parse(
        await nativeDevice().collectSignals(config.location)
      ) as SignalBundle;
      app = await this.getAppInfo();
      body = {
        ...signals,
        device_id: deviceId,
        ...(this.customerId ? { customer_id: this.customerId } : {}),
        consent: { location: config.location },
        collected_at: new Date().toISOString(),
      };
    } catch (error) {
      this.log('collecting signals failed', error);
      return this.failed('native_error', deviceId);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}${SESSIONS_PATH}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Publishable-Key': config.publishableKey,
          'X-App-Id': app.appId,
          'X-SDK-Platform': Platform.OS,
          'X-SDK-Version': SDK_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return this.failed(this.errorForStatus(response.status), deviceId);
      }
      const payload = await response.json();
      const data = payload?.data;
      if (!data?.device_session_id) {
        return this.failed('server_error', deviceId);
      }

      const session: DeviceSession = {
        deviceSessionId: data.device_session_id,
        deviceId: data.device_id ?? deviceId,
        isKnownDevice: Boolean(data.is_known_device),
        expiresAt: data.expires_at,
      };
      const expiresAtMs = Date.parse(data.expires_at);
      if (!Number.isNaN(expiresAtMs)) {
        this.cached = {
          customerId: this.customerId,
          includeLocation: config.location,
          session,
          expiresAtMs,
        };
      }
      return session;
    } catch (error) {
      this.log('session request failed', error);
      const aborted = (error as { name?: string })?.name === 'AbortError';
      return this.failed(aborted ? 'timeout' : 'network_error', deviceId);
    } finally {
      clearTimeout(timer);
    }
  }

  private async getAppInfo(): Promise<AppInfo> {
    if (!this.appInfo) {
      this.appInfo = JSON.parse(await nativeDevice().getAppInfo()) as AppInfo;
    }
    return this.appInfo;
  }

  private errorForStatus(status: number): SessionError {
    if (status === 401 || status === 403) return 'unauthorised';
    if (status === 429) return 'rate_limited';
    if (status >= 400 && status < 500) return 'rejected';
    return 'server_error';
  }

  private failed(error: SessionError, deviceId: string | null): DeviceSession {
    this.log(`no device session: ${error}`);
    return { deviceSessionId: null, deviceId, error };
  }

  private log(message: string, detail?: unknown): void {
    if (this.config?.debug) {
      console.log(`[PremblyTM] ${message}`, detail ?? '');
    }
  }
}

export const PremblyTM = new PremblyTMClient();
