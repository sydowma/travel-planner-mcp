#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { chromium, Browser, BrowserContext } from "playwright";
import "dotenv/config";

// ==================== Playwright 浏览器实例管理 ====================
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

// 航班价格参考数据（基于历史数据）
const priceReference: Record<string, { min: number; max: number; avg: number }> = {
  "SZX-TYO": { min: 2500, max: 4500, avg: 3200 },
  "HKG-TYO": { min: 2000, max: 4000, avg: 2800 },
  "SZX-OSA": { min: 2200, max: 4200, avg: 3000 },
  "HKG-OSA": { min: 1800, max: 3800, avg: 2600 },
  "SZX-SEL": { min: 2000, max: 3500, avg: 2700 },
  "HKG-SEL": { min: 1800, max: 3200, avg: 2400 },
  "SZX-BKK": { min: 1200, max: 2500, avg: 1800 },
  "HKG-BKK": { min: 1000, max: 2200, avg: 1500 },
  "SZX-SIN": { min: 1500, max: 3000, avg: 2000 },
  "HKG-SIN": { min: 1200, max: 2800, avg: 1800 },
  "SZX-KUL": { min: 1000, max: 2000, avg: 1500 },
  "HKG-KUL": { min: 800, max: 1800, avg: 1200 },
};

type FlightEntry = {
  price: string;
  airline?: string;
  flight_number?: string;
  stops?: number;
  stop_city?: string | null;
  duration?: string;
  departure?: string;
  arrival?: string;
  from?: string;
  to?: string;
  cabin?: string;
  raw_text?: string;
};

type FlightPriceSnapshot = {
  lowestPriceCny: number;
  averagePriceCny: number;
  dataSource: string;
  sampleSize: number;
  usedFallback: boolean;
};

type FlightScheduleOption = {
  airline: string;
  flight_numbers: string[];
  departure_time: string;
  arrival_time: string;
  departure_airport: string;
  arrival_airport: string;
  transfer_count: number;
  duration_minutes: number;
  price_cny: number | null;
  data_source: string;
};

type ScrapeOptions = {
  navigationTimeoutMs?: number;
  postLoadWaitMs?: number;
  disableScrape?: boolean;
};

const ctripLowPriceApiUrl = "https://m.ctrip.com/restapi/soa2/15380/bjjson/FlightIntlAndInlandLowestPriceSearch";
const ctripLowPriceCache = new Map<string, Promise<Map<string, number>>>();

type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const airportToCitySlug: Record<string, string> = {
  SZX: "shenzhen",
  HKG: "hongkong",
  SHA: "shanghai",
  PVG: "shanghai",
  CAN: "guangzhou",
  TYO: "tokyo",
  NRT: "tokyo",
  HND: "tokyo",
  OSA: "osaka",
  KIX: "osaka",
  SEL: "seoul",
  ICN: "seoul",
  BKK: "bangkok",
  SIN: "singapore",
  FUK: "fukuoka",
};

const routeAlias: Record<string, string> = {
  NRT: "TYO",
  HND: "TYO",
  KIX: "OSA",
};

const weekdayIndexToKey: WeekdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const weekdayCnLabel: Record<WeekdayKey, string> = {
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
  sun: "周日",
};

const originNameMap: Record<string, string> = {
  SZX: "深圳",
  HKG: "香港",
  SHA: "上海",
  PVG: "上海",
};

function normalizeAirportCode(code: string): string {
  return code.trim().toUpperCase();
}

function normalizeRouteKey(origin: string, destination: string): string {
  const originCode = normalizeAirportCode(origin);
  const destinationCode = routeAlias[normalizeAirportCode(destination)] || normalizeAirportCode(destination);
  return `${originCode}-${destinationCode}`;
}

function getRoutePriceReference(origin: string, destination: string): { min: number; max: number; avg: number } {
  return priceReference[normalizeRouteKey(origin, destination)] || { min: 2000, max: 4000, avg: 2800 };
}

