/**
 * NASA FIRMS near-real-time active fire (VIIRS) data for the Indonesia region.
 *
 * The upstream FIRMS CSV files are public (no API key required) but NASA does
 * not send CORS headers, so browsers cannot read them directly. Everything in
 * this module is therefore designed to run on the server (Cloudflare Worker)
 * and only relies on web standard APIs: fetch, Response, AbortSignal and
 * TextDecoder. No Node specific APIs are used.
 *
 * Upstream feeds (all verified to return HTTP 200 with real data):
 *   - Suomi NPP  (VIIRS C2): /data/active_fire/viirs/csv/SUOMI_VIIRS_C2_SouthEast_Asia_<window>.csv
 *   - NOAA-20    (VIIRS C2): /data/active_fire/noaa20/csv/J1_VIIRS_C2_SouthEast_Asia_<window>.csv
 *
 * Only these two allowlisted URLs are ever requested: the API never accepts a
 * caller supplied URL.
 */

export type FireConfidence = "low" | "nominal" | "high";

export interface FireDetection {
  id: string;
  latitude: number;
  longitude: number;
  brightness: number | null;
  frp: number | null;
  confidence: FireConfidence;
  acquiredAt: string;
  satellite: string;
  daynight: string;
}

export interface FireSourceStatus {
  name: string;
  url: string;
  ok: boolean;
  error?: string;
}

export interface FiresResponse {
  detections: FireDetection[];
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  sources: FireSourceStatus[];
  scope: string;
}

/** Regional bounding box used to scope detections to the Indonesia region. */
export const FIRE_BOUNDS = Object.freeze({
  west: 94,
  east: 142,
  south: -12,
  north: 7,
});

/**
 * Honest description of the spatial scope. The bounding box is regional: it
 * also covers parts of neighbouring countries and offshore waters, so the
 * numbers are never presented as an Indonesia-only statistic.
 */
export const FIRE_SCOPE =
  "Indonesia region (approximate bounding box 94E-142E, 12S-7N) derived from NASA FIRMS VIIRS " +
  "active fire data. The box is regional: it also covers parts of neighbouring countries " +
  "(Malaysia, Singapore, Brunei, Timor-Leste, the southern Philippines, Papua New Guinea) and " +
  "offshore waters, so counts are regional rather than country-level.";

export type FireWindow = "24h" | "48h" | "7d";

export interface FireFeed {
  /** Human readable feed name surfaced in `sources[].name`. */
  name: string;
  /** Canonical instrument label used for `detections[].satellite`. */
  satellite: string;
  /** Allowlisted upstream URL. */
  url: string;
}

const FIRMS_ACTIVE_FIRE_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";

function feedUrls(window: FireWindow): readonly FireFeed[] {
  return [
    {
      name: `Suomi NPP (VIIRS C2, ${window})`,
      satellite: "Suomi NPP",
      url: `${FIRMS_ACTIVE_FIRE_BASE}/viirs/csv/SUOMI_VIIRS_C2_SouthEast_Asia_${window}.csv`,
    },
    {
      name: `NOAA-20 (VIIRS C2, ${window})`,
      satellite: "NOAA-20",
      url: `${FIRMS_ACTIVE_FIRE_BASE}/noaa20/csv/J1_VIIRS_C2_SouthEast_Asia_${window}.csv`,
    },
  ];
}

/** Allowlisted upstream feeds per time window. */
export const FIRE_FEEDS: Record<FireWindow, readonly FireFeed[]> = Object.freeze({
  "24h": Object.freeze(feedUrls("24h")),
  "48h": Object.freeze(feedUrls("48h")),
  "7d": Object.freeze(feedUrls("7d")),
});

/** Supported values of the `days` query parameter. */
export const ALLOWED_FIRE_DAYS = [1, 2, 7] as const;
export type FireDays = (typeof ALLOWED_FIRE_DAYS)[number];

