import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  GeminiCliQuotaBucketState,
  GeminiCliQuotaState,
} from '@/types';
import { proApiClient as apiClient } from '@/pro/shared/proManagementTransport';
import {
  isDisabledAuthFile,
  normalizeNumberValue,
  normalizeQuotaFraction,
  normalizeStringValue,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '@/features/quota/providers/types';
import { isGeminiCliFile, isRuntimeOnlyAuthFile } from '../quotaFile';
import { resolveGeminiCliTierDisplayLabel } from './geminiCliTierLabels';

export type GeminiCliQuotaData = {
  fileName: string;
  buckets: GeminiCliQuotaBucketState[];
  projectId: string;
  tierLabel: string | null;
  tierId: string | null;
  creditBalance: number | null;
};

const resolveGeminiCliTierDisplay = (
  tierId: unknown,
  upstreamLabel: unknown,
  t: TFunction
): string | null =>
  resolveGeminiCliTierDisplayLabel(tierId, upstreamLabel, (labelKey) =>
    t(`gemini_cli_quota.${labelKey}`)
  );

type PluginQuotaItem = {
  id: string;
  label: string;
  remaining_fraction?: number;
  remaining_amount?: number;
  reset_at?: string;
  model_ids?: string[];
  metadata?: Record<string, unknown>;
};

type PluginQuotaSnapshot = {
  schema_version: number;
  observed_at_ms: number;
  items: PluginQuotaItem[];
  plan?: {
    id?: string;
    label?: string;
    credit_balance?: number;
  };
  metadata?: Record<string, unknown>;
};

type PluginQuotaFetchResponse = {
  snapshot?: PluginQuotaSnapshot;
};

const PREMIUM_GEMINI_CLI_TIER_IDS = new Set(['g1-pro-tier', 'g1-ultra-tier']);

const fetchGeminiCliQuota = async (
  file: AuthFileItem,
  t: TFunction
): Promise<GeminiCliQuotaData> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('gemini_cli_quota.missing_auth_index'));
  }

  const response = await apiClient.post<PluginQuotaFetchResponse>('/quota/fetch', {
    auth_index: authIndex,
  });
  const snapshot = response.snapshot;
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new Error(t('gemini_cli_quota.empty_buckets'));
  }
  const buckets: GeminiCliQuotaBucketState[] = snapshot.items.map((item) => ({
    id: item.id,
    label: item.label,
    remainingFraction: normalizeQuotaFraction(item.remaining_fraction),
    remainingAmount: normalizeNumberValue(item.remaining_amount),
    resetTime: normalizeStringValue(item.reset_at) ?? undefined,
    tokenType: normalizeStringValue(item.metadata?.token_type),
    modelIds: Array.isArray(item.model_ids) ? item.model_ids : [],
  }));
  const tierId = normalizeStringValue(snapshot.plan?.id);
  return {
    fileName: file.name,
    buckets,
    projectId: normalizeStringValue(snapshot.metadata?.project_id) ?? '',
    tierLabel: resolveGeminiCliTierDisplay(tierId, snapshot.plan?.label, t),
    tierId,
    creditBalance: normalizeNumberValue(snapshot.plan?.credit_balance),
  };
};

export const GEMINI_CLI_CONFIG: QuotaProviderData<GeminiCliQuotaState, GeminiCliQuotaData> = {
  type: 'gemini-cli',
  i18nPrefix: 'gemini_cli_quota',
  filterFn: (file: AuthFileItem) =>
    isGeminiCliFile(file) && !isRuntimeOnlyAuthFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchGeminiCliQuota,
  storeSelector: (state) => state.geminiCliQuota,
  storeSetter: 'setGeminiCliQuota',
  buildLoadingState: () => ({
    status: 'loading',
    buckets: [],
    projectId: '',
    tierLabel: null,
    tierId: null,
    creditBalance: null,
  }),
  buildSuccessState: (data: GeminiCliQuotaData) => ({
    status: 'success',
    buckets: data.buckets,
    projectId: data.projectId,
    tierLabel: data.tierLabel,
    tierId: data.tierId,
    creditBalance: data.creditBalance,
    quotaProviderSnapshot: true,
  }),
  buildErrorState: (message: string, status?: number) => ({
    status: 'error',
    buckets: [],
    projectId: '',
    tierLabel: null,
    tierId: null,
    creditBalance: null,
    error: message,
    errorStatus: status,
  }),
};

export { PREMIUM_GEMINI_CLI_TIER_IDS, resolveGeminiCliTierDisplay };