function parsePriceNumber(raw: string | number | undefined | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const normalized = String(raw).replace(/,/g, "");
  const match = normalized.match(/\d{3,6}/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function toCtripCityCode(code: string): string {
  const normalized = normalizeAirportCode(code);
  return routeAlias[normalized] || normalized;
}

function parseIsoDateParts(isoDate: string): { year: number; month: number; day: number } | null {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { year, month, day };
}

function toMonthStartDate(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function parseDotNetDateToIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = raw.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
  if (!match) return null;

  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp)) return null;

  const offset = match[2] || "+0800";
  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetHours = Number(offset.slice(1, 3));
  const offsetMinutes = Number(offset.slice(3, 5));
  if (!Number.isFinite(offsetHours) || !Number.isFinite(offsetMinutes)) return null;

  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  const date = new Date(timestamp + offsetMs);

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function fetchCtripLowPriceCalendar(
  origin: string,
  destination: string,
  year: number,
  month: number
): Promise<Map<string, number>> {
  const response = await axios.post<{
    responseStatus?: { Ack?: string };
    priceList?: Array<{ departDate?: string; totalPrice?: number; price?: number }>;
  }>(
    ctripLowPriceApiUrl,
    {
      departNewCityCode: toCtripCityCode(origin),
      arriveNewCityCode: toCtripCityCode(destination),
      startDate: toMonthStartDate(year, month),
      grade: 3,
      flag: 1,
      channelName: "FlightIntlOnline",
      searchType: 2,
      passengerList: [{ passengercount: 1, passengertype: "Adult" }],
      calendarSelections: [{ selectionType: 8, selectionContent: [String(month)] }],
    },
    {
      timeout: 15000,
      headers: {
        "content-type": "application/json;charset=UTF-8",
        referer: "https://flights.ctrip.com/",
      },
    }
  );

  const data = response.data;
  if (data?.responseStatus?.Ack !== "Success" || !Array.isArray(data.priceList)) {
    return new Map<string, number>();
  }

  const targetPrefix = `${year}-${String(month).padStart(2, "0")}`;
  const priceMap = new Map<string, number>();

  for (const item of data.priceList) {
    const date = parseDotNetDateToIso(item.departDate);
    if (!date || !date.startsWith(targetPrefix)) {
      continue;
    }

    const parsed = parsePriceNumber(item.totalPrice ?? item.price);
    if (!parsed || parsed < 300 || parsed > 50000) {
      continue;
    }

    const current = priceMap.get(date);
    if (!current || parsed < current) {
      priceMap.set(date, parsed);
    }
  }

  return priceMap;
}

function buildCalendarCacheKey(origin: string, destination: string, year: number, month: number): string {
  return `${toCtripCityCode(origin)}-${toCtripCityCode(destination)}-${year}-${String(month).padStart(2, "0")}`;
}

function getCachedCtripLowPriceCalendar(
  origin: string,
  destination: string,
  year: number,
  month: number
): Promise<Map<string, number>> {
  const key = buildCalendarCacheKey(origin, destination, year, month);
  const existing = ctripLowPriceCache.get(key);
  if (existing) {
    return existing;
  }

  const request = fetchCtripLowPriceCalendar(origin, destination, year, month).catch((error) => {
    ctripLowPriceCache.delete(key);
    throw error;
  });

  ctripLowPriceCache.set(key, request);
  return request;
}

async function getCalendarPriceSnapshot(
  origin: string,
  destination: string,
  departureDate: string,
  returnDate?: string
): Promise<FlightPriceSnapshot | null> {
  const departure = parseIsoDateParts(departureDate);
  if (!departure) return null;

  const outboundPromise = getCachedCtripLowPriceCalendar(origin, destination, departure.year, departure.month);

  const inbound = returnDate ? parseIsoDateParts(returnDate) : null;
  const inboundPromise = returnDate && inbound
    ? getCachedCtripLowPriceCalendar(destination, origin, inbound.year, inbound.month)
    : Promise.resolve<Map<string, number>>(new Map<string, number>());

  try {
    const [outboundMap, inboundMap] = await Promise.all([outboundPromise, inboundPromise]);

    const outboundPrice = outboundMap.get(departureDate);
    if (!outboundPrice) {
      return null;
    }

    if (!returnDate) {
      return {
        lowestPriceCny: outboundPrice,
        averagePriceCny: outboundPrice,
        dataSource: "抓取(携程低价日历)",
        sampleSize: 1,
        usedFallback: false,
      };
    }

    const inboundPrice = inboundMap.get(returnDate);
    if (!inboundPrice) {
      return null;
    }

    const roundTripPrice = outboundPrice + inboundPrice;
    return {
      lowestPriceCny: roundTripPrice,
      averagePriceCny: roundTripPrice,
      dataSource: "抓取(携程低价日历)",
      sampleSize: 2,
      usedFallback: false,
    };
  } catch {
    return null;
  }
}

function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysUtc(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getWeekdayKey(date: Date): WeekdayKey {
  return weekdayIndexToKey[date.getUTCDay()];
}

function listDatesByWeekdays(year: number, month: number, weekdays: WeekdayKey[]): Date[] {
  const weekdaySet = new Set(weekdays);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dates: Date[] = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (weekdaySet.has(getWeekdayKey(date))) {
      dates.push(date);
    }
  }

  return dates;
}

function generateMockFlights(
  origin: string,
  destination: string,
  departureDate: string,
  priceRef: { min: number; max: number; avg: number }
): FlightEntry[] {
  const airlines = [
    { code: "ZH", name: "深圳航空" },
    { code: "CX", name: "国泰航空" },
    { code: "JL", name: "日本航空" },
    { code: "NH", name: "全日空" },
    { code: "CA", name: "中国国航" },
    { code: "MU", name: "东方航空" },
    { code: "HX", name: "香港航空" },
  ];

  const flights: FlightEntry[] = [];
  const numFlights = 6 + Math.floor(Math.random() * 4);

  for (let i = 0; i < numFlights; i += 1) {
    const airline = airlines[Math.floor(Math.random() * airlines.length)];
    const isDirect = Math.random() > 0.3;
    const basePrice = priceRef.avg + (Math.random() - 0.5) * (priceRef.max - priceRef.min) * 0.6;
    const price = Math.max(priceRef.min, Math.round(basePrice * (isDirect ? 1.2 : 1)));
    const depHour = 6 + Math.floor(Math.random() * 14);
    const flightDuration = isDirect ? 4 + Math.random() : 7 + Math.random() * 4;
    const arrHour = depHour + flightDuration;
    const stops = isDirect ? 0 : Math.floor(Math.random() * 2) + 1;
    const stopCity = stops > 0 ? ["上海", "北京", "广州", "香港"][Math.floor(Math.random() * 4)] : null;

    flights.push({
      price: `${price} CNY`,
      airline: airline.name,
      flight_number: `${airline.code}${1000 + Math.floor(Math.random() * 9000)}`,
      stops,
      stop_city: stopCity,
      duration: `${Math.floor(flightDuration)}小时${Math.floor((flightDuration % 1) * 60)}分钟`,
      departure: `${departureDate}T${String(depHour).padStart(2, "0")}:${String(Math.floor(Math.random() * 6) * 10).padStart(2, "0")}:00`,
      arrival: `${departureDate}T${String(Math.floor(arrHour) % 24).padStart(2, "0")}:${String(Math.floor(Math.random() * 6) * 10).padStart(2, "0")}:00`,
      from: origin,
      to: destination,
      cabin: ["经济舱", "经济舱", "经济舱", "商务舱"][Math.floor(Math.random() * 4)],
    });
  }

  return flights.sort((a, b) => (parsePriceNumber(a.price) || 0) - (parsePriceNumber(b.price) || 0));
}

function buildCtripUrl(origin: string, destination: string, departureDate: string, returnDate?: string): string {
  const normalizedOrigin = normalizeAirportCode(origin);
  const normalizedDestination = normalizeAirportCode(destination);
  const fromCity = airportToCitySlug[normalizedOrigin] || normalizedOrigin.toLowerCase();
  const toCity = airportToCitySlug[normalizedDestination] || normalizedDestination.toLowerCase();

  if (returnDate) {
    return `https://flights.ctrip.com/international/search/round-${fromCity}-${toCity}?depdate=${departureDate}&arrdate=${returnDate}`;
  }
  return `https://flights.ctrip.com/international/search/oneway-${fromCity}-${toCity}?depdate=${departureDate}`;
}

function buildCtripOneWayListUrl(origin: string, destination: string, departureDate: string): string {
  const originCode = toCtripCityCode(origin).toLowerCase();
  const destinationCode = toCtripCityCode(destination).toLowerCase();
  return `https://flights.ctrip.com/online/list/oneway-${originCode}-${destinationCode}?depdate=${departureDate}`;
}

function normalizeDateTimeLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const matched = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (matched) {
    return `${matched[1]} ${matched[2]}`;
  }
  return trimmed;
}

function parseDurationToMinutes(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.round(raw));
  }
  if (typeof raw !== "string") {
    return 0;
  }

  const hourMatch = raw.match(/(\d+)\s*小时/);
  const minuteMatch = raw.match(/(\d+)\s*分钟/);
  const hours = hourMatch ? Number(hourMatch[1]) : 0;
  const minutes = minuteMatch ? Number(minuteMatch[1]) : 0;
  const total = hours * 60 + minutes;
  return Number.isFinite(total) ? total : 0;
}

function buildMockFlightScheduleOptions(
  origin: string,
  destination: string,
  departureDate: string,
  limit: number
): FlightScheduleOption[] {
  const priceRef = getRoutePriceReference(origin, destination);
  const mockFlights = generateMockFlights(origin, destination, departureDate, priceRef);
  const cappedLimit = Math.max(1, Math.min(limit, 8));

  return mockFlights.slice(0, cappedLimit).map((flight) => ({
    airline: flight.airline || "模拟航司",
    flight_numbers: flight.flight_number ? [flight.flight_number] : [],
    departure_time: normalizeDateTimeLabel(flight.departure),
    arrival_time: normalizeDateTimeLabel(flight.arrival),
    departure_airport: normalizeAirportCode(origin),
    arrival_airport: normalizeAirportCode(destination),
    transfer_count: typeof flight.stops === "number" ? flight.stops : 0,
    duration_minutes: parseDurationToMinutes(flight.duration),
    price_cny: parsePriceNumber(flight.price),
    data_source: "模拟航班(抓取受限)",
  }));
}

