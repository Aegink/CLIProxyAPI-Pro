import { CanceledError, type AxiosRequestConfig } from 'axios';
import { apiClient } from '@/services/api/client';

type ProRequestConfig = AxiosRequestConfig & {
  managementApiNamespace: 'pro';
  managementConnectionRevision: number;
};

const proRequestConfig = (url: string, config?: AxiosRequestConfig): ProRequestConfig => {
  // Keep the configured server as the sole authority for the request origin.
  // In particular, do not turn legacy routes into absolute URLs carrying the
  // management credential to a caller-provided host.
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || url !== url.trim()) {
    throw new Error('Pro management requests require a relative API path');
  }
  return {
    ...config,
    managementApiNamespace: 'pro',
    // Capture synchronously: Axios runs its request interceptor in a later
    // microtask, possibly after setConfig has switched to a different server.
    managementConnectionRevision: apiClient.getConnectionRevision(),
  };
};

/** Same authentication, cancellation and connection fencing as the native client. */
export const proApiClient = {
  getConnectionRevision: () => apiClient.getConnectionRevision(),
  assertConnectionRevision: (revision: number) => {
    if (revision !== apiClient.getConnectionRevision()) {
      throw new CanceledError('Connection changed while the operation was in flight');
    }
  },
  get: <T = unknown>(url: string, config?: AxiosRequestConfig) =>
    apiClient.get<T>(url, proRequestConfig(url, config)),
  post: <T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.post<T>(url, data, proRequestConfig(url, config)),
  put: <T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.put<T>(url, data, proRequestConfig(url, config)),
  patch: <T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.patch<T>(url, data, proRequestConfig(url, config)),
  delete: <T = unknown>(url: string, config?: AxiosRequestConfig) =>
    apiClient.delete<T>(url, proRequestConfig(url, config)),
  getRaw: (url: string, config?: AxiosRequestConfig) =>
    apiClient.getRaw(url, proRequestConfig(url, config)),
  postForm: <T = unknown>(url: string, data: FormData, config?: AxiosRequestConfig) =>
    apiClient.postForm<T>(url, data, proRequestConfig(url, config)),
};
