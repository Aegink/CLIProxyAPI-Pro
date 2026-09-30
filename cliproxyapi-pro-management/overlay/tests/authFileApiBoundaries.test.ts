import { describe, expect, spyOn, test } from 'bun:test';
import { authFilesApi } from '../src/services/api/authFiles';
import { apiClient } from '../src/services/api/client';
import { authFileConnectionApi } from '../src/pro/authFiles/connectionTestApi';

describe('native auth file API boundaries', () => {
  test('fetches full and targeted lists independently and discards refresh tokens', async () => {
    const get = spyOn(apiClient, 'get');
    const post = spyOn(apiClient, 'post').mockResolvedValue({ access_token: 'discard-me' });
    try {
      await authFilesApi.requestManualRefresh('devin.json');
      get.mockResolvedValueOnce({ files: [{ name: 'all.json' }] });
      expect((await authFilesApi.list()).files[0].name).toBe('all.json');
      get.mockResolvedValueOnce({ files: [{ name: 'devin.json', auth_index: '2' }] });
      expect((await authFilesApi.list({ name: 'devin.json', authIndex: '2' })).files[0].name)
        .toBe('devin.json');
      expect(get).toHaveBeenLastCalledWith('/credentials', {
        params: { name: 'devin.json', auth_index: '2' },
      });
      get.mockResolvedValueOnce({ files: [{ name: 'latest.json' }] });
      expect((await authFilesApi.list()).files[0].name).toBe('latest.json');
      expect(get).toHaveBeenCalledTimes(3);

      expect(await authFilesApi.requestManualRefresh('devin.json', '2')).toBeUndefined();
      get.mockResolvedValueOnce({ files: [{ name: 'refreshed.json' }] });
      expect((await authFilesApi.list()).files[0].name).toBe('refreshed.json');
      expect(get).toHaveBeenCalledTimes(4);
    } finally {
      await authFilesApi.requestManualRefresh('devin.json');
      get.mockRestore();
      post.mockRestore();
    }
  });
});

describe('v8 credential model lookup extensions', () => {
  test('keeps identity and connection-test purpose on the native endpoint', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue({ models: [{ id: 'model-a' }] });
    try {
      expect(await authFileConnectionApi.getModelsForAuthFile('account name.json', ' index/2 '))
        .toEqual([{ id: 'model-a' }]);
      expect(get).toHaveBeenLastCalledWith(
        '/credentials/models?name=account%20name.json&auth_index=index%2F2&purpose=connection-test'
      );
      await authFilesApi.getModelsForAuthFile('account.json');
      expect(get).toHaveBeenLastCalledWith('/credentials/models?name=account.json');
    } finally {
      get.mockRestore();
    }
  });
});

test('downloads credential exports through the native v8 endpoint', async () => {
  const data = new Blob(['{"fixture":true}']);
  const getRaw = spyOn(apiClient, 'getRaw').mockResolvedValue({ data } as never);
  try {
    expect(await authFilesApi.download('account name.json')).toBe(data);
    expect(getRaw).toHaveBeenLastCalledWith('/credentials/download?name=account%20name.json', {
      responseType: 'blob',
    });
  } finally {
    getRaw.mockRestore();
  }
});