function parseScheduleOptionsFromBatchSearch(payload: unknown, limit: number): FlightScheduleOption[] {
  const root = payload as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object")
    ? (root.data as Record<string, unknown>)
    : root;

  const itineraryList = Array.isArray(data.flightItineraryList)
    ? (data.flightItineraryList as Array<Record<string, unknown>>)
    : Array.isArray(data.itineraryList)
    ? (data.itineraryList as Array<Record<string, unknown>>)
    : [];

  const options: FlightScheduleOption[] = [];

  for (const itinerary of itineraryList) {
    if (!itinerary || typeof itinerary !== "object") continue;
    const segments = Array.isArray(itinerary.flightSegments)
      ? (itinerary.flightSegments as Array<Record<string, unknown>>)
      : [];
    const segment = segments[0];
    if (!segment) continue;

    const flightList = Array.isArray(segment.flightList)
      ? (segment.flightList as Array<Record<string, unknown>>)
      : [];
    if (flightList.length === 0) continue;

    const firstLeg = flightList[0];
    const lastLeg = flightList[flightList.length - 1];
    const flightNumbers = flightList
      .map((item) => (typeof item.flightNo === "string" ? item.flightNo.trim() : ""))
      .filter((value) => Boolean(value));
    if (flightNumbers.length === 0) continue;

    const priceList = Array.isArray(itinerary.priceList)
      ? (itinerary.priceList as Array<Record<string, unknown>>)
      : [];
    let bestPrice: number | null = null;
    for (const priceItem of priceList) {
      const adultPrice = parsePriceNumber(priceItem.adultPrice as string | number | undefined);
      const adultTax = parsePriceNumber(priceItem.adultTax as string | number | undefined);
      const miseryIndex = parsePriceNumber(priceItem.miseryIndex as string | number | undefined);
      const candidate = adultPrice !== null && adultTax !== null ? adultPrice + adultTax : miseryIndex ?? adultPrice;
      if (candidate !== null && (bestPrice === null || candidate < bestPrice)) {
        bestPrice = candidate;
      }
    }

    const transferCountRaw = Number(segment.transferCount);
    const durationRaw = Number(segment.duration);
    const airlineName = typeof segment.airlineName === "string"
      ? segment.airlineName
      : typeof firstLeg.marketAirlineName === "string"
      ? firstLeg.marketAirlineName
      : "";

    options.push({
      airline: airlineName,
      flight_numbers: flightNumbers,
      departure_time: normalizeDateTimeLabel(firstLeg.departureDateTime),
      arrival_time: normalizeDateTimeLabel(lastLeg.arrivalDateTime),
      departure_airport: typeof firstLeg.departureAirportCode === "string" ? firstLeg.departureAirportCode : "",
      arrival_airport: typeof lastLeg.arrivalAirportCode === "string" ? lastLeg.arrivalAirportCode : "",
      transfer_count: Number.isFinite(transferCountRaw) ? transferCountRaw : 0,
      duration_minutes: Number.isFinite(durationRaw) ? durationRaw : 0,
      price_cny: bestPrice,
      data_source: "抓取(携程列表页)",
    });
  }

  options.sort((a, b) => {
    if (a.price_cny === null && b.price_cny !== null) return 1;
    if (a.price_cny !== null && b.price_cny === null) return -1;
    if (a.price_cny !== null && b.price_cny !== null && a.price_cny !== b.price_cny) {
      return a.price_cny - b.price_cny;
    }
    return a.duration_minutes - b.duration_minutes;
  });

  const cappedLimit = Math.max(1, Math.min(limit, 8));
  return options.slice(0, cappedLimit);
}

async function scrapeFlightScheduleOptions(
  origin: string,
  destination: string,
  departureDate: string,
  limit: number,
  options?: ScrapeOptions
): Promise<FlightScheduleOption[]> {
  if (options?.disableScrape) {
    return [];
  }

  let context: BrowserContext | null = null;
  const navigationTimeoutMs = options?.navigationTimeoutMs ?? 30000;
  const postLoadWaitMs = Math.max(options?.postLoadWaitMs ?? 3500, 3500);
  const collected: FlightScheduleOption[] = [];

  try {
    const browserInstance = await getBrowser();
    context = await browserInstance.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.on("response", async (response) => {
      if (collected.length > 0) return;

      try {
        const url = response.url();
        const contentType = response.headers()["content-type"] || "";
        if (!url.includes("/international/search/api/search/batchSearch") || !contentType.includes("json")) {
          return;
        }

        const json = await response.json();
        const parsed = parseScheduleOptionsFromBatchSearch(json, limit);
        if (parsed.length > 0) {
          collected.push(...parsed);
        }
      } catch {
        // 忽略单条响应错误，继续抓取。
      }
    });

    const listUrl = buildCtripOneWayListUrl(origin, destination, departureDate);
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });

    const waitStart = Date.now();
    const maxWaitMs = postLoadWaitMs + 7000;
    while (Date.now() - waitStart < maxWaitMs) {
      if (collected.length > 0) {
        break;
      }
      await page.waitForTimeout(250);
    }
  } catch (error) {
    console.error("scrapeFlightScheduleOptions error:", error);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // 忽略关闭错误。
      }
    }
  }

  const cappedLimit = Math.max(1, Math.min(limit, 8));
  if (collected.length > 0) {
    return collected.slice(0, cappedLimit);
  }
  return buildMockFlightScheduleOptions(origin, destination, departureDate, cappedLimit);
}

function extractPriceCandidatesFromPayload(payload: unknown): number[] {
  const prices: number[] = [];
  const data = payload as Record<string, unknown>;
  const rootData = (data.data || data.result || data) as Record<string, unknown>;

  const possibleLists = [
    rootData.flightList,
    rootData.list,
    data.flightList,
    (rootData as Record<string, unknown>).flights,
  ];

  for (const list of possibleLists) {
    if (!Array.isArray(list)) continue;

    for (const flight of list) {
      if (!flight || typeof flight !== "object") continue;
      const f = flight as Record<string, unknown>;
      const priceCandidates: Array<string | number | undefined | null> = [
        f.price as string | number | undefined,
        (f.salePrice as string | number | undefined),
        ((f.price as Record<string, unknown> | undefined)?.totalPrice as string | number | undefined),
        (((f.cabins as Array<Record<string, unknown>> | undefined)?.[0]?.price) as string | number | undefined),
      ];

      for (const candidate of priceCandidates) {
        const parsed = parsePriceNumber(candidate);
        if (parsed && parsed > 100 && parsed < 50000) {
          prices.push(parsed);
          break;
        }
      }
    }
  }

  return prices;
}

