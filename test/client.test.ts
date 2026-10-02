import { describe, expect, it } from 'vitest';
import { ToastApiError, ToastClient } from '../src/toast/client.js';

type Handler = (url: URL, init: RequestInit) => Response;

function fakeFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const login = () => json({ token: { accessToken: 'tok', expiresIn: 3600 } });

const client = (impl: typeof fetch) =>
  new ToastClient({ accessUrl: 'https://toast.example', clientId: 'id', clientSecret: 'secret', restaurantGuid: 'rest-1', fetchImpl: impl });

describe('ToastClient', () => {
  it('logs in once and sends the token and restaurant header', async () => {
    const { impl, calls } = fakeFetch((url) => (url.pathname.endsWith('/login') ? login() : json([{ guid: 'j1', title: 'Server' }])));
    const api = client(impl);
    await api.listJobs();
    await api.listJobs();
    expect(calls.filter((c) => c.url.pathname.endsWith('/login'))).toHaveLength(1);
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['Toast-Restaurant-External-ID']).toBe('rest-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ userAccessType: 'TOAST_MACHINE_CLIENT' });
  });

  it('pages through ordersBulk until a short page', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith('/login')) return login();
      const page = Number(url.searchParams.get('page'));
      const size = page < 3 ? 100 : 7;
      return json(Array.from({ length: size }, (_, i) => ({ guid: `${page}-${i}` })));
    });
    const orders = await client(impl).listOrders('20261001');
    expect(orders).toHaveLength(207);
    const pages = calls.filter((c) => c.url.pathname.endsWith('ordersBulk'));
    expect(pages.map((c) => c.url.searchParams.get('businessDate'))).toEqual(['20261001', '20261001', '20261001']);
  });

  it('retries 429 honoring Retry-After', async () => {
    let attempts = 0;
    const { impl } = fakeFetch((url) => {
      if (url.pathname.endsWith('/login')) return login();
      attempts += 1;
      return attempts === 1 ? json({}, 429, { 'retry-after': '0' }) : json([]);
    });
    await expect(client(impl).listEmployees()).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('re-authenticates once on 401', async () => {
    let logins = 0;
    let attempts = 0;
    const { impl } = fakeFetch((url) => {
      if (url.pathname.endsWith('/login')) {
        logins += 1;
        return login();
      }
      attempts += 1;
      return attempts === 1 ? json({}, 401) : json([]);
    });
    await client(impl).listJobs();
    expect(logins).toBe(2);
  });

  it('surfaces API errors with the request id but never the secret', async () => {
    const { impl } = fakeFetch((url) =>
      url.pathname.endsWith('/login') ? login() : json({ message: 'Forbidden scope' }, 403, { 'toast-request-id': 'req-9' }),
    );
    const error = await client(impl).listTimeEntries('20261001').catch((e) => e);
    expect(error).toBeInstanceOf(ToastApiError);
    expect(error.message).toBe('Toast API request failed with HTTP 403: Forbidden scope');
    expect(error.requestId).toBe('req-9');
    expect(error.message).not.toContain('secret');
  });
});
