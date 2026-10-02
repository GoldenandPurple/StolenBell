import type { ToastDataApi } from './client.js';
import type { ToastEmployee, ToastJob, ToastOrder, ToastSelection, ToastTimeEntry } from './types.js';

/**
 * Deterministic synthetic restaurant used when TOAST_MCP_MODE=demo.
 * The same business date always produces the same data.
 */

const JOBS: ToastJob[] = [
  { guid: 'job-server', title: 'Server', tipped: true },
  { guid: 'job-bartender', title: 'Bartender', tipped: true },
  { guid: 'job-busser', title: 'Busser', tipped: true },
  { guid: 'job-host', title: 'Host', tipped: true },
  { guid: 'job-cook', title: 'Line Cook', tipped: false },
  { guid: 'job-dish', title: 'Dishwasher', tipped: false },
];

const STAFF: [guid: string, first: string, last: string, job: string, wage: number][] = [
  ['emp-01', 'Avery', 'Chen', 'job-server', 17.4],
  ['emp-02', 'Jordan', 'Patel', 'job-server', 17.4],
  ['emp-03', 'Sam', 'Okafor', 'job-server', 17.4],
  ['emp-04', 'Riley', 'Nguyen', 'job-server', 17.4],
  ['emp-05', 'Casey', 'Morales', 'job-bartender', 18],
  ['emp-06', 'Drew', 'Lindqvist', 'job-bartender', 18],
  ['emp-07', 'Jamie', 'Fraser', 'job-busser', 17.4],
  ['emp-08', 'Quinn', 'Adeyemi', 'job-busser', 17.4],
  ['emp-09', 'Morgan', 'Reyes', 'job-host', 17.4],
  ['emp-10', 'Taylor', 'Kowalski', 'job-cook', 21],
  ['emp-11', 'Alex', 'Haddad', 'job-cook', 22.5],
  ['emp-12', 'Charlie', 'Brooks', 'job-cook', 21],
  ['emp-13', 'Rowan', 'Singh', 'job-dish', 17.4],
];

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
  { guid: 'rc-patio', name: 'Patio' },
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

interface DemoDay {
  timeEntries: ToastTimeEntry[];
  orders: ToastOrder[];
}

function buildDay(businessDate: string): DemoDay {
  const random = rng(Number(businessDate));
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const shuffle = <T>(items: T[]) => [...items].sort(() => random() - 0.5);
  const byJob = (job: string) => STAFF.filter((member) => member[3] === job);
  const weekend = [5, 6].includes(new Date(`${businessDate.slice(0, 4)}-${businessDate.slice(4, 6)}-${businessDate.slice(6, 8)}T12:00:00Z`).getUTCDay());

  const working = [
    ...shuffle(byJob('job-server')).slice(0, weekend ? 4 : 3),
    ...shuffle(byJob('job-bartender')).slice(0, weekend ? 2 : 1),
    ...shuffle(byJob('job-busser')).slice(0, weekend ? 2 : 1),
    ...byJob('job-host'),
    ...shuffle(byJob('job-cook')).slice(0, weekend ? 3 : 2),
    ...byJob('job-dish'),
  ];

  const orders: ToastOrder[] = [];
  const tips = new Map<string, { card: number; cash: number }>();
  let orderNumber = 0;
  for (const [guid, , , job] of working) {
    if (job !== 'job-server' && job !== 'job-bartender') continue;
    const tally = { card: 0, cash: 0 };
    const orderCount = (job === 'job-server' ? 9 : 14) + Math.floor(random() * 6) + (weekend ? 4 : 0);
    for (let i = 0; i < orderCount; i += 1) {
      orderNumber += 1;
      const guests = job === 'job-server' ? 1 + Math.floor(random() * 4) : 1 + Math.floor(random() * 2);
      const selections: ToastSelection[] = [];
      const lines = guests + Math.floor(random() * (guests + 2));
      for (let line = 0; line < lines; line += 1) {
        const [displayName, price, category] = job === 'job-bartender' && random() < 0.7
          ? pick(MENU.filter(([, , cat]) => cat !== 'cat-food'))
          : pick(MENU);
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
      const net = money(selections.filter((s) => !s.voided).reduce((sum, s) => sum + (s.price ?? 0), 0));
      const tax = money(net * 0.05);
      const tip = money(net * (0.14 + random() * 0.1));
      const cash = random() < 0.2;
      if (cash) tally.cash += tip;
      else tally.card += tip;
      const gratuity = guests >= 4 && job === 'job-server' && random() < 0.3 ? money(net * 0.18) : 0;
      orders.push({
        guid: `ord-${businessDate}-${orderNumber}`,
        businessDate: Number(businessDate),
        voided: random() < 0.01,
        numberOfGuests: guests,
        server: { guid },
        revenueCenter: { guid: job === 'job-bartender' ? 'rc-bar' : random() < 0.75 ? 'rc-dining' : 'rc-patio' },
        checks: [
          {
            amount: net,
            taxAmount: tax,
            totalAmount: money(net + tax),
            selections,
            payments: [{ type: cash ? 'CASH' : 'CREDIT', amount: money(net + tax + gratuity), tipAmount: tip, paymentStatus: cash ? 'CAPTURED' : 'CAPTURED' }],
            appliedServiceCharges: gratuity ? [{ name: 'Large party gratuity', chargeAmount: gratuity, gratuity: true }] : [],
          },
        ],
      });
    }
    tips.set(guid, tally);
  }

  const timeEntries: ToastTimeEntry[] = working.map(([guid, , , job, wage], index) => {
    const hours = money((job === 'job-host' || job === 'job-busser' ? 5 : 6.5) + random() * 2.5);
    const regularHours = Math.min(hours, 8);
    const tally = tips.get(guid);
    const startHour = job === 'job-cook' || job === 'job-dish' ? 15 : 16;
    return {
      guid: `te-${businessDate}-${index}`,
      employeeReference: { guid },
      jobReference: { guid: job },
      businessDate,
      inDate: `${businessDate.slice(0, 4)}-${businessDate.slice(4, 6)}-${businessDate.slice(6, 8)}T${startHour}:00:00.000+0000`,
      outDate: `${businessDate.slice(0, 4)}-${businessDate.slice(4, 6)}-${businessDate.slice(6, 8)}T23:30:00.000+0000`,
      regularHours,
      overtimeHours: money(hours - regularHours),
      hourlyWage: wage,
      nonCashTips: money(tally?.card ?? 0),
      declaredCashTips: money(tally?.cash ?? 0),
      cashGratuityServiceCharges: 0,
      nonCashGratuityServiceCharges: money(
        orders
          .filter((order) => !order.voided && order.server?.guid === guid)
          .flatMap((order) => order.checks ?? [])
          .flatMap((check) => check.appliedServiceCharges ?? [])
          .reduce((sum, charge) => sum + (charge.chargeAmount ?? 0), 0),
      ),
    };
  });

  return { timeEntries, orders };
}

export class DemoToastApi implements ToastDataApi {
  async getRestaurant() {
    return {
      guid: 'demo-restaurant',
      general: { name: 'The Stolen Bell (demo data)', locationName: 'Demo', timeZone: 'America/Vancouver', currencyCode: 'CAD' },
    };
  }
  async listJobs() {
    return JOBS;
  }
  async listEmployees(): Promise<ToastEmployee[]> {
    return STAFF.map(([guid, firstName, lastName, job]) => ({ guid, firstName, lastName, jobReferences: [{ guid: job }] }));
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