async function scrapeFlightPrices(
  origin: string,
  destination: string,
  departureDate: string,
  returnDate?: string,
  options?: ScrapeOptions
): Promise<number[]> {
  let context: BrowserContext | null = null;
  const allPrices: number[] = [];
  const navigationTimeoutMs = options?.navigationTimeoutMs ?? 30000;
  const postLoadWaitMs = options?.postLoadWaitMs ?? 3500;

  try {
    const browserInstance = await getBrowser();
    context = await browserInstance.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    page.on("response", async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()["content-type"] || "";
        const isPotentialFlightApi =
          url.includes("/api/flight/") ||
          url.includes("/flight/search") ||
          url.includes("/international/flight") ||
          url.includes("flightList") ||
          url.includes("Flight");

        if (!isPotentialFlightApi || !contentType.includes("json")) {
          return;
        }

        const json = await response.json();
        allPrices.push(...extractPriceCandidatesFromPayload(json));
      } catch {
        // 忽略单条响应错误，继续抓取。
      }
    });

    const ctripUrl = buildCtripUrl(origin, destination, departureDate, returnDate);
    console.error(`Scraping Ctrip: ${ctripUrl}`);
    await page.goto(ctripUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.waitForTimeout(postLoadWaitMs);

    const domPrices = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const matches = text.match(/[¥￥]\s?\d{3,6}/g) || [];
      return matches.slice(0, 80);
    });

    for (const raw of domPrices) {
      const parsed = parsePriceNumber(raw);
      if (parsed && parsed > 100 && parsed < 50000) {
        allPrices.push(parsed);
      }
    }
  } catch (error) {
    console.error("scrapeFlightPrices error:", error);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // 忽略关闭错误。
      }
    }
  }

  return allPrices
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function buildFallbackFlightSnapshot(
  origin: string,
  destination: string,
  departureDate: string,
  hasReturnDate: boolean
): FlightPriceSnapshot {
  const priceRef = getRoutePriceReference(origin, destination);
  const day = Number(departureDate.split("-")[2] || "15");
  const seasonalFactor = day >= 24 ? 1.25 : day >= 18 ? 1.12 : 0.98;
  const basePrice = hasReturnDate ? priceRef.avg * 2 : priceRef.avg;
  const adjustedAvg = Math.round(basePrice * seasonalFactor);
  const adjustedLow = Math.max(Math.round(adjustedAvg * 0.82), Math.round(priceRef.min * (hasReturnDate ? 2 : 1) * 0.75));

  return {
    lowestPriceCny: adjustedLow,
    averagePriceCny: adjustedAvg,
    dataSource: "参考模型",
    sampleSize: 0,
    usedFallback: true,
  };
}

async function getFlightPriceSnapshot(
  origin: string,
  destination: string,
  departureDate: string,
  returnDate?: string,
  options?: ScrapeOptions
): Promise<FlightPriceSnapshot> {
  const fallback = buildFallbackFlightSnapshot(origin, destination, departureDate, Boolean(returnDate));
  if (options?.disableScrape) {
    return fallback;
  }

  const calendarSnapshot = await getCalendarPriceSnapshot(origin, destination, departureDate, returnDate);
  if (calendarSnapshot) {
    return calendarSnapshot;
  }

  const scrapedPrices = await scrapeFlightPrices(origin, destination, departureDate, returnDate, options);

  const validUnique = Array.from(new Set(scrapedPrices)).filter((value) => value >= 500 && value <= 50000);
  if (validUnique.length === 0) {
    return fallback;
  }

  const lowest = validUnique[0];
  const shortlist = validUnique.slice(0, Math.min(validUnique.length, 5));
  const average = Math.round(shortlist.reduce((sum, value) => sum + value, 0) / shortlist.length);

  return {
    lowestPriceCny: lowest,
    averagePriceCny: average,
    dataSource: "抓取(携程)",
    sampleSize: validUnique.length,
    usedFallback: false,
  };
}

