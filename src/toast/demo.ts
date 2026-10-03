import { zonedTimeToUtc } from '../data/zoned.js';
import type { ToastDataApi } from './client.js';
import type { ToastEmployee, ToastJob, ToastOrder, ToastSelection, ToastTimeEntry } from './types.js';

/**
 * Deterministic synthetic restaurant used when TOAST_MCP_MODE=demo.
 * The same business date always produces the same data. Shaped like Stolen
 * Bell: lunch and dinner service, Bartender/Server/Host/Barback front of house.
 */

const TIME_ZONE = 'America/Vancouver';

const JOBS: ToastJob[] = [
  { guid: 'job-server', title: 'Server', tipped: true },
  { guid: 'job-bartender', title: 'Bartender', tipped: true },
  { guid: 'job-barback', title: 'Barback', tipped: true },
  { guid: 'job-host', title: 'Host', tipped: true },
  { guid: 'job-chef', title: 'Chef', tipped: false },
  { guid: 'job-cook', title: 'Line Cook', tipped: false },
  { guid: 'job-dish', title: 'Dishwasher', tipped: false },
];

const STAFF: Record<string, [first: string, last: string, jobs: string[], wage: number]> = {
  'emp-01': ['Mara', 'Chen', ['job-bartender'], 18],
  'emp-02': ['Devon', 'Patel', ['job-server', 'job-bartender'], 17.4],
  'emp-03': ['Sam', 'Okafor', ['job-server'], 17.4],
  'emp-04': ['Riley', 'Nguyen', ['job-server'], 17.4],
  'emp-05': ['Casey', 'Morales', ['job-bartender'], 18],
  'emp-06': ['Priya', 'Lindqvist', ['job-host'], 17.4],
  'emp-07': ['Jamie', 'Fraser', ['job-host'], 17.4],
  'emp-08': ['Tomas', 'Adeyemi', ['job-barback'], 17.4],
  'emp-09': ['Luis', 'Reyes', ['job-chef'], 26],
  'emp-10': ['Taylor', 'Kowalski', ['job-cook'], 21],
  'emp-11': ['Alex', 'Haddad', ['job-cook'], 21],
  'emp-12': ['Rowan', 'Singh', ['job-dish'], 17.4],
};

const CATEGORIES = [
  { guid: 'cat-food', name: 'Food' },
  { guid: 'cat-liquor', name: 'Liquor' },
  { guid: 'cat-beer', name: 'Beer' },
  { guid: 'cat-wine', name: 'Wine' },
  { guid: 'cat-na', name: 'Non-Alcoholic' },
];

const REVENUE_CENTERS = [
  { guid: 'rc-dining', name: 'Dining Room' },
  { guid: 'rc-bar', name: 'Bar' },
];

const MENU: [name: string, price: number, category: string][] = [
  ['Steak Frites', 34, 'cat-food'],
  ['Roast Half Chicken', 28, 'cat-food'],
  ['Mushroom Risotto', 24, 'cat-food'],
  ['Fish & Chips', 23, 'cat-food'],
  ['Caesar Salad', 15, 'cat-food'],
  ['Fries', 8, 'cat-food'],
  ['Old Fashioned', 15, 'cat-liquor'],
  ['House Margarita', 13, 'cat-liquor'],
  ['Negroni', 14, 'cat-liquor'],
  ['Draft Lager', 8, 'cat-beer'],
  ['IPA', 9, 'cat-beer'],
  ['Glass of Pinot Noir', 14, 'cat-wine'],
  ['Bottle of Sauvignon Blanc', 58, 'cat-wine'],
  ['Sparkling Water', 5, 'cat-na'],
];

/** [employee, job, start, end, unpaid break start (optional)] in local HH:MM; an end before the start means after midnight. */
type Shift = [employee: string, job: string, start: string, end: string, breakAt?: string];

function schedule(weekend: boolean): Shift[] {
  return [
    // Lunch
    ['emp-01', 'job-bartender', '10:45', '16:15'],
    ['emp-02', 'job-server', '11:00', '15:45'],
    ['emp-06', 'job-host', '11:00', '15:00'],
    ['emp-10', 'job-cook', '10:00', '16:00'],
    // Dinner (Devon doubles as a bartender; Casey's shift crosses 16:00)
    ['emp-02', 'job-bartender', '17:00', '23:00'],
    ['emp-05', 'job-bartender', '15:00', '00:30', '19:30'],
    ['emp-03', 'job-server', '16:00', '23:00', '19:00'],
    ['emp-04', 'job-server', '16:30', '22:30'],
    ['emp-07', 'job-host', '16:30', '21:30'],
    ...(weekend ? ([['emp-08', 'job-barback', '17:00', '23:30']] as Shift[]) : []),
    ['emp-09', 'job-chef', '14:00', '23:00'],
    ['emp-11', 'job-cook', '16:00', '23:00'],
    ['emp-12', 'job-dish', '17:00', '00:00'],
  ];
}

