/*
 * Portions adapted from toast-mcp-2026-complete (src/clients/toast.ts)
 * Copyright (c) 2026 BusyBee3333, MIT License. See NOTICE.md.
 */
import { z } from 'zod';
import type {
  ToastEmployee,
  ToastJob,
  ToastOrder,
  ToastRestaurant,
  ToastRevenueCenter,
  ToastSalesCategory,
  ToastTimeEntry,
} from './types.js';

export interface ToastClientConfig {
  accessUrl: string;
  clientId: string;
  clientSecret: string;
  restaurantGuid: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The read operations the rest of the server depends on (implemented by the live client and the demo fixture). */
export interface ToastDataApi {
  getRestaurant(): Promise<ToastRestaurant>;
  listJobs(): Promise<ToastJob[]>;
  listEmployees(): Promise<ToastEmployee[]>;
  listTimeEntries(businessDate: string): Promise<ToastTimeEntry[]>;
  listOrders(businessDate: string): Promise<ToastOrder[]>;
  listSalesCategories(): Promise<ToastSalesCategory[]>;
  listRevenueCenters(): Promise<ToastRevenueCenter[]>;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
}

const LoginResponseSchema = z.looseObject({
  token: z.looseObject({
    accessToken: z.string().min(1),
    expiresIn: z.number().positive(),
  }),
});

const ORDERS_PAGE_SIZE = 100;
const MAX_ORDER_PAGES = 200;

export class ToastApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ToastApiError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(4_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

async function safeErrorMessage(response: Response): Promise<string> {
  const fallback = `Toast API request failed with HTTP ${response.status}`;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const candidate = body.message ?? body.error ?? body.code;
    return typeof candidate === 'string' ? `${fallback}: ${candidate}` : fallback;
  } catch {
    return fallback;
  }
}

/** Read-only Toast API client for a single restaurant location. */
export class ToastClient implements ToastDataApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;
  private tokenPromise: Promise<string> | undefined;
  private pacingQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly config: ToastClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  async getRestaurant(): Promise<ToastRestaurant> {
    return (await this.get(
      `/restaurants/v1/restaurants/${encodeURIComponent(this.config.restaurantGuid)}`,
    )) as ToastRestaurant;
  }

  async listJobs(): Promise<ToastJob[]> {
    return asArray<ToastJob>(await this.get('/labor/v1/jobs'));
  }

  async listEmployees(): Promise<ToastEmployee[]> {
    return asArray<ToastEmployee>(await this.get('/labor/v1/employees'));
  }

  /** @param businessDate yyyyMMdd */
  async listTimeEntries(businessDate: string): Promise<ToastTimeEntry[]> {
    return asArray<ToastTimeEntry>(
      await this.get('/labor/v1/timeEntries', { query: { businessDate } }),
    );
  }

  /** All orders for a business date, following ordersBulk pagination. @param businessDate yyyyMMdd */
  async listOrders(businessDate: string): Promise<ToastOrder[]> {
    const orders: ToastOrder[] = [];
    for (let page = 1; page <= MAX_ORDER_PAGES; page += 1) {
      const batch = asArray<ToastOrder>(
        await this.get('/orders/v2/ordersBulk', {
          query: { businessDate, page, pageSize: ORDERS_PAGE_SIZE },
        }),
      );
      orders.push(...batch);
      if (batch.length < ORDERS_PAGE_SIZE) return orders;
    }
    throw new ToastApiError(
      `More than ${MAX_ORDER_PAGES * ORDERS_PAGE_SIZE} orders on ${businessDate}; refusing to continue paging`,
      500,
    );
  }

  async listSalesCategories(): Promise<ToastSalesCategory[]> {
    return asArray<ToastSalesCategory>(await this.get('/config/v2/salesCategories'));
  }

  async listRevenueCenters(): Promise<ToastRevenueCenter[]> {
    return asArray<ToastRevenueCenter>(await this.get('/config/v2/revenueCenters'));
  }

  private async get(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.config.accessUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.pace(path);
      const token = await this.getAccessToken();
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'Toast-Restaurant-External-ID': this.config.restaurantGuid,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 401 && attempt === 0) {
        this.clearToken();
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await delay(retryDelay(response, attempt));
        continue;
      }
      if (!response.ok) {
        throw new ToastApiError(
          await safeErrorMessage(response),
          response.status,
          response.headers.get('toast-request-id') ?? response.headers.get('x-request-id') ?? undefined,
        );
      }
      if (response.status === 204) return null;
      return response.json() as Promise<unknown>;
    }

    throw new ToastApiError('Toast API request failed after retries', 503);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 5 * 60_000) {
      return this.accessToken;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.login().finally(() => {
        this.tokenPromise = undefined;
      });
    }
    return this.tokenPromise;
  }

  private async login(): Promise<string> {
    const response = await this.fetchImpl(
      `${this.config.accessUrl}/authentication/v1/authentication/login`,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          userAccessType: 'TOAST_MACHINE_CLIENT',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new ToastApiError(
        await safeErrorMessage(response),
        response.status,
        response.headers.get('toast-request-id') ?? undefined,
      );
    }
    const parsed = LoginResponseSchema.parse(await response.json());
    this.accessToken = parsed.token.accessToken;
    this.accessTokenExpiresAt = Date.now() + parsed.token.expiresIn * 1_000;
    return this.accessToken;
  }

  private clearToken(): void {
    this.accessToken = undefined;
    this.accessTokenExpiresAt = 0;
  }

  /** Serialises requests and spaces them out to stay under Toast's per-endpoint rate limits. */
  private async pace(path: string): Promise<void> {
    const minimumInterval = path.includes('ordersBulk') ? 200 : 50;
    const turn = this.pacingQueue.then(async () => {
      await delay(Math.max(0, this.nextRequestAt - Date.now()));
      this.nextRequestAt = Date.now() + minimumInterval;
    });
    this.pacingQueue = turn.catch(() => undefined);
    await turn;
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
