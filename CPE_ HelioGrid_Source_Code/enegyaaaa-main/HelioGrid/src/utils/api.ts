import { SensorData, AnomalyLog, SSRState, SensorLogEntry, BuzzerState } from './types';

const getApiBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  return `http://${window.location.hostname}:5000/api`;
};

const getAuthBaseUrl = () => {
  if (import.meta.env.VITE_AUTH_BASE_URL) return import.meta.env.VITE_AUTH_BASE_URL;
  return `http://${window.location.hostname}:5000`;
};

const API_BASE_URL = getApiBaseUrl();
const AUTH_BASE_URL = getAuthBaseUrl();

// [FIX-TIMEOUT] Hard 8s timeout on every API request.
// Without this, Flask hangs (slow DB query, serial wait) kept the browser
// waiting 30-120s before throwing — causing 3 consecutive "failures" and
// the offline banner even though Flask was actually alive.
// 8s is generous enough for slow Pi DB writes but short enough to fail-fast.
const API_TIMEOUT_MS = 8000;

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  // Merge caller signal (e.g. page-switch abort) with the hard timeout signal.
  // AbortSignal.any() fires on whichever triggers first.
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(url, {
      ...options,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (error) {
    console.error(`API Request Error [${endpoint}]:`, error);
    throw error;
  }
}

export function loginWithGoogle(): void {
  window.location.href = `${AUTH_BASE_URL}/auth/google`;
}

export async function logout(): Promise<void> {
  window.location.href = `${AUTH_BASE_URL}/auth/logout`;
}

export function parseAuthFromUrl(): { email: string; name: string; picture: string } | null {
  const params = new URLSearchParams(window.location.search);
  const email = params.get('email');
  const name = params.get('name');
  const picture = params.get('picture');

  if (email && name) {
    return { email, name, picture: picture || '' };
  }
  return null;
}

export const getCurrentSensorData = () => apiRequest<SensorData>('/sensor-data/current');
export const getSensorHistory = (limit = 288) => apiRequest<{logs: SensorLogEntry[]}>('/sensor-data/logs?limit=' + limit);
export const getAnomalyLogs = (limit = 50) => apiRequest<{logs: AnomalyLog[]}>('/anomaly-logs?limit=' + limit);
export const getSSRState = () => apiRequest<SSRState>('/ssr/state');
export const updateSSRState = (state: Partial<SSRState>) => apiRequest<SSRState>('/ssr/state', { method: 'POST', body: JSON.stringify(state) });
export const checkHealth = () => apiRequest<{status: string}>('/system/health');
export const getBuzzerState = () => apiRequest<BuzzerState>('/buzzer/state');
export const triggerBuzzer = (durationMs = 5000) => apiRequest('/buzzer/trigger', { method: 'POST', body: JSON.stringify({ duration_ms: durationMs }) });

export async function testConnection(): Promise<boolean> {
  try {
    await checkHealth();
    return true;
  } catch {
    return false;
  }
}

export const controlOutlet = (outlet: string, on: boolean) =>
  apiRequest(`/ssr/${outlet}`, { method: 'POST', body: JSON.stringify({ state: on }) });

export async function post(endpoint: string, body: unknown): Promise<Response> {
  return fetch(`/api${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