const WINDOW_BY_DAYS: Record<FireDays, FireWindow> = { 1: "24h", 2: "48h", 7: "7d" };

/**
 * Validates the `days` parameter. Returns `null` for anything that is not one
 * of the allowlisted windows so callers can reject the request instead of
 * letting it fan out to arbitrary upstream work.
 */
export function parseFireDays(raw: string | null | undefined): FireDays | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return (ALLOWED_FIRE_DAYS as readonly number[]).includes(value) ? (value as FireDays) : null;
}

export function fireWindowForDays(days: FireDays): FireWindow {
  return WINDOW_BY_DAYS[days];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_FUTURE_TOLERANCE_MS = 6 * 60 * 60 * 1000;
export const SUCCESS_CACHE_TTL_MS = 5 * 60 * 1000;
export const PARTIAL_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 8;
const MAX_REPORTED_ERRORS = 10;

const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/* -------------------------------------------------------------------------- */
/* CSV parsing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Incremental RFC 4180 style CSV reader. Text is pushed in chunks and complete
 * rows are handed back, so a multi megabyte FIRMS export is never materialised
 * as an array of rows. Quoted fields, escaped quotes (`""`), CRLF/LF line
 * endings and chunk boundaries in the middle of a field are all handled.
 */
export class CsvStreamParser {
  private pending = "";
  private inQuotes = false;
  private field = "";
  private row: string[] = [];

  /** Feeds a chunk of text and returns every row that was completed by it. */
  write(chunk: string): string[][] {
    if (chunk === "") return [];
    const rows: string[][] = [];
    const text = this.pending + chunk;
    const len = text.length;
    let i = 0;

    while (i < len) {
      if (this.inQuotes) {
        const quote = text.indexOf('"', i);
        if (quote === -1) {
          this.field += text.slice(i);
          i = len;
          break;
        }
        this.field += text.slice(i, quote);
        if (text.charCodeAt(quote + 1) === 34 /* " */) {
          this.field += '"';
          i = quote + 2;
          continue;
        }
        this.inQuotes = false;
        i = quote + 1;
        continue;
      }

      let j = i;
      let code = 0;
      while (j < len) {
        code = text.charCodeAt(j);
        if (code === 44 /* , */ || code === 10 /* \n */ || code === 13 /* \r */ || code === 34 /* " */) break;
        j += 1;
      }
      if (j >= len) {
        this.field += text.slice(i);
        i = len;
        break;
      }
      if (code === 34) {
        // A quote only opens a quoted field when it starts the field; anywhere
        // else it is a literal character.
        if (j > i || this.field !== "") {
          this.field += text.slice(i, j);
          i = j + 1;
          continue;
        }
        this.inQuotes = true;
        i = j + 1;
        continue;
      }

      this.field += text.slice(i, j);
      if (code === 44) {
        this.row.push(this.field);
        this.field = "";
        i = j + 1;
        continue;
      }

      this.row.push(this.field);
      this.field = "";
      rows.push(this.row);
      this.row = [];
      i = j + 1;
      if (code === 13 && text.charCodeAt(i) === 10) i += 1;
    }

    this.pending = i < len ? text.slice(i) : "";
    return rows;
  }

  /** Flushes the trailing row (if the file did not end with a newline). */
  end(): string[][] {
    const rows: string[][] = [];
    if (this.field !== "" || this.row.length > 0) {
      this.row.push(this.field);
      rows.push(this.row);
      this.row = [];
      this.field = "";
    }
    this.pending = "";
    return rows;
  }
}

interface FiresHeaderIndex {
  latitude: number;
  longitude: number;
  acqDate: number;
  acqTime: number;
  satellite: number;
  confidence: number;
  brightness: number;
  frp: number;
  daynight: number;
}

const REQUIRED_HEADERS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence"] as const;

function normalizeHeaderName(name: string): string {
  return name.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function findColumn(header: string[], names: readonly string[]): number {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index !== -1) return index;
  }
  return -1;
}

