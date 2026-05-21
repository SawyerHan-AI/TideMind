/**
 * tests/client/device.test.ts
 *
 * 覆盖 client/electron/cloud/device.ts:
 *  - getDeviceId():返回模块级缓存
 *  - registerDevice():POST /api/v1/sync/devices,失败 silent return null
 *
 * 风险点:
 *  - 注册失败必须 silent return null,不能 throw 阻塞 sync 启动
 *  - body 必须包含 hostname/platform/os/app_version 让 server side 能区分设备
 *  - Authorization Bearer 必须用最新 accessToken,不是 mock 旧值
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

const { getCloudAuthMock, getCloudBaseUrlMock, getAppVersionMock } = vi.hoisted(() => ({
  getCloudAuthMock: vi.fn(),
  getCloudBaseUrlMock: vi.fn(),
  getAppVersionMock: vi.fn(),
}));

vi.mock('../../client/electron/cloud/auth-client.js', () => ({
  getCloudAuth: getCloudAuthMock,
  getCloudBaseUrl: getCloudBaseUrlMock,
}));

const mockApp = {
  getVersion: () => getAppVersionMock(),
};
// vitest 对 CJS 'electron' 包 + client 端 ESM import 解析的 mock 陷阱:
// client/electron/cloud/device.ts 的 `import { app } from 'electron'` 实际解析到
// client/node_modules/electron/index.js,只 mock 'electron' bare module 不够。
// 同时 mock 那个具体路径才能生效(见 secure-store.test.ts 同类 fix)。
vi.mock('electron', () => ({
  app: mockApp,
  default: { app: mockApp },
}));
vi.mock('../../client/node_modules/electron/index.js', () => ({
  app: mockApp,
  default: { app: mockApp },
}));

const { registerDevice, getDeviceId } = await import(
  '../../client/electron/cloud/device.js'
);

describe('device — registerDevice', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getCloudAuthMock.mockReset();
    getCloudBaseUrlMock.mockReset().mockReturnValue('https://cloud.test');
    getAppVersionMock.mockReset().mockReturnValue('0.2.70');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('getCloudAuth=null → 返回 null 不发 fetch', async () => {
    getCloudAuthMock.mockReturnValue(null);
    const result = await registerDevice();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetch 成功 → 返回 device id', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk_xyz' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dev-12345' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await registerDevice();
    expect(result).toBe('dev-12345');
    // getDeviceId() 应同步反映
    expect(getDeviceId()).toBe('dev-12345');
  });

  it('fetch 5xx → 返回 null + warn', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));

    const result = await registerDevice();
    expect(result).toBeNull();
  });

  it('fetch 4xx → 返回 null', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));

    const result = await registerDevice();
    expect(result).toBeNull();
  });

  it('fetch 抛错(网络断) → 返回 null 不抛', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(registerDevice()).resolves.toBeNull();
  });

  it('Authorization 头使用 Bearer + accessToken', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk_distinct_123' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'd1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await registerDevice();
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      'Bearer tk_distinct_123',
    );
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('body 包含 hostname/device_type/os_version/app_version', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    getAppVersionMock.mockReturnValue('0.2.71-beta');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'd2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await registerDevice();
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    expect(body.name).toBe(os.hostname());
    expect(body.device_type).toBe(`desktop-${process.platform}`);
    expect(body.os_version).toBe(os.release());
    expect(body.app_version).toBe('0.2.71-beta');
  });

  it('URL 是 /api/v1/sync/devices', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'd3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await registerDevice();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://cloud.test/api/v1/sync/devices');
  });

  it('method=POST', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'd4' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await registerDevice();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('多次成功调用 → deviceId 更新到最新', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'd-old' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'd-new' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await registerDevice();
    expect(getDeviceId()).toBe('d-old');
    await registerDevice();
    expect(getDeviceId()).toBe('d-new');
  });

  it('body 是有效 JSON 字符串', async () => {
    getCloudAuthMock.mockReturnValue({ accessToken: 'tk' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'd5' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await registerDevice();
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body;
    expect(typeof body).toBe('string');
    expect(() => JSON.parse(body as string)).not.toThrow();
  });
});

describe('device — getDeviceId initial state', () => {
  it('调用 registerDevice 之前 getDeviceId 可能返回 null 或最近一次的 ID', () => {
    // 注意:模块级 deviceId 跨 case 持久。这条断言只是验证 getDeviceId 不抛
    expect(() => getDeviceId()).not.toThrow();
  });
});
