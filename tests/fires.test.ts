import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error -- Node's ESM resolver requires the explicit .ts extension when the suite runs with --experimental-strip-types.
import * as fires from "../lib/fires.ts";

const {
  ALLOWED_FIRE_DAYS,
  clearFiresCache,
  collectFires,
  CsvStreamParser,
  dedupeDetections,
  detectionId,
  detectionKey,
  FIRE_BOUNDS,
  FIRE_FEEDS,
  getFiresPayload,
  normalizeConfidence,
  parseAcquisition,
  parseFiresCsv,
  parseFireDays,
  parseFiniteNumber,
  resolveSatellite,
  sortByRecency,
  toAcquiredAt,
} = fires;

/** Detection shape consumed by the dashboard frontend. */
interface FireDetection {
  id: string;
  latitude: number;
  longitude: number;
  brightness: number | null;
  frp: number | null;
  confidence: "low" | "nominal" | "high";
  acquiredAt: string;
  satellite: string;
  daynight: string;
}

/** Response contract served by `GET /api/fires`. */
interface FiresResponse {
  detections: FireDetection[];
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  sources: { name: string; url: string; ok: boolean; error?: string }[];
  scope: string;
}

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const SUOMI_FEED = FIRE_FEEDS["24h"][0];
const NOAA_FEED = FIRE_FEEDS["24h"][1];
const SUOMI_URL = SUOMI_FEED.url;
const NOAA_URL = NOAA_FEED.url;

const HEADER =
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";

interface RowOptions {
  lat?: string;
  lon?: string;
  bright?: string;
  date?: string;
  time?: string;
  satellite?: string;
  confidence?: string;
  frp?: string;
  daynight?: string;
}

function row(options: RowOptions = {}): string {
  return [
    options.lat ?? "-2.63103",
    options.lon ?? "111.12868",
    options.bright ?? "342.06",
    "0.42",
    "0.38",
    options.date ?? "2026-10-19",
    options.time ?? "0622",
    options.satellite ?? "N",
    options.confidence ?? "n",
    "2.0NRT",
    "302.87",
    options.frp ?? "7.93",
    options.daynight ?? "D",
  ].join(",");
}

function parse(csv: string, options: { feed?: typeof SUOMI_FEED; windowMs?: number } = {}) {
  return parseFiresCsv(csv, {
    feed: options.feed ?? SUOMI_FEED,
    now: NOW,
    windowMs: options.windowMs ?? DAY_MS,
  });
}

function csvResponse(body: string, lastModified?: string, status = 200): Response {
  const headers: Record<string, string> = { "Content-Type": "text/csv" };
  if (lastModified) headers["Last-Modified"] = lastModified;
  return new Response(body, { status, headers });
}

function fakeFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
  counter?: { calls: number },
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (counter) counter.calls += 1;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const handler = handlers[url];
    if (!handler) throw new Error(`Unexpected upstream URL: ${url}`);
    return handler();
  }) as unknown as typeof fetch;
}