/**
 * Maps a FIRMS header row onto column indexes. Returns an error when one of
 * the required columns is missing.
 */
export function indexFiresHeader(
  header: string[],
): FiresHeaderIndex | { error: string } {
  const names = header.map(normalizeHeaderName);
  const missing: string[] = [];
  const indexes: Record<string, number> = {};

  for (const required of REQUIRED_HEADERS) {
    const index = names.indexOf(required);
    if (index === -1) missing.push(required);
    else indexes[required] = index;
  }
  if (missing.length > 0) {
    return { error: `FIRMS CSV is missing required column(s): ${missing.join(", ")}` };
  }

  const brightness = findColumn(names, ["bright_ti4", "brightness", "bti4"]);
  const frp = findColumn(names, ["frp"]);
  const daynight = findColumn(names, ["daynight"]);

  return {
    latitude: indexes.latitude,
    longitude: indexes.longitude,
    acqDate: indexes.acq_date,
    acqTime: indexes.acq_time,
    satellite: indexes.satellite,
    confidence: indexes.confidence,
    brightness,
    frp,
    daynight,
  };
}

/* -------------------------------------------------------------------------- */
/* Value normalisation                                                          */
/* -------------------------------------------------------------------------- */

/** Strict numeric parse: rejects empty strings, `NaN`, `Infinity` and hex. */
export function parseFiniteNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || !NUMERIC_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalises the FIRMS confidence column. FIRMS publishes either the short
 * codes (`n`, `h`, `l`) or the spelled out values (`nominal`, `high`, `low`).
 * Unknown or missing values fall back to `nominal`, which is the FIRMS
 * default confidence level.
 */
export function normalizeConfidence(value: string | undefined | null): FireConfidence {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "l" || raw === "low") return "low";
  if (raw === "h" || raw === "high") return "high";
  if (raw === "n" || raw === "nominal" || raw === "normal" || raw === "medium") return "nominal";
  return "nominal";
}

/**
 * Resolves the instrument for a detection. The raw FIRMS `satellite` column
 * only carries a short token (`N` for Suomi NPP, `N20` for NOAA-20), so the
 * token is mapped onto the canonical platform name. Distinct instruments are
 * never merged into one another.
 */
export function resolveSatellite(raw: string | undefined | null, fallback: string): string {
  const token = (raw ?? "").trim().toUpperCase();
  if (token === "N" || token === "NPP" || token === "S-NPP" || token === "SUOMI" || token === "SUOMI NPP") {
    return "Suomi NPP";
  }
  if (token === "N20" || token === "J1" || token === "NOAA20" || token === "NOAA-20" || token === "JPSS-20") {
    return "NOAA-20";
  }
  return fallback;
}

export interface AcquisitionParts {
  /** ISO-8601 UTC timestamp, e.g. `2026-10-18T06:22:00.000Z`. */
  iso: string;
  epochMs: number;
}

/**
 * Builds the UTC acquisition timestamp from the FIRMS `acq_date` (`YYYY-MM-DD`)
 * and `acq_time` (`HHMM`) columns. Returns `null` for anything that is not a
 * real calendar date / clock time (e.g. `2026-02-30` or `2460`).
 */
export function parseAcquisition(
  acqDate: string | undefined | null,
  acqTime: string | undefined | null,
): AcquisitionParts | null {
  const dateRaw = (acqDate ?? "").trim();
  const timeRaw = (acqTime ?? "").trim();

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateRaw);
  if (!dateMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const timeMatch = /^(\d{2})(\d{2})(?:\.\d+)?$/.exec(timeRaw);
  if (!timeMatch) return null;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours > 23 || minutes > 59) return null;

  const epochMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const date = new Date(epochMs);
  // Reject impossible calendar dates such as 2026-02-30 that Date.UTC rolls over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { iso: date.toISOString(), epochMs };
}