function getSakuraSignal(destination: string, departureDate: Date): { phase: string; blossomScore: number; crowdLevel: string } {
  const code = routeAlias[normalizeAirportCode(destination)] || normalizeAirportCode(destination);
  const month = departureDate.getUTCMonth() + 1;
  const day = departureDate.getUTCDate();

  if (month !== 3) {
    return { phase: "非典型樱花季", blossomScore: 55, crowdLevel: "中" };
  }

  const blossomStartByCity: Record<string, number> = {
    TYO: 24,
    OSA: 25,
    FUK: 20,
  };

  const start = blossomStartByCity[code] || 24;

  if (day < start - 5) {
    return { phase: "未开", blossomScore: 40, crowdLevel: "低" };
  }
  if (day < start) {
    return { phase: "将开", blossomScore: 65, crowdLevel: "中" };
  }
  if (day <= start + 4) {
    return { phase: "初绽", blossomScore: 88, crowdLevel: "中" };
  }
  if (day <= start + 10) {
    return { phase: "盛开", blossomScore: 98, crowdLevel: "高" };
  }
  return { phase: "樱吹雪", blossomScore: 72, crowdLevel: "中" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// 创建 MCP Server
const server = new McpServer({
  name: "travel-planner",
  version: "1.0.0",
});

// ==================== 工具1: 航班搜索 ====================
server.tool(
  "search_flights",
  "搜索航班信息，支持从深圳/香港出发到全球各地的航班查询",
  {
    origin: z.string().describe("出发城市或机场代码，如 'SZX'(深圳), 'HKG'(香港), 'CAN'(广州)"),
    destination: z.string().describe("目的地城市或机场代码，如 'NRT'(东京成田), 'HND'(东京羽田), 'TYO'(东京所有机场)"),
    departure_date: z.string().describe("出发日期，格式 YYYY-MM-DD，如 '2026-03-06'"),
    return_date: z.string().optional().describe("返程日期（可选），格式 YYYY-MM-DD"),
    currency: z.string().optional().default("CNY").describe("货币单位，默认 CNY"),
  },
  async ({ origin, destination, departure_date, return_date, currency }) => {
    const routeKey = `${origin}-${destination}`;
    const priceRef = priceReference[routeKey] || { min: 2000, max: 4000, avg: 2800 };

    // 生成模拟航班数据
    function generateMockFlights(): any[] {
      const airlines = [
        { code: "ZH", name: "深圳航空", bases: ["SZX"] },
        { code: "CX", name: "国泰航空", bases: ["HKG"] },
        { code: "JL", name: "日本航空", bases: ["HKG", "SZX"] },
        { code: "NH", name: "全日空", bases: ["HKG", "SZX"] },
        { code: "CA", name: "中国国航", bases: ["SZX", "HKG"] },
        { code: "MU", name: "东方航空", bases: ["SZX"] },
        { code: "HX", name: "香港航空", bases: ["HKG"] },
      ];

      const flights = [];
      const numFlights = 6 + Math.floor(Math.random() * 4);

      for (let i = 0; i < numFlights; i++) {
        const airline = airlines[Math.floor(Math.random() * airlines.length)];
        const isDirect = Math.random() > 0.3;
        const basePrice = priceRef.avg + (Math.random() - 0.5) * (priceRef.max - priceRef.min) * 0.6;
        const price = Math.round(basePrice * (isDirect ? 1.2 : 1));

        const depHour = 6 + Math.floor(Math.random() * 14);
        const flightDuration = isDirect ? 4 + Math.random() * 1 : 7 + Math.random() * 4;
        const arrHour = depHour + flightDuration;

        const stops = isDirect ? 0 : Math.floor(Math.random() * 2) + 1;
        const stopCity = stops > 0 ? ["上海", "北京", "广州", "香港"][Math.floor(Math.random() * 4)] : null;

        flights.push({
          price: `${price} CNY`,
          airline: airline.name,
          flight_number: `${airline.code}${1000 + Math.floor(Math.random() * 9000)}`,
          stops: stops,
          stop_city: stopCity,
          duration: `${Math.floor(flightDuration)}小时${Math.floor((flightDuration % 1) * 60)}分钟`,
          departure: `${departure_date}T${String(depHour).padStart(2, "0")}:${String(Math.floor(Math.random() * 6) * 10).padStart(2, "0")}:00`,
          arrival: `${departure_date}T${String(Math.floor(arrHour) % 24).padStart(2, "0")}:${String(Math.floor(Math.random() * 6) * 10).padStart(2, "0")}:00`,
          from: origin,
          to: destination,
          cabin: ["经济舱", "经济舱", "经济舱", "商务舱"][Math.floor(Math.random() * 4)],
        });
      }

      return flights.sort((a, b) => parseInt(a.price) - parseInt(b.price));
    }

    // 使用 Playwright 抓取 - 监听网络请求获取 API 数据
    async function scrapeFlights(): Promise<{ flights: any[]; source: string }> {
      let context: any = null;
      try {
        const browserInstance = await getBrowser();
        context = await browserInstance.newContext({
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          locale: "zh-CN",
          viewport: { width: 1280, height: 800 },
        });

        const page = await context.newPage();

        // 存储捕获的 API 响应
        const apiResponses: any[] = [];

        // 监听网络响应，捕获航班 API 数据
        page.on('response', async (response: any) => {
          const url = response.url();
          // 携程航班 API 的 URL 模式
          if (url.includes('/api/flight/') ||
              url.includes('/flight/search') ||
              url.includes('/international/flight') ||
              url.includes('flightList') ||
              url.includes('Flight')) {
            try {
              const contentType = response.headers()['content-type'] || '';
              if (contentType.includes('json')) {
                const json = await response.json();
                apiResponses.push({ url, data: json });
                console.error(`Captured API: ${url}`);
              }
            } catch (e) {
              // 不是 JSON 或解析失败，忽略
            }
          }
        });

        // 机场代码到城市名的映射
        const cityMap: Record<string, string> = {
          "SZX": "shenzhen", "HKG": "hongkong", "CAN": "guangzhou",
          "TYO": "tokyo", "NRT": "tokyo", "HND": "tokyo",
          "OSA": "osaka", "KIX": "osaka",
          "SEL": "seoul", "ICN": "seoul",
          "BKK": "bangkok", "SIN": "singapore",
        };

        const fromCity = cityMap[origin] || origin.toLowerCase();
        const toCity = cityMap[destination] || destination.toLowerCase();

        // 尝试携程
        const ctripUrl = return_date
          ? `https://flights.ctrip.com/international/search/round-${fromCity}-${toCity}?depdate=${departure_date}&arrdate=${return_date}`
          : `https://flights.ctrip.com/international/search/oneway-${fromCity}-${toCity}?depdate=${departure_date}`;

        console.error(`Scraping Ctrip: ${ctripUrl}`);
        await page.goto(ctripUrl, { waitUntil: 'networkidle', timeout: 45000 });

        // 等待 API 请求完成
        await page.waitForTimeout(8000);

        // 尝试从 DOM 获取数据（备用方案）
        const domFlights = await page.evaluate(() => {
          const results: any[] = [];

          // 多种选择器尝试
          const selectors = [
            '.flight-list-item',
            '[class*="FlightItem"]',
            '[class*="flight-card"]',
            '[data-flight]',
            '.list-item',
          ];

          for (const selector of selectors) {
            const cards = document.querySelectorAll(selector);
            if (cards.length > 0) {
              cards.forEach((card: any, idx: number) => {
                if (idx >= 10) return;
                const text = card.textContent || '';

                // 尝试提取价格（匹配 ¥ 或 数字）
                const priceMatch = text.match(/[¥￥]?\s*(\d{3,5})/);
                const price = priceMatch ? priceMatch[1] : null;

                if (price && parseInt(price) > 100) {
                  results.push({
                    price: `¥${price}`,
                    raw_text: text.substring(0, 200),
                  });
                }
              });
              if (results.length > 0) break;
            }
          }

          return results;
        });

        await context.close();

        // 处理 API 响应数据
        if (apiResponses.length > 0) {
          const flights: any[] = [];
          for (const resp of apiResponses) {
            const data = resp.data;
            // 尝试从不同的响应结构中提取航班数据
            const flightList = data?.data?.flightList ||
                             data?.flightList ||
                             data?.data?.list ||
                             data?.result?.flights ||
                             [];

            flightList.forEach((f: any) => {
              const price = f?.price?.totalPrice ||
                          f?.price ||
                          f?.salePrice ||
                          f?.cabins?.[0]?.price;
              if (price) {
                flights.push({
                  price: `¥${price}`,
                  airline: f?.airlineName || f?.carrier || f?.airlineCNName || "",
                  flight_number: f?.flightNo || f?.flightNumber || "",
                  departure: f?.depTime || f?.departureTime || "",
                  arrival: f?.arrTime || f?.arrivalTime || "",
                  duration: f?.duration || "",
                  stops: f?.stopCount || 0,
                  from: f?.depCity || origin,
                  to: f?.arrCity || destination,
                });
              }
            });
          }

          if (flights.length > 0) {
            return { flights: flights.slice(0, 10), source: "Ctrip API" };
          }
        }

        // 返回 DOM 解析结果
        if (domFlights.length > 0) {
          return { flights: domFlights.slice(0, 10), source: "Ctrip DOM" };
        }

        return { flights: [], source: "" };
      } catch (error) {
        console.error("Scraping error:", error);
        if (context) {
          try { await context.close(); } catch (e) {}
        }
        return { flights: [], source: "" };
      }
    }

    try {
      // 尝试抓取
      const { flights: scrapedFlights, source } = await scrapeFlights();

      // 验证抓取的数据是否有效
      const validFlights = scrapedFlights.filter(f => {
        const priceStr = f.price || "";
        const hasPrice = /[¥￥]?\s*\d{3,5}/.test(priceStr);
        return hasPrice;
      });

      // 如果有效数据不足，使用模拟数据
      const flights = validFlights.length >= 3 ? validFlights : generateMockFlights();
      const dataSource = validFlights.length >= 3 ? source : "模拟数据";

      // 计算往返总价
      let totalPrice = null;
      if (return_date && flights.length > 0) {
        const avgPrice = priceRef.avg * 2;
        totalPrice = {
          estimated: `${Math.round(avgPrice * 0.9)} - ${Math.round(avgPrice * 1.1)} CNY`,
          note: "往返总价预估",
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            data_source: dataSource,
            search_info: { origin, destination, departure_date, return_date },
            flights: flights,
            price_summary: {
              lowest: flights[0]?.price || `${priceRef.min} CNY`,
              average: `${priceRef.avg} CNY (单程)`,
              round_trip: totalPrice,
            },
            booking_links: [
              { name: "携程", url: `https://flights.ctrip.com/international/search/oneway-${origin.toLowerCase()}-${destination.toLowerCase()}?depdate=${departure_date}` },
              { name: "飞猪", url: "https://www.fliggy.com/" },
              { name: "Skyscanner", url: `https://www.skyscanner.net/transport/flights/${origin.toLowerCase()}/${destination.toLowerCase()}/` },
            ],
            tips: [
              `${origin} → ${destination}: 参考价格 ${priceRef.min}-${priceRef.max} CNY`,
              "3月樱花季建议提前2-3月预订",
              "周四/周五出发通常比周末便宜",
            ],
          }, null, 2),
        }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: errorMsg,
            fallback: generateMockFlights(),
          }, null, 2),
        }],
      };
    }
  }
);

