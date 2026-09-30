import type { AxiosRequestConfig } from 'axios';
import { proApiClient as apiClient } from '@/pro/shared/proManagementTransport';
import { resolveTimeRange, type TimeRangeSelection } from './features/timeRange';

export type AccountUsageDayStat = {
  bucketStartMs: number;
  requests: number;
  tokens: number;
  estimatedCost: number;
};

export type AccountUsageModelStat = {
  model: string;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  estimatedCost: number;
};

export type AccountUsageAPIKeyStat = {
  apiKeyHash: string;
  requests: number;
  tokens: number;
  estimatedCost: number;
};

export type AccountUsageDetail = {
  authIndex: string;
  periodDays: number;
  fromMs: number;
  toMs: number;
  activeDays: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  cacheHitRequests: number;
  estimatedCost: number;
  pricedRequests: number;
  averageLatencyMs?: number;
  latencySamples: number;
  averageTtftMs?: number;
  ttftSamples: number;
  p95LatencyMs?: number;
  retryAttempts: number;
  retrySamples: number;
  streamRequests: number;
  today: AccountUsageDayStat;
  highestCostDay?: AccountUsageDayStat;
  highestRequestDay?: AccountUsageDayStat;
  history: AccountUsageDayStat[];
  models: AccountUsageModelStat[];
  apiKeys: AccountUsageAPIKeyStat[];
};

export type AccountUsageResponse = {
  detail: AccountUsageDetail;
  latest_id: number;
  generation: number;
  reset_at_ms: number;
  snapshot_at_ms: number;
};

export function buildAccountUsageRangeParams(timeRange: TimeRangeSelection, nowMs = Date.now()) {
  if (timeRange.type === 'preset' && timeRange.preset === 'all') return { days: 0 as const };
  const resolvedRange = resolveTimeRange(timeRange, nowMs);
  return {
    from_ms: resolvedRange.fromMs,
    to_ms: resolvedRange.toMs,
  };
}

export async function getAccountUsage(
  authIndex: string,
  timeRange: TimeRangeSelection,
  timezoneOffsetMinutes: number,
  timezone: string,
  config?: AxiosRequestConfig
): Promise<AccountUsageResponse> {
  const rangeParams = buildAccountUsageRangeParams(timeRange);
  return apiClient.get<AccountUsageResponse>('/usage/account', {
    ...config,
    params: {
      ...(config?.params ?? {}),
      auth_index: authIndex,
      ...rangeParams,
      timezone_offset_minutes: timezoneOffsetMinutes,
      timezone: timezone || undefined,
    },
  });
}