/** Convenience wrapper around {@link parseAcquisition} returning only the ISO string. */
export function toAcquiredAt(acqDate: string, acqTime: string): string | null {
  return parseAcquisition(acqDate, acqTime)?.iso ?? null;
}

/* -------------------------------------------------------------------------- */
/* Identifiers and deduplication                                                */
/* -------------------------------------------------------------------------- */

function fnv1aUpdate(hash: number, text: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnv1a(value: string, seed: number): number {
  return fnv1aUpdate(seed >>> 0, value);
}

function encodeHash(a: number, b: number): string {
  return `${a.toString(36).padStart(7, "0")}${b.toString(36).padStart(7, "0")}`;
}

/**
 * Stable, compact identifier derived from the deduplication key. Two 32 bit
 * FNV-1a passes with different seeds give 64 bits of entropy, which keeps
 * collisions negligible for the number of records a single response holds.
 */
export function detectionId(key: string): string {
  return encodeHash(fnv1a(key, 0x811c9dc5), fnv1a(key, 0x9e3779b9));
}

/**
 * Same identifier as {@link detectionId}, computed from the individual
 * fields. Hashing the parts directly avoids building (and garbage collecting)
 * one long key string per detection, which matters for the 7 day window.
 */
export function detectionIdFromParts(
  satellite: string,
  acquiredAt: string,
  latitude: number,
  longitude: number,
): string {
  let a = 0x811c9dc5 >>> 0;
  let b = 0x9e3779b9 >>> 0;
  a = fnv1aUpdate(a, satellite);
  b = fnv1aUpdate(b, satellite);
  a = fnv1aUpdate(a, "|");
  b = fnv1aUpdate(b, "|");
  a = fnv1aUpdate(a, acquiredAt);
  b = fnv1aUpdate(b, acquiredAt);
  a = fnv1aUpdate(a, "|");
  b = fnv1aUpdate(b, "|");
  const lat = latitude.toFixed(5);
  const lon = longitude.toFixed(5);
  a = fnv1aUpdate(a, lat);
  b = fnv1aUpdate(b, lat);
  a = fnv1aUpdate(a, "|");
  b = fnv1aUpdate(b, "|");
  a = fnv1aUpdate(a, lon);
  b = fnv1aUpdate(b, lon);
  return encodeHash(a, b);
}

/** Deduplication key: instrument + acquisition time + rounded position. */
export function detectionKey(detection: {
  satellite: string;
  acquiredAt: string;
  latitude: number;
  longitude: number;
}): string {
  return `${detection.satellite}|${detection.acquiredAt}|${detection.latitude.toFixed(5)}|${detection.longitude.toFixed(5)}`;
}

function compareForDedupe(a: FireDetection, b: FireDetection): number {
  if (a.satellite !== b.satellite) return a.satellite < b.satellite ? -1 : 1;
  if (a.acquiredAt !== b.acquiredAt) return a.acquiredAt < b.acquiredAt ? -1 : 1;
  if (a.latitude !== b.latitude) return a.latitude - b.latitude;
  return a.longitude - b.longitude;
}

function isSameDetection(a: FireDetection, b: FireDetection): boolean {
  return (
    a.satellite === b.satellite &&
    a.acquiredAt === b.acquiredAt &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude
  );
}

/**
 * Removes duplicate records. Two records are duplicates when instrument,
 * acquisition timestamp and position match; records from different
 * instruments are never merged.
 *
 * The array is sorted and compacted in place to keep the memory footprint low
 * for the 7 day window (100k+ records).
 */
export function dedupeDetections(detections: FireDetection[]): FireDetection[] {
  if (detections.length < 2) return detections;
  detections.sort(compareForDedupe);
  let write = 0;
  for (let read = 0; read < detections.length; read += 1) {
    const current = detections[read];
    if (write > 0 && isSameDetection(detections[write - 1], current)) continue;
    detections[write] = current;
    write += 1;
  }
  detections.length = write;
  return detections;
}

/** Sorts detections newest first, keeping the latest timestamps on top. */
export function sortByRecency(detections: FireDetection[]): FireDetection[] {
  return detections.sort((a, b) => {
    if (a.acquiredAt === b.acquiredAt) {
      if (a.latitude !== b.latitude) return a.latitude - b.latitude;
      return a.longitude - b.longitude;
    }
    return a.acquiredAt < b.acquiredAt ? 1 : -1;
  });
}

/* -------------------------------------------------------------------------- */
/* Row parsing                                                                  */
/* -------------------------------------------------------------------------- */

export interface ParseFiresOptions {
  /** Feed the rows belong to; used for the fallback instrument name. */
  feed: FireFeed;
  /** Reference timestamp (epoch ms) used to resolve the acquisition window. */
  now: number;
  /** Length of the acquisition window in milliseconds. */
  windowMs: number;
  /** How far into the future an acquisition may be before it is rejected. */
  futureToleranceMs?: number;
}

export interface ParseFiresSummary {
  detections: FireDetection[];
  /** Data rows seen (excluding the header). */
  totalRows: number;
  /** Rows turned into detections. */
  acceptedRows: number;
  /** Rows dropped because they fall outside the regional bounding box. */
  filteredRows: number;
  /** Rows dropped because they fall outside the requested time window. */
  outOfWindowRows: number;
  /** Rows dropped because a value was missing or invalid. */
  invalidRows: number;
  /** Set when the CSV header was not usable. */
  headerError: string | null;
  /** A short, de-duplicated list of rejection reasons. */
  errors: string[];
}

type RowOutcome =
  | { kind: "detection"; detection: FireDetection }
  | { kind: "filtered" }
  | { kind: "out-of-window" }
  | { kind: "invalid"; error: string };

/**
 * Stateful parser for a single FIRMS feed. Rows are pushed in one by one so
 * the whole CSV never has to be held in memory.
 */
export class FiresCsvParser {
  private readonly options: ParseFiresOptions;
  private readonly windowStart: number;
  private readonly windowEnd: number;
  private index: FiresHeaderIndex | null = null;
  private headerError: string | null = null;
  private readonly acquiredAtCache = new Map<string, string>();
  readonly summary: ParseFiresSummary;

  constructor(options: ParseFiresOptions) {
    this.options = options;
    this.windowStart = options.now - options.windowMs;
    this.windowEnd = options.now + (options.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS);
    this.summary = {
      detections: [],
      totalRows: 0,
      acceptedRows: 0,
      filteredRows: 0,
      outOfWindowRows: 0,
      invalidRows: 0,
      headerError: null,
      errors: [],
    };
  }

  /** Parses one CSV row. The first row is always treated as the header. */
  processRow(row: string[]): void {
    if (this.headerError) return;
    if (this.index === null) {
      const indexed = indexFiresHeader(row);
      if ("error" in indexed) {
        this.headerError = indexed.error;
        this.summary.headerError = indexed.error;
        this.addError(indexed.error);
        return;
      }
      this.index = indexed;
      return;
    }

    this.summary.totalRows += 1;
    if (row.length === 1 && row[0].trim() === "") return; // blank line

    const outcome = this.buildDetection(row);
    if (outcome.kind === "detection") {
      this.summary.detections.push(outcome.detection);
      this.summary.acceptedRows += 1;
      return;
    }
    if (outcome.kind === "filtered") {
      this.summary.filteredRows += 1;
      return;
    }
    if (outcome.kind === "out-of-window") {
      this.summary.outOfWindowRows += 1;
      return;
    }
    this.summary.invalidRows += 1;
    this.addError(outcome.error);
  }

  /** Returns the collected summary. */
  finish(): ParseFiresSummary {
    if (this.index === null && this.headerError === null) {
      this.headerError = "FIRMS CSV is empty or has no header row";
      this.summary.headerError = this.headerError;
      this.addError(this.headerError);
    }
    return this.summary;
  }

  private addError(message: string): void {
    if (this.summary.errors.length >= MAX_REPORTED_ERRORS) return;
    if (this.summary.errors.includes(message)) return;
    this.summary.errors.push(message);
  }

  private buildDetection(row: string[]): RowOutcome {
    const index = this.index as FiresHeaderIndex;
    const required = Math.max(
      index.latitude,
      index.longitude,
      index.acqDate,
      index.acqTime,
      index.satellite,
      index.confidence,
    );
    if (row.length <= required) {
      return { kind: "invalid", error: `Row has ${row.length} columns, expected at least ${required + 1}` };
    }

    const latitude = parseFiniteNumber(row[index.latitude]);
    if (latitude === null) return { kind: "invalid", error: "Invalid latitude value" };
    const longitude = parseFiniteNumber(row[index.longitude]);
    if (longitude === null) return { kind: "invalid", error: "Invalid longitude value" };
    if (latitude < -90 || latitude > 90) return { kind: "invalid", error: "Latitude out of range" };
    if (longitude < -180 || longitude > 180) return { kind: "invalid", error: "Longitude out of range" };

    const acquisition = parseAcquisition(row[index.acqDate], row[index.acqTime]);
    if (!acquisition) return { kind: "invalid", error: "Invalid acquisition date or time" };

    if (
      latitude < FIRE_BOUNDS.south ||
      latitude > FIRE_BOUNDS.north ||
      longitude < FIRE_BOUNDS.west ||
      longitude > FIRE_BOUNDS.east
    ) {
      return { kind: "filtered" };
    }

    if (acquisition.epochMs < this.windowStart || acquisition.epochMs > this.windowEnd) {
      return { kind: "out-of-window" };
    }

    const satellite = resolveSatellite(row[index.satellite], this.options.feed.satellite);
    const confidence = normalizeConfidence(row[index.confidence]);
    const brightness = index.brightness === -1 ? null : parseFiniteNumber(row[index.brightness]);
    const frp = index.frp === -1 ? null : parseFiniteNumber(row[index.frp]);
    const daynightRaw = index.daynight === -1 ? "" : (row[index.daynight] ?? "").trim();
    const daynight = daynightRaw === "" ? "unknown" : daynightRaw.toUpperCase();

    // Interning keeps a single copy of the (heavily repeated) timestamps.
    let acquiredAt = this.acquiredAtCache.get(acquisition.iso);
    if (acquiredAt === undefined) {
      acquiredAt = acquisition.iso;
      this.acquiredAtCache.set(acquisition.iso, acquiredAt);
    }

    const detection: FireDetection = {
      id: "",
      latitude,
      longitude,
      brightness,
      frp,
      confidence,
      acquiredAt,
      satellite,
      daynight,
    };
    detection.id = detectionIdFromParts(satellite, acquiredAt, latitude, longitude);
    return { kind: "detection", detection };
  }
}

/** Parses a complete FIRMS CSV document (convenience wrapper around the streaming parser). */
export function parseFiresCsv(csv: string, options: ParseFiresOptions): ParseFiresSummary {
  const parser = new FiresCsvParser(options);
  const stream = new CsvStreamParser();
  for (const row of stream.write(csv)) parser.processRow(row);
  for (const row of stream.end()) parser.processRow(row);
  return parser.finish();
}

/* -------------------------------------------------------------------------- */
/* Upstream collection                                                          */
/* -------------------------------------------------------------------------- */

export interface FiresRequestOptions {
  /** Injectable fetch implementation (used by the tests). */
  fetchImpl?: typeof fetch;
  /** Reference timestamp in epoch ms. */
  now?: number;
  /** Optional external abort signal. */
  signal?: AbortSignal;
  /** Per request timeout in milliseconds. */
  timeoutMs?: number;
  /** Set to `false` to bypass the in-memory cache. */
  useCache?: boolean;
}

export interface CollectFiresResult {
  detections: FireDetection[];
  sources: FireSourceStatus[];
  /** Timestamp of the most recent successful retrieval (ISO-8601). */
  fetchedAt: string | null;
  /** Latest `Last-Modified` reported by the upstream feeds (ISO-8601). */
  sourceUpdatedAt: string | null;
  /** True when at least one feed was retrieved successfully. */
  ok: boolean;
  /** True when some, but not all, feeds failed. */
  partial: boolean;
}

interface FeedResult {
  ok: boolean;
  detections: FireDetection[];
  source: FireSourceStatus;
  fetchedAtMs: number | null;
  lastModifiedMs: number | null;
}

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return `Timed out after ${Math.round(timeoutMs / 1000)}s`;
    if (error.name === "AbortError") return "Request was aborted";
    return error.message || error.name;
  }
  return "Unknown error";
}