// ==================== 工具2: 天气查询 ====================
server.tool(
  "get_weather",
  "查询目的地天气信息，帮助规划出行时间",
  {
    city: z.string().describe("城市名称，如 'Tokyo', 'Osaka', 'Sapporo'"),
    date: z.string().optional().describe("查询日期（可选），格式 YYYY-MM-DD，不填则查询当前天气"),
  },
  async ({ city, date }) => {
    try {
      const apiKey = process.env.OPENWEATHER_API_KEY;

      if (apiKey && !date) {
        // 当前天气
        const response = await axios.get(
          `https://api.openweathermap.org/data/2.5/weather`,
          {
            params: {
              q: city,
              appid: apiKey,
              units: "metric",
              lang: "zh_cn",
            },
          }
        );

        const data = response.data;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              location: data.name,
              country: data.sys.country,
              current_weather: {
                temp: `${data.main.temp}°C`,
                feels_like: `${data.main.feels_like}°C`,
                description: data.weather[0].description,
                humidity: `${data.main.humidity}%`,
                wind_speed: `${data.wind.speed} m/s`,
              },
              travel_advice: data.main.temp > 15
                ? "温度适宜，适合户外活动"
                : data.main.temp > 5
                ? "温度较低，建议带外套"
                : "天气寒冷，注意保暖",
            }, null, 2),
          }],
        };
      } else {
        // 返回日本主要城市3月天气信息（基于历史数据）
        const marchWeatherData: Record<string, object> = {
          "Tokyo": {
            avg_high: "13°C",
            avg_low: "5°C",
            rainy_days: 10,
            cherry_blossom_start: "3月24日左右",
            recommendation: "3月下旬是樱花季开始，最佳赏樱时间是3月底4月初",
          },
          "Osaka": {
            avg_high: "14°C",
            avg_low: "5°C",
            rainy_days: 9,
            cherry_blossom_start: "3月25日左右",
            recommendation: "大阪城公园是赏樱名所",
          },
          "Kyoto": {
            avg_high: "14°C",
            avg_low: "4°C",
            rainy_days: 10,
            cherry_blossom_start: "3月28日左右",
            recommendation: "哲学之道、岚山是赏樱绝佳地点",
          },
          "Sapporo": {
            avg_high: "5°C",
            avg_low: "-3°C",
            rainy_days: 12,
            cherry_blossom_start: "5月初",
            recommendation: "3月仍然较冷，樱花要到5月才开",
          },
          "Fukuoka": {
            avg_high: "15°C",
            avg_low: "6°C",
            rainy_days: 9,
            cherry_blossom_start: "3月20日左右",
            recommendation: "日本最早开樱花的城市之一",
          },
        };

        const cityData = marchWeatherData[city] || marchWeatherData["Tokyo"];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              mode: "historical_data",
              city: city,
              month: "3月",
              weather_info: cityData,
              general_march_info: {
                clothing: "建议穿薄外套或毛衣，早晚温差大",
                umbrella: "3月有约10天雨天，建议带伞",
                cherry_blossom_2026: "预计3月下旬开始盛开",
              },
              best_weekends_for_cherry_blossom: [
                { dates: "3/21-3/22", status: "初绽期，人较少" },
                { dates: "3/28-3/29", status: "盛花期，最佳观赏" },
                { dates: "4/4-4/5", status: "满开后期，仍有花" },
              ],
            }, null, 2),
          }],
        };
      }
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }, null, 2),
        }],
      };
    }
  }
);

// ==================== 工具3: 汇率查询 ====================
server.tool(
  "get_exchange_rate",
  "查询汇率信息，帮助计算旅行预算",
  {
    from: z.string().describe("原货币，如 'CNY', 'USD'"),
    to: z.string().describe("目标货币，如 'JPY', 'USD'"),
    amount: z.number().optional().default(1).describe("金额，默认1"),
  },
  async ({ from, to, amount }) => {
    try {
      const apiKey = process.env.EXCHANGE_RATE_API_KEY;

      if (apiKey) {
        const response = await axios.get(
          `https://v6.exchangerate-api.com/v6/${apiKey}/pair/${from}/${to}/${amount || 1}`
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              from,
              to,
              amount: amount || 1,
              result: response.data.conversion_result,
              rate: response.data.conversion_rate,
            }, null, 2),
          }],
        };
      } else {
        // 使用免费公开API
        const response = await axios.get(
          `https://api.exchangerate.host/latest?base=${from}&symbols=${to}`
        );
        const rate = response.data.rates[to];
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              from,
              to,
              amount: amount || 1,
              result: (amount || 1) * rate,
              rate,
              source: "exchangerate.host (免费API)",
            }, null, 2),
          }],
        };
      }
    } catch (error) {
      // 如果API都失败，返回固定汇率参考
      const fallbackRates: Record<string, number> = {
        "CNY_JPY": 21.5,
        "JPY_CNY": 0.0465,
        "USD_JPY": 155,
        "JPY_USD": 0.0065,
        "CNY_USD": 0.14,
        "USD_CNY": 7.2,
      };

      const key = `${from}_${to}`;
      const rate = fallbackRates[key] || 1;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            from,
            to,
            amount: amount || 1,
            result: (amount || 1) * rate,
            rate,
            source: "参考汇率（非实时），建议以实际为准",
            note: "API暂时不可用，以上为参考汇率",
          }, null, 2),
        }],
      };
    }
  }
);

// ==================== 工具4: 行程规划建议 ====================
server.tool(
  "plan_trip",
  "根据时间和偏好生成旅行行程建议",
  {
    destination: z.string().describe("目的地，如 'Tokyo', 'Osaka', 'Kyoto'"),
    days: z.number().describe("旅行天数"),
    interests: z.array(z.string()).optional().describe("兴趣爱好，如 'food', 'shopping', 'culture', 'nature', 'anime'"),
    budget: z.enum(["budget", "moderate", "luxury"]).optional().default("moderate").describe("预算级别"),
    departure: z.enum(["shenzhen", "hongkong"]).optional().default("shenzhen").describe("出发地"),
  },
  async ({ destination, days, interests, budget, departure }) => {
    // 行程模板
    const itineraries: Record<string, Record<number, object>> = {
      "Tokyo": {
        2: {
          day1: {
            theme: "东京经典文化游",
            morning: "浅草寺 - 东京最古老的寺庙",
            afternoon: "上野公园 - 赏樱名所，附近有国立博物馆",
            evening: "东京塔/晴空塔夜景 + 晚餐",
          },
          day2: {
            theme: "现代东京体验",
            morning: "明治神宫 + 原宿竹下通",
            afternoon: "涩谷十字路口 + 表参道购物",
            evening: "新宿歌舞伎町/居酒屋",
          },
        },
        3: {
          day1: {
            theme: "传统文化",
            morning: "浅草寺 + 仲见世商店街",
            afternoon: "上野公园 + 国立博物馆",
            evening: "隅田川游船 + 晴空塔",
          },
          day2: {
            theme: "现代都市",
            morning: "明治神宫 + 原宿",
            afternoon: "涩谷 + 表参道",
            evening: "六本木Hills夜景",
          },
          day3: {
            theme: "自由选择",
            morning: "筑地场外市场(美食) 或 秋叶原(动漫)",
            afternoon: "银座购物 或 TeamLab Borderless",
            evening: "新宿 或 河口湖看富士山(需整天)",
          },
        },
      },
    };

    const interestActivities: Record<string, string[]> = {
      "food": ["筑地市场", "一兰拉面", "米其林餐厅", "居酒屋体验"],
      "shopping": ["银座", "涩谷", "新宿", "表参道"],
      "culture": ["浅草寺", "明治神宫", "皇居", "国立博物馆"],
      "nature": ["上野公园", "新宿御苑", "河口湖看富士山"],
      "anime": ["秋叶原", "池袋Animate", "吉卜力美术馆"],
    };

    const selectedItinerary = itineraries[destination]?.[Math.min(days, 3)] || itineraries["Tokyo"][2];

    const departureInfo = departure === "hongkong"
      ? { airport: "HKG", airline_recommendation: "国泰、JAL、ANA直飞较多，约4小时" }
      : { airport: "SZX", airline_recommendation: "深航、日本航空有直飞，约4小时" };

    const budgetTips = {
      budget: "住胶囊酒店/青旅，吃便利店和拉面，用地铁通票",
      moderate: "住商务酒店，吃当地餐厅，部分打车",
      luxury: "住高级酒店/温泉旅馆，吃高级和牛/omakase",
    };

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          trip_plan: {
            destination,
            days,
            departure: departureInfo,
            budget_level: budget,
            budget_tips: budgetTips[budget || "moderate"],
          },
          itinerary: selectedItinerary,
          recommended_activities_based_on_interests: interests
            ? interests.flatMap(i => interestActivities[i] || [])
            : ["浅草寺", "上野公园", "涩谷", "银座"],
          estimated_costs: {
            budget: { accommodation: "200-400元/晚", food: "150-250元/天", transport: "50-100元/天" },
            moderate: { accommodation: "500-800元/晚", food: "300-500元/天", transport: "100-200元/天" },
            luxury: { accommodation: "1500+元/晚", food: "800+元/天", transport: "300+元/天" },
          },
          important_notes: [
            "3月樱花季酒店需提前1-2月预订",
            "JR Pass 如果只玩东京不太划算，建议买Suica卡",
            "日本出租车很贵，优先选择地铁",
          ],
        }, null, 2),
      }],
    };
  }
);

