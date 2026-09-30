export type TimestampedQuotaState = {
  cachedAt: number;
};

export const withQuotaCachedAt = <T extends object>(
  state: T,
  cachedAt = 'cachedAt' in state && typeof state.cachedAt === 'number' ? state.cachedAt : Date.now()
): T & TimestampedQuotaState => ({ ...state, cachedAt });