async function collectFeed(
  feed: FireFeed,
  options: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    now: number;
    windowMs: number;
    signal?: AbortSignal;
  },
): Promise<FeedResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;

  try {
    const response = await options.fetchImpl(feed.url, {
      signal,
      headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8" },
    });
    if (!response.ok) {
      throw new Error(`Upstream responded with HTTP ${response.status}`);
    }

    const parser = new FiresCsvParser({
      feed,
      now: options.now,
      windowMs: options.windowMs,
    });
    const stream = new CsvStreamParser();
    const body = response.body;

    if (body) {
      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8");
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const text = decoder.decode(value, { stream: true });
          for (const row of stream.write(text)) parser.processRow(row);
        }
        const tail = decoder.decode();
        if (tail !== "") {
          for (const row of stream.write(tail)) parser.processRow(row);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* the stream is already finished */
        }
      }
    } else {
      const text = await response.text();
      for (const row of stream.write(text)) parser.processRow(row);
    }

    for (const row of stream.end()) parser.processRow(row);

    const summary = parser.finish();
    if (summary.headerError) {
      throw new Error(summary.headerError);
    }

    const lastModifiedHeader = response.headers.get("last-modified");
    const lastModifiedMs = lastModifiedHeader ? Date.parse(lastModifiedHeader) : Number.NaN;

    return {
      ok: true,
      detections: summary.detections,
      source: { name: feed.name, url: feed.url, ok: true },
      fetchedAtMs: Date.now(),
      lastModifiedMs: Number.isFinite(lastModifiedMs) ? lastModifiedMs : null,
    };
  } catch (error) {
    return {
      ok: false,
      detections: [],
      source: { name: feed.name, url: feed.url, ok: false, error: describeError(error, options.timeoutMs) },
      fetchedAtMs: null,
      lastModifiedMs: null,
    };
  }
}