// ==================== 工具5: 最佳出行日期分析 ====================
server.tool(
  "analyze_best_dates",
  "分析指定月份的最佳出行日期，综合考虑价格、天气、人流量",
  {
    month: z.number().describe("月份，如 3"),
    year: z.number().optional().default(2026).describe("年份"),
    departure: z.enum(["shenzhen", "hongkong"]).describe("出发地"),
    destination: z.string().describe("目的地"),
    prefer_weekend: z.boolean().optional().default(false).describe("是否偏好周末出行"),
  },
  async ({ month, year, departure, destination, prefer_weekend }) => {
    // 2026年3月的周末和周四/周五
    const march2026Weekends = [
      { weekend: "3/7-3/8", thursday: "3/5", friday: "3/6", note: "樱花季前，价格较低" },
      { weekend: "3/14-3/15", thursday: "3/12", friday: "3/13", note: "樱花季前，价格适中" },
      { weekend: "3/21-3/22", thursday: "3/19", friday: "3/20", note: "樱花初绽期" },
      { weekend: "3/28-3/29", thursday: "3/26", friday: "3/27", note: "樱花盛开期，旺季" },
    ];

    const analysis = {
      month: `${year}年${month}月`,
      destination,
      departure_options: [
        {
          from: "深圳(SZX)",
          flights: "深圳航空、日本航空、全日空",
          avg_price_range: "2500-4500元往返",
          pros: "离家近，无需过关",
          cons: "航班选择相对较少",
        },
        {
          from: "香港(HKG)",
          flights: "国泰、JAL、ANA、香港航空",
          avg_price_range: "2000-4000元往返",
          pros: "航班多，价格有时更便宜",
          cons: "需提前过关，耗时增加",
        },
      ],
      weekend_analysis: march2026Weekends.map(w => ({
        ...w,
        price_level: w.note.includes("旺季") ? "高" : w.note.includes("较低") ? "低" : "中",
        cherry_blossom_status: w.note.includes("盛开") ? "最佳" : w.note.includes("初绽") ? "开始" : "未开",
        recommendation_score: w.note.includes("盛开") ? 9 : w.note.includes("初绽") ? 8 : w.note.includes("较低") ? 7 : 6,
      })),
      best_value_recommendation: {
        dates: "3/12-3/13 或 3/19-3/20",
        reason: "价格适中，人流较少，樱花季刚开始",
        estimated_savings: "比3/26-3/28节省约30%机票酒店费用",
      },
      best_experience_recommendation: {
        dates: "3/26-3/29",
        reason: "樱花盛开期，体验最佳",
        note: "需提前预订，价格较高",
      },
    };

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(analysis, null, 2),
      }],
    };
  }
);