/** Mulberry32: tiny seeded PRNG so demo days are reproducible. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const money = (value: number) => Math.round(value * 100) / 100;
const toastTime = (instant: number) => new Date(instant).toISOString().replace('Z', '+0000');

function buildDay(businessDate: string): { timeEntries: ToastTimeEntry[]; orders: ToastOrder[] } {
  const random = rng(Number(businessDate));
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const iso = `${businessDate.slice(0, 4)}-${businessDate.slice(4, 6)}-${businessDate.slice(6, 8)}`;
  const weekend = [5, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());
  const at = (hhmm: string, after?: number) => {
    const instant = zonedTimeToUtc(iso, hhmm, TIME_ZONE);
    return after !== undefined && instant <= after ? instant + 86_400_000 : instant;
  };

  const orders: ToastOrder[] = [];
  const timeEntries: ToastTimeEntry[] = [];

  schedule(weekend).forEach(([employee, job, start, end, breakAt], index) => {
    const clockIn = at(start);
    const clockOut = at(end, clockIn);
    const breakStart = breakAt ? at(breakAt, clockIn) : undefined;
    const breakMs = breakStart ? 30 * 60_000 : 0;
    const hours = money((clockOut - clockIn - breakMs) / 3_600_000);
    const regularHours = Math.min(hours, 8);

    let cardTips = 0;
    let cashTips = 0;
    let gratuities = 0;
    if (job === 'job-server' || job === 'job-bartender') {
      const shiftHours = (clockOut - clockIn) / 3_600_000;
      const orderCount = Math.round(shiftHours * (job === 'job-server' ? 2.2 : 2.8) * (weekend ? 1.3 : 1));
      for (let n = 0; n < orderCount; n += 1) {
        const opened = clockIn + 15 * 60_000 + random() * Math.max(0, clockOut - clockIn - 90 * 60_000);
        const paid = Math.min(clockOut - 5 * 60_000, opened + (25 + random() * 60) * 60_000);
        const guests = job === 'job-server' ? 1 + Math.floor(random() * 4) : 1 + Math.floor(random() * 2);
        const selections: ToastSelection[] = [];
        const lines = guests + Math.floor(random() * (guests + 2));
        for (let line = 0; line < lines; line += 1) {
          const [displayName, price, category] =
            job === 'job-bartender' && random() < 0.7 ? pick(MENU.filter(([, , cat]) => cat !== 'cat-food')) : pick(MENU);
          const discounted = random() < 0.05;
          selections.push({
            displayName,
            quantity: 1,
            preDiscountPrice: price,
            price: discounted ? money(price * 0.8) : price,
            voided: random() < 0.02,
            salesCategory: { guid: category },
          });
        }
        const voided = random() < 0.01;
        const net = money(selections.filter((s) => !s.voided).reduce((sum, s) => sum + (s.price ?? 0), 0));
        const tax = money(net * 0.05);
        const tip = money(net * (0.14 + random() * 0.1));
        const cash = random() < 0.15;
        const gratuity = guests >= 4 && job === 'job-server' && random() < 0.3 ? money(net * 0.18) : 0;
        if (!voided) {
          if (cash) cashTips += tip;
          else cardTips += tip;
          gratuities += gratuity;
        }
        orders.push({
          guid: `ord-${businessDate}-${orders.length + 1}`,
          businessDate: Number(businessDate),
          openedDate: toastTime(opened),
          voided,
          numberOfGuests: guests,
          server: { guid: employee },
          revenueCenter: { guid: job === 'job-bartender' ? 'rc-bar' : 'rc-dining' },
          checks: [
            {
              openedDate: toastTime(opened),
              closedDate: toastTime(paid),
              amount: net,
              taxAmount: tax,
              totalAmount: money(net + tax),
              selections,
              payments: [
                {
                  type: cash ? 'CASH' : 'CREDIT',
                  amount: money(net + tax + gratuity),
                  tipAmount: tip,
                  paidDate: toastTime(paid),
                  paymentStatus: 'CAPTURED',
                },
              ],
              appliedServiceCharges: gratuity ? [{ name: 'Large party gratuity', chargeAmount: gratuity, gratuity: true }] : [],
            },
          ],
        });
      }
    }

    timeEntries.push({
      guid: `te-${businessDate}-${index}`,
      employeeReference: { guid: employee },
      jobReference: { guid: job },
      businessDate,
      inDate: toastTime(clockIn),
      outDate: toastTime(clockOut),
      breaks: breakStart
        ? [{ guid: `br-${businessDate}-${index}`, paid: false, inDate: toastTime(breakStart), outDate: toastTime(breakStart + breakMs) }]
        : [],
      regularHours,
      overtimeHours: money(hours - regularHours),
      hourlyWage: STAFF[employee]![3],
      nonCashTips: money(cardTips),
      declaredCashTips: money(cashTips),
      cashGratuityServiceCharges: 0,
      nonCashGratuityServiceCharges: money(gratuities),
    });
  });

  return { timeEntries, orders };
}

export class DemoToastApi implements ToastDataApi {
  async getRestaurant() {
    return {
      guid: 'demo-restaurant',
      general: { name: 'Stolen Bell (demo data)', locationName: 'Demo', timeZone: TIME_ZONE, currencyCode: 'CAD' },
    };
  }
  async listJobs() {
    return JOBS;
  }
  async listEmployees(): Promise<ToastEmployee[]> {
    return Object.entries(STAFF).map(([guid, [firstName, lastName, jobs]]) => ({
      guid,
      firstName,
      lastName,
      jobReferences: jobs.map((job) => ({ guid: job })),
    }));
  }
  async listTimeEntries(businessDate: string) {
    return buildDay(businessDate).timeEntries;
  }
  async listOrders(businessDate: string) {
    return buildDay(businessDate).orders;
  }
  async listSalesCategories() {
    return CATEGORIES;
  }
  async listRevenueCenters() {
    return REVENUE_CENTERS;
  }
}