/**
 * Fetches every allowlisted feed for the given window in parallel, scopes the
 * records to the regional bounding box and the requested time window, and
 * merges them. Partial upstream failures are reported through `sources`.
 */
export async function collectFires(
  days: FireDays,
  options: FiresRequestOptions = {},
): Promise<CollectFiresResult> {
  const window = fireWindowForDays(days);
  const feeds = FIRE_FEEDS[window];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const windowMs = days * DAY_MS;

  const results = await Promise.all(
    feeds.map((feed) =>
      collectFeed(feed, { fetchImpl, timeoutMs, now, windowMs, signal: options.signal }),
    ),
  );

  const detections: FireDetection[] = [];
  const sources: FireSourceStatus[] = [];
  let okCount = 0;
  let latestFetchMs = 0;
  let latestModifiedMs: number | null = null;

  for (const result of results) {
    sources.push(result.source);
    if (result.ok) {
      okCount += 1;
      for (const detection of result.detections) detections.push(detection);
    }
    if (result.fetchedAtMs !== null) {
      latestFetchMs = Math.max(latestFetchMs, result.fetchedAtMs);
    }
    if (result.lastModifiedMs !== null) {
      latestModifiedMs =
        latestModifiedMs === null
          ? result.lastModifiedMs
          : Math.max(latestModifiedMs, result.lastModifiedMs);
    }
  }

  const deduped = sortByRecency(dedupeDetections(detections));

  return {
    detections: deduped,
    sources,
    fetchedAt: latestFetchMs > 0 ? new Date(latestFetchMs).toISOString() : null,
    sourceUpdatedAt: latestModifiedMs === null ? null : new Date(latestModifiedMs).toISOString(),
    ok: okCount > 0,
    partial: okCount > 0 && okCount < feeds.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Cached API payload                                                           */
/* -------------------------------------------------------------------------- */

interface CachedFiresPayload {
  body: string;
  expiresAt: number;
  partial: boolean;
}

const responseCache = new Map<FireDays, CachedFiresPayload>();

/** Removes every cached payload (used by the tests). */
export function clearFiresCache(): void {
  responseCache.clear();
}

function readCache(days: FireDays, now: number): CachedFiresPayload | null {
  const entry = responseCache.get(days);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    responseCache.delete(days);
    return null;
  }
  return entry;
}

function writeCache(days: FireDays, entry: CachedFiresPayload): void {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of responseCache) {
      if (value.expiresAt <= now) responseCache.delete(key);
    }
    while (responseCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = responseCache.keys().next();
      if (oldest.done) break;
      responseCache.delete(oldest.value);
    }
  }
  responseCache.set(days, entry);
}

