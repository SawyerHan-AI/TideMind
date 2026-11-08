import { afterEach, describe, expect, it, vi } from 'vitest';
const { config, token } = vi.hoisted(() => ({ config: { cloud: { sync_enabled: true, metabolism_enabled: false } }, token: vi.fn(async (): Promise<string | null> => 'token') }));
vi.mock('../../src/config.js', () => ({ getConfig: () => config }));
vi.mock('../../client/electron/cloud/auth-client.js', () => ({ getCloudBaseUrl: () => 'https://cloud.test.example', refreshTokenIfNeeded: token }));
import { pushCloudMetabolismEnabled } from '../../client/electron/cloud/metabolism-settings.js';
afterEach(() => { vi.unstubAllGlobals(); token.mockResolvedValue('token'); config.cloud.sync_enabled = true; config.cloud.metabolism_enabled = false; });
describe('cloud metabolism preference propagation', () => {
  it('sends explicit disabled preference rather than omitting false', async () => {
    const request = vi.fn(async () => Response.json({ enabled: false })); vi.stubGlobal('fetch', request);
    await pushCloudMetabolismEnabled();
    expect(request).toHaveBeenCalledWith('https://cloud.test.example/api/v1/sync/metabolism', expect.objectContaining({ method: 'PUT', body: '{"enabled":false}' }));
  });
  it('disables cloud work if data sync is disabled even when the saved opt-in is true', async () => {
    config.cloud.sync_enabled = false; config.cloud.metabolism_enabled = true;
    const request = vi.fn(async () => Response.json({ enabled: false })); vi.stubGlobal('fetch', request);
    await pushCloudMetabolismEnabled();
    expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: '{"enabled":false}' }));
  });
  it.each([500, 403, 404])('rejects HTTP %s instead of pretending the preference is synchronized', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(pushCloudMetabolismEnabled(false)).rejects.toThrow(`HTTP ${status}`);
  });
  it('rejects mismatched server acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true })));
    await expect(pushCloudMetabolismEnabled(false)).rejects.toThrow('not confirmed');
  });
  it('serializes a late enable before a later disable and recovers after failure', async () => {
    let release!: (response: Response) => void;
    const firstResponse = new Promise<Response>(r => { release = r; });
    const request = vi.fn().mockReturnValueOnce(firstResponse).mockResolvedValueOnce(Response.json({ enabled: false })).mockResolvedValueOnce(Response.json({ enabled: false }));
    vi.stubGlobal('fetch', request);
    const enable = pushCloudMetabolismEnabled(true);
    const disable = pushCloudMetabolismEnabled(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release(new Response('', { status: 500 }));
    await expect(enable).rejects.toThrow('HTTP 500');
    await disable;
    await pushCloudMetabolismEnabled(false);
    expect(request.mock.calls.map(call => JSON.parse(call[1].body).enabled)).toEqual([true, false, false]);
  });
  it('does not send unauthenticated requests', async () => {
    token.mockResolvedValue(null); const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(pushCloudMetabolismEnabled()).rejects.toThrow('not_logged_in'); expect(request).not.toHaveBeenCalled();
  });
});
