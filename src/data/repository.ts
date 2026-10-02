import type { ToastDataApi } from '../toast/client.js';
import type { ToastOrder, ToastRestaurant, ToastTimeEntry } from '../toast/types.js';

export interface Reference {
  restaurant: ToastRestaurant;
  jobs: Map<string, { title: string; tipped: boolean }>;
  employees: Map<string, { name: string; jobGuids: string[]; deleted: boolean }>;
  salesCategories: Map<string, string>;
  revenueCenters: Map<string, string>;
}

export interface DayData {
  businessDate: string; // yyyyMMdd
  timeEntries: ToastTimeEntry[];
  orders: ToastOrder[];
}

const REFERENCE_TTL_MS = 10 * 60_000;
const DAY_TTL_MS = 5 * 60_000;

interface Cached<T> {
  expiresAt: number;
  value: Promise<T>;
}

export function employeeName(employee: { firstName?: string; lastName?: string; chosenName?: string }): string {
  const first = employee.chosenName?.trim() || employee.firstName?.trim() || '';
  return [first, employee.lastName?.trim()].filter(Boolean).join(' ') || 'Unnamed employee';
}

/** Caches Toast reads so repeated questions in one conversation don't refetch everything. */
export class ToastRepository {
  private reference_: Cached<Reference> | undefined;
  private readonly days = new Map<string, Cached<DayData>>();

  constructor(
    private readonly api: ToastDataApi,
    private readonly now: () => number = Date.now,
  ) {}

  reference(): Promise<Reference> {
    if (!this.reference_ || this.reference_.expiresAt < this.now()) {
      const value = this.loadReference();
      value.catch(() => (this.reference_ = undefined));
      this.reference_ = { expiresAt: this.now() + REFERENCE_TTL_MS, value };
    }
    return this.reference_.value;
  }

  day(businessDate: string): Promise<DayData> {
    const cached = this.days.get(businessDate);
    if (cached && cached.expiresAt >= this.now()) return cached.value;
    const value = Promise.all([
      this.api.listTimeEntries(businessDate),
      this.api.listOrders(businessDate),
    ]).then(([timeEntries, orders]) => ({ businessDate, timeEntries, orders }));
    value.catch(() => this.days.delete(businessDate));
    this.days.set(businessDate, { expiresAt: this.now() + DAY_TTL_MS, value });
    return value;
  }

  daysFor(businessDates: string[]): Promise<DayData[]> {
    return Promise.all(businessDates.map((date) => this.day(date)));
  }

  private async loadReference(): Promise<Reference> {
    const [restaurant, jobs, employees, salesCategories, revenueCenters] = await Promise.all([
      this.api.getRestaurant(),
      this.api.listJobs(),
      this.api.listEmployees(),
      this.api.listSalesCategories(),
      this.api.listRevenueCenters(),
    ]);
    return {
      restaurant,
      jobs: new Map(jobs.map((job) => [job.guid, { title: job.title?.trim() || 'Untitled job', tipped: job.tipped ?? false }])),
      employees: new Map(
        employees.map((employee) => [
          employee.guid,
          {
            name: employeeName(employee),
            jobGuids: (employee.jobReferences ?? []).map((ref) => ref.guid),
            deleted: employee.deleted ?? false,
          },
        ]),
      ),
      salesCategories: new Map(salesCategories.map((category) => [category.guid, category.name?.trim() || 'Uncategorized'])),
      revenueCenters: new Map(revenueCenters.map((center) => [center.guid, center.name?.trim() || 'Unnamed revenue center'])),
    };
  }
}