// ==================== 工具6: 窗口抓取与最佳日期推荐 ====================
server.tool(
  "scan_trip_windows",
  "批量抓取指定月份的短途出行日期窗口，适合周四/周五出发、4天左右行程，输出性价比和体验最佳方案",
  {
    year: z.number().optional().default(2026).describe("年份，如 2026"),
    month: z.number().optional().default(3).describe("月份，如 3"),
    origins: z.array(z.enum(["SZX", "HKG", "SHA", "PVG"])).optional().default(["SZX", "HKG"]).describe("出发机场代码列表"),
    destination: z.string().optional().default("TYO").describe("目的地机场/城市代码，如 TYO(东京)、OSA(大阪)"),
    trip_days: z.number().optional().default(4).describe("行程总天数，默认4天"),
    departure_weekdays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .optional()
      .default(["thu", "fri"])
      .describe("偏好的出发星期"),
    scoring_priority: z.enum(["value", "balanced", "experience"]).optional().default("balanced").describe("推荐偏好"),
    scrape: z.boolean().optional().default(true).describe("是否优先实时抓取"),
    max_results: z.number().optional().default(6).describe("返回前N个推荐窗口"),
  },
  async ({
    year,
    month,
    origins,
    destination,
    trip_days,
    departure_weekdays,
    scoring_priority,
    scrape,
    max_results,
  }) => {
    try {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "month 必须是 1-12 之间的整数",
            }, null, 2),
          }],
        };
      }

      const normalizedDestination = normalizeAirportCode(destination || "TYO");
      const uniqueOrigins = Array.from(new Set((origins || ["SZX", "HKG"]).map(normalizeAirportCode)));
      const selectedWeekdays = Array.from(new Set(departure_weekdays || ["thu", "fri"]));
      const plannedTripDays = clamp(Math.round(trip_days || 4), 2, 10);
      const topN = clamp(Math.round(max_results || 6), 1, 20);
      const departureDates = listDatesByWeekdays(year, month, selectedWeekdays);

      if (departureDates.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: "在指定月份中没有匹配到出发星期",
              query: { year, month, departure_weekdays: selectedWeekdays },
            }, null, 2),
          }],
        };
      }

      type WindowCandidate = {
        origin: string;
        departureDate: string;
        returnDate: string;
        weekday: WeekdayKey;
      };

      const windows: WindowCandidate[] = [];
      for (const origin of uniqueOrigins) {
        for (const departureDateObj of departureDates) {
          const departureDate = toIsoDate(departureDateObj);
          const returnDate = toIsoDate(addDaysUtc(departureDateObj, plannedTripDays - 1));
          windows.push({
            origin,
            departureDate,
            returnDate,
            weekday: getWeekdayKey(departureDateObj),
          });
        }
      }

      const snapshots = await mapWithConcurrency(
        windows,
        3,
        async (window): Promise<WindowCandidate & FlightPriceSnapshot> => {
          const snapshot = await getFlightPriceSnapshot(
            window.origin,
            normalizedDestination,
            window.departureDate,
            window.returnDate,
            {
              navigationTimeoutMs: 20000,
              postLoadWaitMs: 2500,
              disableScrape: !scrape,
            }
          );
          return { ...window, ...snapshot };
        }
      );

      const minPrice = Math.min(...snapshots.map((item) => item.lowestPriceCny));
      const maxPrice = Math.max(...snapshots.map((item) => item.lowestPriceCny));

      const crowdScoreMap: Record<string, number> = {
        低: 92,
        中: 74,
        高: 56,
      };

      const weightsByPriority: Record<string, { price: number; blossom: number; crowd: number }> = {
        value: { price: 0.7, blossom: 0.2, crowd: 0.1 },
        balanced: { price: 0.5, blossom: 0.35, crowd: 0.15 },
        experience: { price: 0.25, blossom: 0.6, crowd: 0.15 },
      };

      const selectedWeights = weightsByPriority[scoring_priority || "balanced"] || weightsByPriority.balanced;

      const evaluated = snapshots.map((item) => {
        const depDate = new Date(`${item.departureDate}T00:00:00.000Z`);
        const sakura = getSakuraSignal(normalizedDestination, depDate);
        const priceScore = maxPrice === minPrice
          ? 80
          : Math.round(100 - ((item.lowestPriceCny - minPrice) / (maxPrice - minPrice)) * 100);
        const crowdScore = crowdScoreMap[sakura.crowdLevel] || 70;
        const recommendationScore = Math.round(
          priceScore * selectedWeights.price +
            sakura.blossomScore * selectedWeights.blossom +
            crowdScore * selectedWeights.crowd
        );

        const reasonParts = [
          `${originNameMap[item.origin] || item.origin}${weekdayCnLabel[item.weekday]}出发`,
          `约${plannedTripDays}天`,
          `最低约¥${item.lowestPriceCny}`,
          `樱花:${sakura.phase}`,
        ];
        if (item.usedFallback) {
          reasonParts.push("价格为参考模型估算");
        }

        return {
          origin: item.origin,
          origin_city: originNameMap[item.origin] || item.origin,
          destination: normalizedDestination,
          departure_date: item.departureDate,
          return_date: item.returnDate,
          weekday: item.weekday,
          weekday_cn: weekdayCnLabel[item.weekday],
          trip_days: plannedTripDays,
          lowest_price_cny: item.lowestPriceCny,
          average_price_cny: item.averagePriceCny,
          data_source: item.dataSource,
          sample_size: item.sampleSize,
          used_fallback: item.usedFallback,
          sakura_phase: sakura.phase,
          crowd_level: sakura.crowdLevel,
          price_score: priceScore,
          blossom_score: sakura.blossomScore,
          recommendation_score: recommendationScore,
          reason: reasonParts.join("，"),
        };
      });

      const ranked = [...evaluated].sort(
        (a, b) =>
          b.recommendation_score - a.recommendation_score ||
          a.lowest_price_cny - b.lowest_price_cny
      );
      const valueRanked = [...evaluated].sort(
        (a, b) =>
          a.lowest_price_cny - b.lowest_price_cny ||
          b.blossom_score - a.blossom_score
      );
      const experienceRanked = [...evaluated].sort(
        (a, b) =>
          b.blossom_score - a.blossom_score ||
          b.recommendation_score - a.recommendation_score ||
          a.lowest_price_cny - b.lowest_price_cny
      );

      const scrapedCount = evaluated.filter((item) => !item.used_fallback).length;
      const fallbackCount = evaluated.length - scrapedCount;
      const detailFetchCount = Math.min(topN, 3);
      const detailCandidates: typeof ranked = [];
      for (const candidate of [...ranked.slice(0, detailFetchCount), valueRanked[0], experienceRanked[0]]) {
        if (!candidate) continue;
        const exists = detailCandidates.some(
          (item) =>
            item.origin === candidate.origin &&
            item.departure_date === candidate.departure_date &&
            item.return_date === candidate.return_date
        );
        if (!exists) {
          detailCandidates.push(candidate);
        }
      }

      const scheduleDetailByWindow = new Map<
        string,
        {
          outbound_flights: FlightScheduleOption[];
          return_flights: FlightScheduleOption[];
          flight_details_source: string;
          used_mock_schedule: boolean;
        }
      >();

      if (scrape && detailCandidates.length > 0) {
        const detailResults = await mapWithConcurrency(
          detailCandidates,
          2,
          async (item) => {
            const [outboundFlights, returnFlights] = await Promise.all([
              scrapeFlightScheduleOptions(item.origin, normalizedDestination, item.departure_date, 3, {
                navigationTimeoutMs: 25000,
                postLoadWaitMs: 3000,
                disableScrape: !scrape,
              }),
              scrapeFlightScheduleOptions(normalizedDestination, item.origin, item.return_date, 3, {
                navigationTimeoutMs: 25000,
                postLoadWaitMs: 3000,
                disableScrape: !scrape,
              }),
            ]);

            return {
              key: `${item.origin}|${item.departure_date}|${item.return_date}`,
              outbound_flights: outboundFlights,
              return_flights: returnFlights,
            };
          }
        );

        for (const item of detailResults) {
          const hasScrapedSchedule = [...item.outbound_flights, ...item.return_flights].some(
            (flight) => flight.data_source === "抓取(携程列表页)"
          );
          scheduleDetailByWindow.set(item.key, {
            outbound_flights: item.outbound_flights,
            return_flights: item.return_flights,
            flight_details_source: hasScrapedSchedule ? "抓取(携程列表页)" : "模拟航班(抓取受限)",
            used_mock_schedule: !hasScrapedSchedule,
          });
        }
      }

      const detailAttachedCount = Array.from(scheduleDetailByWindow.values()).filter(
        (item) => item.outbound_flights.length > 0 || item.return_flights.length > 0
      ).length;
      const detailScrapedCount = Array.from(scheduleDetailByWindow.values()).filter(
        (item) => !item.used_mock_schedule
      ).length;

      const attachScheduleDetails = <T extends { origin: string; departure_date: string; return_date: string }>(item: T): T => {
        const key = `${item.origin}|${item.departure_date}|${item.return_date}`;
        const detail = scheduleDetailByWindow.get(key);
        if (!detail) {
          return item;
        }
        return { ...item, ...detail };
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            query: {
              year,
              month,
              origins: uniqueOrigins,
              destination: normalizedDestination,
              trip_days: plannedTripDays,
              departure_weekdays: selectedWeekdays,
              scoring_priority,
              scrape,
            },
            scan_summary: {
              total_windows: evaluated.length,
              scraped_windows: scrapedCount,
              fallback_windows: fallbackCount,
              flight_detail_targets: detailCandidates.length,
              flight_detail_attached: detailAttachedCount,
              flight_detail_scraped: detailScrapedCount,
              note: scrapedCount > 0 ? "包含实时抓取结果" : "当前为参考价格模型，可重试抓取获取实时结果",
            },
            best_overall: ranked[0] ? attachScheduleDetails(ranked[0]) : null,
            best_value: valueRanked[0] ? attachScheduleDetails(valueRanked[0]) : null,
            best_experience: experienceRanked[0] ? attachScheduleDetails(experienceRanked[0]) : null,
            recommended_windows: ranked.slice(0, topN).map((item) => attachScheduleDetails(item)),
            booking_tips: [
              "周四/周五出发的4天行程通常是最常见短假组合（周日/周一返程）",
              "若追求樱花体验，优先看3月下旬；若追求预算，优先看3月上中旬",
              "从香港出发航班更多，但需要预留过关时间",
            ],
            follow_up_tools: [
              {
                tool: "search_flights",
                purpose: "对选中的具体日期做更细粒度航班抓取",
              },
              {
                tool: "plan_trip",
                purpose: "按已选日期生成4天详细行程",
              },
            ],
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }, null, 2),
        }],
      };
    }
  }
);

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Travel Planner MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
