import { proApiClient as apiClient } from '@/pro/shared/proManagementTransport';

export interface ManagementUpdateResult {
  status: string;
  updated: boolean;
  sha256: string;
}

export const checkManagementPanelUpdate = () =>
  apiClient.post<ManagementUpdateResult>('/management-panel/check-update');
