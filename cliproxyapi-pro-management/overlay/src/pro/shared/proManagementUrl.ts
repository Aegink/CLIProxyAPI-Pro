export const PRO_MANAGEMENT_API_PREFIX = '/v0/management';

/** Accept either known management suffix and preserve the deployment path prefix. */
export const normalizeManagementApiBase = (input: string): string => {
  let base = (input || '').trim().replace(/\/+$/i, '');
  if (!base) return '';
  base = base.replace(/\/v(?:0|8)\/management$/i, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base;
};

/** Keep Pro on the contract supported by existing released Core binaries. */
export const computeProManagementApiUrl = (input: string): string => {
  const base = normalizeManagementApiBase(input);
  return base ? `${base}${PRO_MANAGEMENT_API_PREFIX}` : '';
};