/** `Cache-Control` value for a successful (or partially successful) response. */
export function cacheControlFor(partial: boolean): string {
  return partial ? "public, max-age=30, s-maxage=60" : "public, max-age=60, s-maxage=300";
}

export interface FiresApiResult {
  status: number;
  body: string;
  partial: boolean;
  cacheStatus: "hit" | "miss";
  cacheControl: string;
}

/**
 * Builds the JSON payload for `/api/fires`. Successful responses are cached
 * for five minutes; partially successful responses are cached for a shorter
 * period; total failures are never cached.
 */
export async function getFiresPayload(
  days: FireDays,
  options: FiresRequestOptions = {},
): Promise<FiresApiResult> {
  const useCache = options.useCache !== false;
  const now = options.now ?? Date.now();

  if (useCache) {
    const cached = readCache(days, now);
    if (cached) {
      return {
        status: 200,
        body: cached.body,
        partial: cached.partial,
        cacheStatus: "hit",
        cacheControl: cacheControlFor(cached.partial),
      };
    }
  }

  const result = await collectFires(days, { ...options, now });

  if (!result.ok) {
    const detail = result.sources
      .map((source) => `${source.name}: ${source.error ?? "failed"}`)
      .join("; ");
    return {
      status: 502,
      body: JSON.stringify({
        error: `All upstream NASA FIRMS feeds failed, no fire data available. ${detail}`.trim(),
      }),
      partial: false,
      cacheStatus: "miss",
      cacheControl: "no-store",
    };
  }

  const payload: FiresResponse = {
    detections: result.detections,
    fetchedAt: result.fetchedAt ?? new Date(now).toISOString(),
    sourceUpdatedAt: result.sourceUpdatedAt,
    sources: result.sources,
    scope: FIRE_SCOPE,
  };

  const body = JSON.stringify(payload);

  if (useCache) {
    writeCache(days, {
      body,
      expiresAt: now + (result.partial ? PARTIAL_CACHE_TTL_MS : SUCCESS_CACHE_TTL_MS),
      partial: result.partial,
    });
  }

  return {
    status: 200,
    body,
    partial: result.partial,
    cacheStatus: "miss",
    cacheControl: cacheControlFor(result.partial),
  };
}