describe("CSV stream parser", () => {
  it("reads rows, quoted fields and escaped quotes", () => {
    const parser = new CsvStreamParser();
    const rows: string[][] = [];
    rows.push(
      ...parser.write('a,b,c\n"quoted, value","say ""hi""",plain\n'),
    );
    rows.push(...parser.end());

    assert.deepEqual(rows, [
      ["a", "b", "c"],
      ["quoted, value", 'say "hi"', "plain"],
    ]);
  });

  it("handles CRLF endings and a missing trailing newline", () => {
    const parser = new CsvStreamParser();
    const rows: string[][] = [];
    rows.push(...parser.write("a,b\r\n1,2\r\n3,4"));
    rows.push(...parser.end());

    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("reassembles rows that are split across chunk boundaries", () => {
    const parser = new CsvStreamParser();
    const rows: string[][] = [];
    for (const chunk of ["lat,lon\n1,", "2\n3,4\n"]) {
      rows.push(...parser.write(chunk));
    }
    rows.push(...parser.end());

    assert.deepEqual(rows, [
      ["lat", "lon"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps a quoted field that spans a chunk boundary", () => {
    const parser = new CsvStreamParser();
    const rows: string[][] = [];
    rows.push(...parser.write('a,"b'));
    rows.push(...parser.write('c",d\n'));
    rows.push(...parser.end());

    assert.deepEqual(rows, [["a", "bc", "d"]]);
  });
});

describe("FIRMS CSV parsing", () => {
  it("maps a FIRMS row onto the detection contract", () => {
    const summary = parse([HEADER, row()].join("\n"));

    assert.equal(summary.headerError, null);
    assert.equal(summary.totalRows, 1);
    assert.equal(summary.acceptedRows, 1);
    assert.equal(summary.detections.length, 1);

    const detection = summary.detections[0];
    assert.equal(detection.latitude, -2.63103);
    assert.equal(detection.longitude, 111.12868);
    assert.equal(detection.brightness, 342.06);
    assert.equal(detection.frp, 7.93);
    assert.equal(detection.confidence, "nominal");
    assert.equal(detection.acquiredAt, "2026-10-19T06:22:00.000Z");
    assert.equal(detection.satellite, "Suomi NPP");
    assert.equal(detection.daynight, "D");
    assert.equal(typeof detection.id, "string");
    assert.ok(detection.id.length > 0);
  });

  it("strips a byte order mark from the header", () => {
    const summary = parse(`\uFEFF${HEADER}\n${row()}\n`);

    assert.equal(summary.headerError, null);
    assert.equal(summary.acceptedRows, 1);
  });

  it("rejects a CSV that is missing required headers", () => {
    const summary = parse("latitude,longitude,acq_date\n-2.6,111.1,2026-10-19\n");

    assert.ok(summary.headerError);
    assert.match(summary.headerError as string, /missing required column/i);
    assert.equal(summary.detections.length, 0);
  });

  it("rejects an empty CSV", () => {
    const summary = parse("");

    assert.ok(summary.headerError);
    assert.match(summary.headerError as string, /empty/i);
    assert.equal(summary.detections.length, 0);
  });

  it("rejects rows with a non numeric latitude or longitude", () => {
    const summary = parse(
      [HEADER, row({ lat: "abc" }), row({ lon: "" }), row({ lat: "NaN" })].join("\n"),
    );

    assert.equal(summary.acceptedRows, 0);
    assert.equal(summary.invalidRows, 3);
    assert.ok(summary.errors.some((error) => /latitude/i.test(error)));
  });

  it("rejects coordinates outside the valid globe range", () => {
    const summary = parse([HEADER, row({ lat: "95.5" }), row({ lon: "200" })].join("\n"));

    assert.equal(summary.acceptedRows, 0);
    assert.equal(summary.invalidRows, 2);
  });

  it("drops rows outside the regional bounding box", () => {
    const summary = parse(
      [
        HEADER,
        row({ lat: "-2.63103", lon: "111.12868" }),
        row({ lat: "27.72149", lon: "96.27819" }),
        row({ lat: "-9.53491", lon: "160.41721" }),
        row({ lat: "-13.5", lon: "120" }),
        row({ lat: "8.5", lon: "120" }),
      ].join("\n"),
    );

    assert.equal(summary.acceptedRows, 1);
    assert.equal(summary.filteredRows, 4);
    const [detection] = summary.detections;
    assert.ok(detection.latitude >= FIRE_BOUNDS.south && detection.latitude <= FIRE_BOUNDS.north);
    assert.ok(detection.longitude >= FIRE_BOUNDS.west && detection.longitude <= FIRE_BOUNDS.east);
  });

  it("keeps only acquisitions inside the requested window", () => {
    const summary = parse(
      [
        HEADER,
        row({ date: "2026-10-19", time: "0622" }),
        row({ date: "2026-10-18", time: "0600" }),
        row({ date: "2026-10-16", time: "1200" }),
      ].join("\n"),
    );

    assert.equal(summary.acceptedRows, 1);
    assert.equal(summary.outOfWindowRows, 2);
    assert.equal(summary.detections[0].acquiredAt, "2026-10-19T06:22:00.000Z");
  });

  it("widens the window when a longer period is requested", () => {
    const csv = [HEADER, row({ date: "2026-10-16", time: "1200" })].join("\n");

    assert.equal(parse(csv, { windowMs: DAY_MS }).acceptedRows, 0);
    assert.equal(parse(csv, { windowMs: 7 * DAY_MS }).acceptedRows, 1);
  });

  it("rejects impossible dates and times", () => {
    const summary = parse(
      [
        HEADER,
        row({ date: "2026-02-30" }),
        row({ time: "2460" }),
        row({ date: "2026-13-01" }),
        row({ time: "12" }),
        row({ date: "19-10-2026" }),
      ].join("\n"),
    );

    assert.equal(summary.acceptedRows, 0);
    assert.equal(summary.invalidRows, 5);
    assert.ok(summary.errors.some((error) => /acquisition/i.test(error)));
  });

  it("normalises the confidence column", () => {
    const summary = parse(
      [
        HEADER,
        row({ confidence: "n" }),
        row({ confidence: "nominal" }),
        row({ confidence: "h" }),
        row({ confidence: "high" }),
        row({ confidence: "l" }),
        row({ confidence: "low" }),
      ].join("\n"),
    );

    assert.equal(summary.acceptedRows, 6);
    assert.deepEqual(
      summary.detections.map((detection) => detection.confidence),
      ["nominal", "nominal", "high", "high", "low", "low"],
    );
  });

  it("keeps distinct instruments apart and maps the FIRMS satellite token", () => {
    const summary = parse(
      [HEADER, row({ satellite: "N" }), row({ satellite: "N20" })].join("\n"),
      { feed: NOAA_FEED },
    );

    assert.equal(summary.acceptedRows, 2);
    assert.deepEqual(
      summary.detections.map((detection) => detection.satellite),
      ["Suomi NPP", "NOAA-20"],
    );
  });

  it("falls back to the feed instrument when the satellite token is missing", () => {
    const summary = parse([HEADER, row({ satellite: "" })].join("\n"), { feed: NOAA_FEED });

    assert.equal(summary.detections[0].satellite, "NOAA-20");
  });

  it("reports blank brightness and frp as null", () => {
    const summary = parse([HEADER, row({ bright: "", frp: "" })].join("\n"));

    assert.equal(summary.detections[0].brightness, null);
    assert.equal(summary.detections[0].frp, null);
  });
});

describe("value helpers", () => {
  it("validates the days parameter", () => {
    assert.equal(parseFireDays("1"), 1);
    assert.equal(parseFireDays("2"), 2);
    assert.equal(parseFireDays("7"), 7);
    assert.equal(parseFireDays(" 7 "), 7);
    assert.equal(parseFireDays("0"), null);
    assert.equal(parseFireDays("3"), null);
    assert.equal(parseFireDays("8"), null);
    assert.equal(parseFireDays("abc"), null);
    assert.equal(parseFireDays("1.5"), null);
    assert.equal(parseFireDays("1e3"), null);
    assert.equal(parseFireDays(""), null);
    assert.equal(parseFireDays(null), null);
    assert.deepEqual([...ALLOWED_FIRE_DAYS], [1, 2, 7]);
  });

  it("builds UTC acquisition timestamps", () => {
    assert.equal(toAcquiredAt("2026-10-19", "0622"), "2026-10-19T06:22:00.000Z");
    assert.equal(toAcquiredAt("2026-10-19", "2359"), "2026-10-19T23:59:00.000Z");
    assert.equal(toAcquiredAt("2026-10-19", "0000"), "2026-10-19T00:00:00.000Z");
    assert.equal(toAcquiredAt("2024-02-29", "1200"), "2024-02-29T12:00:00.000Z");
  });

  it("rejects impossible acquisition timestamps", () => {
    assert.equal(toAcquiredAt("2026-02-30", "1200"), null);
    assert.equal(toAcquiredAt("2025-02-29", "1200"), null);
    assert.equal(toAcquiredAt("2026-13-01", "1200"), null);
    assert.equal(toAcquiredAt("2026-10-19", "2400"), null);
    assert.equal(toAcquiredAt("2026-10-19", "1260"), null);
    assert.equal(toAcquiredAt("2026-10-19", "999"), null);
    assert.equal(toAcquiredAt("2026-10-19", ""), null);
    assert.equal(toAcquiredAt("", "1200"), null);
    assert.equal(toAcquiredAt("2026-10-19", "1200x"), null);
  });

  it("exposes the parsed acquisition parts", () => {
    const parts = parseAcquisition("2026-10-19", "0622");
    assert.ok(parts);
    assert.equal(parts.epochMs, Date.parse("2026-10-19T06:22:00.000Z"));
    assert.equal(parts.iso, "2026-10-19T06:22:00.000Z");
  });

  it("parses numbers strictly", () => {
    assert.equal(parseFiniteNumber("12.5"), 12.5);
    assert.equal(parseFiniteNumber(" -2.6 "), -2.6);
    assert.equal(parseFiniteNumber(""), null);
    assert.equal(parseFiniteNumber("abc"), null);
    assert.equal(parseFiniteNumber("NaN"), null);
    assert.equal(parseFiniteNumber("Infinity"), null);
    assert.equal(parseFiniteNumber("1,5"), null);
    assert.equal(parseFiniteNumber(undefined), null);
  });

  it("normalises confidence values", () => {
    assert.equal(normalizeConfidence("n"), "nominal");
    assert.equal(normalizeConfidence("nominal"), "nominal");
    assert.equal(normalizeConfidence("NOMINAL"), "nominal");
    assert.equal(normalizeConfidence("h"), "high");
    assert.equal(normalizeConfidence("high"), "high");
    assert.equal(normalizeConfidence("l"), "low");
    assert.equal(normalizeConfidence("low"), "low");
    assert.equal(normalizeConfidence(""), "nominal");
    assert.equal(normalizeConfidence(null), "nominal");
  });

  it("resolves the instrument from the FIRMS satellite token", () => {
    assert.equal(resolveSatellite("N", "fallback"), "Suomi NPP");
    assert.equal(resolveSatellite("npp", "fallback"), "Suomi NPP");
    assert.equal(resolveSatellite("N20", "fallback"), "NOAA-20");
    assert.equal(resolveSatellite("J1", "fallback"), "NOAA-20");
    assert.equal(resolveSatellite("", "fallback"), "fallback");
    assert.equal(resolveSatellite(undefined, "fallback"), "fallback");
  });
});

describe("deduplication", () => {
  function detection(overrides: Partial<FireDetection> = {}): FireDetection {
    return {
      id: "",
      latitude: -2.63103,
      longitude: 111.12868,
      brightness: 342.06,
      frp: 7.93,
      confidence: "nominal",
      acquiredAt: "2026-10-19T06:22:00.000Z",
      satellite: "Suomi NPP",
      daynight: "D",
      ...overrides,
    };
  }

  it("removes records with the same instrument, time and position", () => {
    const duplicates = [
      detection(),
      detection(),
      detection({ frp: 9.99 }),
    ];

    const deduped = dedupeDetections(duplicates);
    assert.equal(deduped.length, 1);
  });

  it("never merges records from different instruments", () => {
    const deduped = dedupeDetections([
      detection({ satellite: "Suomi NPP" }),
      detection({ satellite: "NOAA-20" }),
    ]);

    assert.equal(deduped.length, 2);
  });

  it("keeps records that differ in time or position", () => {
    const deduped = dedupeDetections([
      detection(),
      detection({ acquiredAt: "2026-10-19T07:54:00.000Z" }),
      detection({ latitude: -2.63624 }),
    ]);

    assert.equal(deduped.length, 3);
  });

  it("builds a stable key and identifier for a record", () => {
    const first = detection();
    const key = detectionKey(first);

    assert.equal(detectionKey(detection()), key);
    assert.notEqual(detectionKey(detection({ satellite: "NOAA-20" })), key);
    assert.equal(detectionId(key), detectionId(detectionKey(detection())));
    assert.notEqual(detectionId(key), detectionId(detectionKey(detection({ latitude: 1 }))));
  });

  it("derives the same identifier from the parsed fields as from the key", () => {
    const summary = parse([HEADER, row()].join("\n"));
    const [detection] = summary.detections;

    assert.equal(detection.id, detectionId(detectionKey(detection)));
  });

  it("sorts detections with the latest acquisition first", () => {
    const sorted = sortByRecency([
      detection({ acquiredAt: "2026-10-18T06:22:00.000Z" }),
      detection({ acquiredAt: "2026-10-19T07:54:00.000Z" }),
      detection({ acquiredAt: "2026-10-19T06:22:00.000Z" }),
    ]);

    assert.deepEqual(
      sorted.map((detection) => detection.acquiredAt),
      [
        "2026-10-19T07:54:00.000Z",
        "2026-10-19T06:22:00.000Z",
        "2026-10-18T06:22:00.000Z",
      ],
    );
  });

  it("deduplicates rows coming from the CSV itself", () => {
    const summary = parse([HEADER, row(), row(), row({ date: "2026-10-19", time: "0754" })].join("\n"));

    assert.equal(summary.acceptedRows, 3);
    const deduped = dedupeDetections(summary.detections);
    assert.equal(deduped.length, 2);
  });
});

describe("upstream collection", () => {
  const goodCsv = [HEADER, row()].join("\n");

  it("collects detections from every allowlisted feed", async () => {
    const counter = { calls: 0 };
    const fetchImpl = fakeFetch(
      {
        [SUOMI_URL]: () => csvResponse(goodCsv),
        [NOAA_URL]: () => csvResponse([HEADER, row({ satellite: "N20" })].join("\n")),
      },
      counter,
    );

    const result = await collectFires(1, { fetchImpl, now: NOW });

    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(counter.calls, 2);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources.every((source) => source.ok), true);
    assert.equal(result.detections.length, 2);
    assert.deepEqual(
      result.detections.map((detection) => detection.satellite).sort(),
      ["NOAA-20", "Suomi NPP"],
    );
    assert.ok(result.fetchedAt);
    assert.equal(result.sourceUpdatedAt, null);
  });

  it("surfaces a partial upstream failure", async () => {
    const fetchImpl = fakeFetch({
      [SUOMI_URL]: () => csvResponse(goodCsv),
      [NOAA_URL]: () => {
        throw new Error("network down");
      },
    });

    const result = await collectFires(1, { fetchImpl, now: NOW });

    assert.equal(result.ok, true);
    assert.equal(result.partial, true);
    assert.equal(result.detections.length, 1);
    const failed = result.sources.find((source) => !source.ok);
    assert.ok(failed);
    assert.equal(failed.error, "network down");
  });

  it("reports a total upstream failure without inventing data", async () => {
    const fetchImpl = fakeFetch({
      [SUOMI_URL]: () => {
        throw new Error("boom");
      },
      [NOAA_URL]: () => new Response("nope", { status: 503 }),
    });

    const result = await collectFires(1, { fetchImpl, now: NOW });

    assert.equal(result.ok, false);
    assert.equal(result.partial, false);
    assert.equal(result.detections.length, 0);
    assert.equal(result.fetchedAt, null);
    assert.equal(result.sources.filter((source) => source.ok).length, 0);
    assert.ok(result.sources.every((source) => typeof source.error === "string"));
  });

  it("uses the latest Last-Modified header as the source update time", async () => {
    const fetchImpl = fakeFetch({
      [SUOMI_URL]: () => csvResponse(goodCsv, "Mon, 19 Oct 2026 15:49:54 GMT"),
      [NOAA_URL]: () => csvResponse(goodCsv, "Mon, 19 Oct 2026 15:42:45 GMT"),
    });

    const result = await collectFires(1, { fetchImpl, now: NOW });

    assert.equal(result.sourceUpdatedAt, "2026-10-19T15:49:54.000Z");
  });

  it("rejects a feed that does not return a usable CSV", async () => {
    const fetchImpl = fakeFetch({
      [SUOMI_URL]: () => csvResponse("not,a,fires,file\n1,2,3,4\n"),
      [NOAA_URL]: () => csvResponse(goodCsv),
    });

    const result = await collectFires(1, { fetchImpl, now: NOW });

    assert.equal(result.partial, true);
    assert.ok(result.sources[0].error);
  });
});

describe("api payload", () => {
  const goodCsv = [HEADER, row()].join("\n");

  it("returns the documented response contract", async () => {
    clearFiresCache();
    const fetchImpl = fakeFetch({
      [SUOMI_URL]: () => csvResponse(goodCsv, "Mon, 19 Oct 2026 15:49:54 GMT"),
      [NOAA_URL]: () => csvResponse(goodCsv, "Mon, 19 Oct 2026 15:42:45 GMT"),
    });

    const result = await getFiresPayload(1, { fetchImpl, now: NOW });
    assert.equal(result.status, 200);

    const payload = JSON.parse(result.body) as FiresResponse;
    assert.ok(Array.isArray(payload.detections));
    assert.equal(typeof payload.fetchedAt, "string");
    assert.equal(payload.sourceUpdatedAt, "2026-10-19T15:49:54.000Z");
    assert.equal(payload.sources.length, 2);
    assert.equal(typeof payload.scope, "string");
    assert.ok(payload.scope.length > 0);
    for (const detection of payload.detections) {
      assert.equal(typeof detection.id, "string");
      assert.equal(typeof detection.latitude, "number");
      assert.equal(typeof detection.longitude, "number");
      assert.ok(detection.brightness === null || typeof detection.brightness === "number");
      assert.ok(detection.frp === null || typeof detection.frp === "number");
      assert.ok(["low", "nominal", "high"].includes(detection.confidence));
      assert.equal(typeof detection.acquiredAt, "string");
      assert.equal(typeof detection.satellite, "string");
      assert.equal(typeof detection.daynight, "string");
    }
  });

  it("caches a successful response per window and reuses it", async () => {
    clearFiresCache();
    const counter = { calls: 0 };
    const fetchImpl = fakeFetch(
      {
        [SUOMI_URL]: () => csvResponse(goodCsv),
        [NOAA_URL]: () => csvResponse(goodCsv),
        [FIRE_FEEDS["48h"][0].url]: () => csvResponse(goodCsv),
        [FIRE_FEEDS["48h"][1].url]: () => csvResponse(goodCsv),
      },
      counter,
    );

    const first = await getFiresPayload(1, { fetchImpl, now: NOW });
    assert.equal(first.cacheStatus, "miss");
    assert.equal(counter.calls, 2);

    const second = await getFiresPayload(1, { fetchImpl, now: NOW });
    assert.equal(second.cacheStatus, "hit");
    assert.equal(second.body, first.body);
    assert.equal(counter.calls, 2);

    const otherWindow = await getFiresPayload(2, { fetchImpl, now: NOW });
    assert.equal(otherWindow.cacheStatus, "miss");
    assert.equal(counter.calls, 4);
  });

  it("does not cache a total upstream failure", async () => {
    clearFiresCache();
    const counter = { calls: 0 };
    const fetchImpl = fakeFetch(
      {
        [SUOMI_URL]: () => {
          throw new Error("boom");
        },
        [NOAA_URL]: () => {
          throw new Error("boom");
        },
      },
      counter,
    );

    const first = await getFiresPayload(1, { fetchImpl, now: NOW });
    assert.equal(first.status, 502);
    assert.equal(first.cacheControl, "no-store");
    const body = JSON.parse(first.body) as { error: string };
    assert.equal(typeof body.error, "string");
    assert.ok(body.error.length > 0);

    const second = await getFiresPayload(1, { fetchImpl, now: NOW });
    assert.equal(second.status, 502);
    assert.equal(second.cacheStatus, "miss");
    assert.equal(counter.calls, 4);
  });

  it("caches a partial result for a shorter period", async () => {
    clearFiresCache();
    const fetchImpl = fakeFetch({
      [SUOMI_URL]: () => csvResponse(goodCsv),
      [NOAA_URL]: () => {
        throw new Error("boom");
      },
    });

    const result = await getFiresPayload(1, { fetchImpl, now: NOW });
    assert.equal(result.status, 200);
    assert.equal(result.partial, true);
    assert.match(result.cacheControl, /max-age=30/);

    const payload = JSON.parse(result.body) as FiresResponse;
    assert.equal(payload.detections.length, 1);
    assert.equal(payload.sources.filter((source) => source.ok).length, 1);
    assert.equal(payload.sources.filter((source) => !source.ok).length, 1);
  });
});
