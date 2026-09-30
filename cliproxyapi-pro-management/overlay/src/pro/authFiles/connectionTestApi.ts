import { apiClient } from '@/services/api/client';
import { proApiClient } from '@/pro/shared/proManagementTransport';

export type AuthFileConnectionTestResponse = {
  success: boolean;
  model?: string;
  latency_ms: number;
  output?: string;
  error?: string;
  error_code?: string;
  http_status?: number;
};

export type AuthFileConnectionTestRequest = {
  name: string;
  auth_index?: string;
  model: string;
};

type AuthFileModel = { id: string; display_name?: string; type?: string; owned_by?: string };

export const authFileConnectionApi = {
  testConnection: (payload: AuthFileConnectionTestRequest, signal?: AbortSignal) =>
    proApiClient.post<AuthFileConnectionTestResponse>('/auth-files/test', payload, { signal }),

  async getModelsForAuthFile(name: string, authIndex?: string): Promise<AuthFileModel[]> {
    const normalizedAuthIndex = authIndex?.trim();
    const authIndexQuery = normalizedAuthIndex
      ? `&auth_index=${encodeURIComponent(normalizedAuthIndex)}`
      : '';
    const data = await apiClient.get<Record<string, unknown>>(
      `/credentials/models?name=${encodeURIComponent(name)}${authIndexQuery}&purpose=connection-test`
    );
    const models = data.models ?? data['models'];
    return Array.isArray(models) ? (models as AuthFileModel[]) : [];
  },
};
