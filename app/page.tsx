"use client";

import * as React from "react";
import {
  Check,
  CircleAlert,
  Clock,
  Download,
  ExternalLink,
  Flame,
  Info,
  Layers,
  Loader2,
  MapPin,
  Minus,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Satellite,
  Search,
  ShieldCheck,
  Target,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

type Confidence = "low" | "nominal" | "high";

type Detection = {
  id: string;
  latitude: number;
  longitude: number;
  brightness: number | null;
  frp: number | null;
  confidence: Confidence;
  acquiredAt: string;
  satellite: string;
  daynight: string;
};

type FireSource = {
  name: string;
  url: string;
  ok: boolean;
  error?: string;
};

type FiresPayload = {
  detections: Detection[];
  fetchedAt: string;
  sourceUpdatedAt: string | null;
  sources: FireSource[];
  scope: string;
};

type WindowDays = 1 | 2 | 7;
type BaseLayer = "satellite" | "street";
type LoadStatus = "loading" | "ready" | "error";
type RegionKey =
  | "sumatra"
  | "kalimantan"
  | "java"
  | "sulawesi"
  | "bali-nusa-tenggara"
  | "maluku"
  | "papua";

type Region = {
  key: RegionKey;
  name: string;
  /** Approximate bounding box: [[north, west], [south, east]] */
  bounds: [[number, number], [number, number]];
};

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CENTER: [number, number] = [-2.5, 118];
const DEFAULT_ZOOM = 5;
const LEAFLET_VERSION = "1.9.4";
const LEAFLET_JS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const LEAFLET_LOAD_TIMEOUT_MS = 20000;

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  low: "#F2C14E",
  nominal: "#E0631C",
  high: "#8E1B12",
};

const CONFIDENCE_ORDER: Confidence[] = ["high", "nominal", "low"];

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "Low",
  nominal: "Nominal",
  high: "High",
};

const WINDOW_LABEL: Record<WindowDays, string> = {
  1: "24 hours",
  2: "48 hours",
  7: "7 days",
};

const WINDOW_SHORT: Record<WindowDays, string> = {
  1: "24 h",
  2: "48 h",
  7: "7 d",
};

/**
 * Approximate regional views. These are coarse longitude/latitude windows used
 * to group detections for scanning — they are NOT administrative boundaries and
 * neighbouring countries fall inside some of them.
 */
const REGIONS: Region[] = [
  { key: "java", name: "Java", bounds: [[-5.7, 104.8], [-9.0, 114.7]] },
  {
    key: "bali-nusa-tenggara",
    name: "Bali & Nusa Tenggara",
    bounds: [[-7.5, 114.4], [-11.4, 127.4]],
  },
  { key: "sumatra", name: "Sumatra", bounds: [[6.2, 94.5], [-5.9, 106.4]] },
  { key: "kalimantan", name: "Kalimantan", bounds: [[4.6, 108.5], [-4.5, 119.2]] },
  { key: "sulawesi", name: "Sulawesi", bounds: [[1.9, 118.6], [-10.8, 125.4]] },
  { key: "maluku", name: "Maluku", bounds: [[3.0, 124.8], [-6.8, 130.0]] },
  { key: "papua", name: "Papua", bounds: [[1.2, 130.0], [-10.2, 150.6]] },
];

const REGION_NAME: Record<RegionKey, string> = REGIONS.reduce(
  (acc, region) => {
    acc[region.key] = region.name;
    return acc;
  },
  {} as Record<RegionKey, string>,
);

const TILE_LAYERS: Record<
  BaseLayer,
  { url: string; attribution: string; maxZoom: number; subdomains?: string }
> = {
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics and the GIS User Community",
    maxZoom: 18,
  },
  street: {
    // Esri's World Street Map is served without an API key, unlike the
    // CARTO/OpenStreetMap raster endpoints which now watermark unkeyed tiles.
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors and the GIS User Community",
    maxZoom: 18,
  },
};

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConfidence(value: unknown): Confidence {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "h" || v === "high") return "high";
    if (v === "n" || v === "nominal") return "nominal";
    if (v === "l" || v === "low") return "low";
  }
  return "nominal";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const numberFormatter = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return numberFormatter.format(value);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatClockUtc(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const date = new Date(parsed);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDateShort(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const date = new Date(parsed);
  return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]}`;
}

function formatStampUtc(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const date = new Date(parsed);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${dd} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function relativeAge(timestamp: number | null, now: number): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "unknown";
  const diff = now - timestamp;
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes ? `${hours} h ${restMinutes} m ago` : `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h ago` : `${days} d ago`;
}

function regionOf(detection: Detection): RegionKey | null {
  for (const region of REGIONS) {
    const [[north, west], [south, east]] = region.bounds;
    if (
      detection.latitude <= north &&
      detection.latitude >= south &&
      detection.longitude >= west &&
      detection.longitude <= east
    ) {
      return region.key;
    }
  }
  return null;
}

function normalizePayload(body: unknown): FiresPayload | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const rawDetections = Array.isArray(record.detections) ? record.detections : null;
  if (!rawDetections) return null;

  const detections: Detection[] = [];
  for (const item of rawDetections) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const latitude = toFiniteNumber(entry.latitude);
    const longitude = toFiniteNumber(entry.longitude);
    if (latitude === null || longitude === null) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const acquiredAtRaw =
      typeof entry.acquiredAt === "string" ? entry.acquiredAt : "";
    const acquiredAtMs = Date.parse(acquiredAtRaw);
    if (!Number.isFinite(acquiredAtMs)) continue;

    const satellite =
      typeof entry.satellite === "string" && entry.satellite.trim() !== ""
        ? entry.satellite.trim()
        : "Unknown sensor";
    const daynight =
      typeof entry.daynight === "string" && entry.daynight.trim() !== ""
        ? entry.daynight.trim().toLowerCase()
        : "unknown";

    detections.push({
      id:
        typeof entry.id === "string" && entry.id.trim() !== ""
          ? entry.id
          : `${satellite}-${acquiredAtMs}-${latitude}-${longitude}`,
      latitude,
      longitude,
      brightness: toFiniteNumber(entry.brightness),
      frp: toFiniteNumber(entry.frp),
      confidence: normalizeConfidence(entry.confidence),
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      satellite,
      daynight,
    });
  }

  const sources: FireSource[] = [];
  if (Array.isArray(record.sources)) {
    for (const item of record.sources) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const name =
        typeof entry.name === "string" && entry.name.trim() !== ""
          ? entry.name
          : "Unnamed feed";
      const url = typeof entry.url === "string" ? entry.url : "";
      sources.push({
        name,
        url,
        ok: entry.ok === true,
        error: typeof entry.error === "string" ? entry.error : undefined,
      });
    }
  }

  return {
    detections,
    fetchedAt:
      typeof record.fetchedAt === "string" ? record.fetchedAt : new Date().toISOString(),
    sourceUpdatedAt:
      typeof record.sourceUpdatedAt === "string" ? record.sourceUpdatedAt : null,
    sources,
    scope:
      typeof record.scope === "string" && record.scope.trim() !== ""
        ? record.scope
        : "Indonesia-centred bounding box",
  };
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  return null;
}

function dayNightLabel(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw.startsWith("d")) return "Day";
  if (raw.startsWith("n")) return "Night";
  return value.trim() || "Unknown";
}

function popupHtml(detection: Detection): string {
  const rows: Array<[string, string]> = [
    ["Acquired", formatStampUtc(detection.acquiredAt)],
    ["Satellite", detection.satellite],
    ["Confidence", CONFIDENCE_LABEL[detection.confidence]],
    [
      "Brightness",
      detection.brightness === null ? "not reported" : `${detection.brightness.toFixed(1)} K`,
    ],
    [
      "Fire radiative power",
      detection.frp === null ? "not reported" : `${detection.frp.toFixed(1)} MW`,
    ],
    [
      "Coordinates",
      `${detection.latitude.toFixed(3)}, ${detection.longitude.toFixed(3)}`,
    ],
    ["Day / night", dayNightLabel(detection.daynight)],
  ];

  const body = rows
    .map(
      ([label, value]) =>
        `<div class="ember-popup-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(
          value,
        )}</span></div>`,
    )
    .join("");

  return `<div><p class="ember-popup-title">Thermal anomaly</p>${body}<p class="ember-popup-title" style="margin:10px 0 0;text-transform:none;letter-spacing:0;font-weight:400">A satellite-detected heat signature. It is not a confirmed forest fire.</p></div>`;
}

/* -------------------------------------------------------------------------- */
/*  Leaflet loader (no extra package dependency)                               */
/* -------------------------------------------------------------------------- */

type LngLat = [number, number];
type LatLngBounds = [LngLat, LngLat];

type LeafletHost = {
  addLayer(layer: LeafletLayer): unknown;
};

type LeafletLayer = {
  addTo(target: LeafletHost): LeafletLayer;
  remove(): void;
  bindPopup(content: string, options?: Record<string, unknown>): LeafletLayer;
  setStyle(style: Record<string, unknown>): LeafletLayer;
  openPopup?(): LeafletLayer;
  on(event: string, handler: (event: unknown) => void): LeafletLayer;
};

type LeafletLayerGroup = LeafletLayer & {
  addLayer(layer: LeafletLayer): LeafletLayerGroup;
  removeLayer(layer: LeafletLayer): LeafletLayerGroup;
};

type LeafletMap = {
  setView(center: LngLat, zoom: number): LeafletMap;
  flyTo(center: LngLat, zoom: number, options?: Record<string, unknown>): LeafletMap;
  flyToBounds(
    bounds: LatLngBounds,
    options?: Record<string, unknown>,
  ): LeafletMap;
  zoomIn(delta?: number): LeafletMap;
  zoomOut(delta?: number): LeafletMap;
  addLayer(layer: LeafletLayer): LeafletMap;
  removeLayer(layer: LeafletLayer): LeafletMap;
  remove(): void;
  invalidateSize(options?: Record<string, unknown>): LeafletMap;
};

type LeafletPopup = {
  setLatLng(latlng: LngLat): LeafletPopup;
  setContent(content: string): LeafletPopup;
  openOn(map: LeafletMap): LeafletPopup;
  close(): LeafletPopup;
};

type LeafletApi = {
  map(container: HTMLElement, options: Record<string, unknown>): LeafletMap;
  tileLayer(url: string, options?: Record<string, unknown>): LeafletLayer;
  circleMarker(latlng: LngLat, options?: Record<string, unknown>): LeafletLayer;
  layerGroup(): LeafletLayerGroup;
  rectangle(bounds: LatLngBounds, options?: Record<string, unknown>): LeafletLayer;
  popup(options?: Record<string, unknown>): LeafletPopup;
};

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

let leafletPromise: Promise<LeafletApi> | null = null;

function loadLeaflet(): Promise<LeafletApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("The map library can only load in a browser."));
  }
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise<LeafletApi>((resolve, reject) => {
    if (!document.querySelector('link[data-ember-leaflet-css="true"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS_URL;
      link.dataset.emberLeafletCss = "true";
      document.head.appendChild(link);
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-ember-leaflet-js="true"]',
    );
    const script = existing ?? document.createElement("script");

    const onLoad = () =>
      finish(() => {
        if (window.L) resolve(window.L);
        else reject(new Error("The map library loaded but did not register itself."));
      });

    const onError = () =>
      finish(() => {
        leafletPromise = null;
        reject(
          new Error(
            "The interactive map could not load its library from unpkg.com. Check your network connection and retry.",
          ),
        );
      });

    const timer = window.setTimeout(() => {
      finish(() => {
        leafletPromise = null;
        reject(
          new Error(
            "Timed out while loading the interactive map library. Check your network connection and retry.",
          ),
        );
      });
    }, LEAFLET_LOAD_TIMEOUT_MS);

    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);

    if (!existing) {
      script.src = LEAFLET_JS_URL;
      script.async = true;
      script.dataset.emberLeafletJs = "true";
      document.head.appendChild(script);
    }
  });

  return leafletPromise;
}

/* -------------------------------------------------------------------------- */
/*  Map                                                                        */
/* -------------------------------------------------------------------------- */

type FireMapProps = {
  detections: Detection[];
  selectedId: string | null;
  onSelect: (detection: Detection) => void;
  regionBounds: LatLngBounds | null;
  base: BaseLayer;
  onBaseChange: (base: BaseLayer) => void;
  onResetExtent: () => void;
  status: LoadStatus;
  errorMessage: string | null;
  onRetry: () => void;
  refreshing: boolean;
  windowDays: WindowDays;
  onWindowChange: (days: WindowDays) => void;
  detectionTotal: number;
  emptyTitle: string;
  emptyBody: string;
  /** True when a previous successful response is still being shown. */
  hasRetainedData: boolean;
};

function FireMap({
  detections,
  selectedId,
  onSelect,
  regionBounds,
  base,
  onBaseChange,
  onResetExtent,
  status,
  errorMessage,
  onRetry,
  refreshing,
  windowDays,
  onWindowChange,
  detectionTotal,
  emptyTitle,
  emptyBody,
  hasRetainedData,
}: FireMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<LeafletMap | null>(null);
  const apiRef = React.useRef<LeafletApi | null>(null);
  const tileRef = React.useRef<LeafletLayer | null>(null);
  const groupRef = React.useRef<LeafletLayerGroup | null>(null);
  const regionRectRef = React.useRef<LeafletLayer | null>(null);
  const popupRef = React.useRef<LeafletPopup | null>(null);
  const markersRef = React.useRef<Map<string, LeafletLayer>>(new Map());
  const previousSelectionRef = React.useRef<string | null>(null);
  const onSelectRef = React.useRef(onSelect);
  const openPopupRef = React.useRef<(detection: Detection) => void>(() => {});

  const [ready, setReady] = React.useState(false);
  const [libraryError, setLibraryError] = React.useState<string | null>(null);

  onSelectRef.current = onSelect;

  // A single shared popup keeps memory flat when the feed returns thousands of
  // points (one popup object instead of one per marker).
  const openPopup = React.useCallback((detection: Detection) => {
    const popup = popupRef.current;
    const map = mapRef.current;
    if (!popup || !map) return;
    popup
      .setLatLng([detection.latitude, detection.longitude])
      .setContent(popupHtml(detection))
      .openOn(map);
  }, []);
  openPopupRef.current = openPopup;

  const detectionsById = React.useMemo(() => {
    const map = new Map<string, Detection>();
    for (const detection of detections) map.set(detection.id, detection);
    return map;
  }, [detections]);

  // Create the map once, after the DOM node exists.
  React.useEffect(() => {
    let cancelled = false;
    setLibraryError(null);

    loadLeaflet()
      .then((api) => {
        if (cancelled) return;
        const node = containerRef.current;
        if (!node) return;
        apiRef.current = api;

        const map = api.map(node, {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          zoomControl: false,
          attributionControl: true,
          preferCanvas: true,
          minZoom: 3,
          maxZoom: 18,
          worldCopyJump: true,
          maxBoundsViscosity: 0.7,
        });
        mapRef.current = map;

        const spec = TILE_LAYERS[base];
        tileRef.current = api
          .tileLayer(spec.url, {
            attribution: spec.attribution,
            maxZoom: spec.maxZoom,
            detectRetina: true,
            ...(spec.subdomains ? { subdomains: spec.subdomains } : {}),
          })
          .addTo(map);

        const group = api.layerGroup();
        group.addTo(map);
        groupRef.current = group;

        popupRef.current = api.popup({
          maxWidth: 280,
          className: "ember-popup",
          offset: [0, 1],
        });
        setReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLibraryError(
          error instanceof Error
            ? error.message
            : "The interactive map could not be loaded.",
        );
      });

    return () => {
      cancelled = true;
      markersRef.current.clear();
      groupRef.current = null;
      regionRectRef.current = null;
      tileRef.current = null;
      apiRef.current = null;
      popupRef.current?.close();
      popupRef.current = null;
      const map = mapRef.current;
      mapRef.current = null;
      if (map) {
        try {
          map.remove();
        } catch {
          /* the map may already be detached */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the canvas sized to its container (sidebar / viewport changes).
  React.useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      mapRef.current?.invalidateSize({ animate: false });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready]);

  // Swap the base imagery.
  React.useEffect(() => {
    const api = apiRef.current;
    const map = mapRef.current;
    if (!api || !map || !ready) return;

    const spec = TILE_LAYERS[base];
    const next = api
      .tileLayer(spec.url, {
        attribution: spec.attribution,
        maxZoom: spec.maxZoom,
        detectRetina: true,
        ...(spec.subdomains ? { subdomains: spec.subdomains } : {}),
      })
      .addTo(map);
    const previous = tileRef.current;
    tileRef.current = next;
    if (previous) {
      map.removeLayer(previous);
      previous.remove();
    }
  }, [base, ready]);

  // Diff the canvas markers so thousands of points stay cheap.
  React.useEffect(() => {
    const api = apiRef.current;
    const group = groupRef.current;
    if (!api || !group || !ready) return;

    const live = new Set<string>();
    for (const detection of detections) {
      live.add(detection.id);
      if (markersRef.current.has(detection.id)) continue;
      const marker = api.circleMarker([detection.latitude, detection.longitude], {
        radius: 3.5,
        color: "#FFFDF8",
        weight: 0.8,
        opacity: 0.9,
        fillColor: CONFIDENCE_COLOR[detection.confidence],
        fillOpacity: 0.78,
      });
      marker.on("click", () => {
        openPopupRef.current(detection);
        onSelectRef.current(detection);
      });
      marker.addTo(group);
      markersRef.current.set(detection.id, marker);
    }

    for (const [id, marker] of markersRef.current) {
      if (live.has(id)) continue;
      group.removeLayer(marker);
      markersRef.current.delete(id);
    }
  }, [detections, ready]);

  // Highlight the selected detection.
  React.useEffect(() => {
    const previousId = previousSelectionRef.current;
    if (previousId && previousId !== selectedId) {
      const marker = markersRef.current.get(previousId);
      const detection = detectionsById.get(previousId);
      if (marker && detection) {
        marker.setStyle({
          radius: 3.5,
          color: "#FFFDF8",
          weight: 0.8,
          opacity: 0.9,
          fillOpacity: 0.78,
        });
      }
    }

    if (selectedId) {
      const marker = markersRef.current.get(selectedId);
      const detection = detectionsById.get(selectedId);
      if (marker && detection) {
        marker.setStyle({
          radius: 9,
          color: "#14261E",
          weight: 2.5,
          opacity: 1,
          fillOpacity: 1,
        });
        openPopupRef.current(detection);
      }
    }
    previousSelectionRef.current = selectedId;
  }, [selectedId, detectionsById]);

  // Approximate regional view box + camera move.
  React.useEffect(() => {
    const api = apiRef.current;
    const map = mapRef.current;
    if (!api || !map || !ready) return;

    if (regionRectRef.current) {
      map.removeLayer(regionRectRef.current);
      regionRectRef.current = null;
    }

    if (regionBounds) {
      const rect = api.rectangle(regionBounds, {
        color: "#14261E",
        weight: 1.5,
        opacity: 0.5,
        dashArray: "7 6",
        fillColor: "#E0631C",
        fillOpacity: 0.04,
        interactive: false,
      });
      rect.addTo(map);
      regionRectRef.current = rect;
      map.flyToBounds(regionBounds, { padding: [56, 56], duration: 0.8, maxZoom: 9 });
    } else {
      map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 0.8 });
    }
  }, [regionBounds, ready]);

  const handleReset = React.useCallback(() => {
    mapRef.current?.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    onResetExtent();
  }, [onResetExtent]);

  const showOverlay = status !== "ready" || libraryError !== null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#e7e2d6]">
      <div ref={containerRef} className="absolute inset-0" aria-hidden="true" />

      {/* Base imagery switch */}
      <div className="pointer-events-none absolute left-3 top-[4.6rem] z-[800] lg:top-4">
        <div
          role="group"
          aria-label="Map imagery"
          className="pointer-events-auto flex items-center gap-1 rounded-xl border border-black/5 bg-[#fffdf8]/92 p-1 shadow-[0_18px_40px_-24px_rgba(20,38,30,0.85)] backdrop-blur-md"
        >
          <BaseButton
            active={base === "satellite"}
            onClick={() => onBaseChange("satellite")}
            icon={<Satellite className="size-3.5" />}
          >
            Satellite
          </BaseButton>
          <BaseButton
            active={base === "street"}
            onClick={() => onBaseChange("street")}
            icon={<Layers className="size-3.5" />}
          >
            Street
          </BaseButton>
        </div>
      </div>

      {/* Camera controls */}
      <div className="pointer-events-none absolute right-3 top-[4.6rem] z-[800] flex flex-col gap-2 lg:top-4">
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-black/5 bg-[#fffdf8]/92 shadow-[0_18px_40px_-24px_rgba(20,38,30,0.85)] backdrop-blur-md">
          <MapIconButton
            label="Zoom in"
            onClick={() => mapRef.current?.zoomIn()}
          >
            <Plus className="size-4" />
          </MapIconButton>
          <MapIconButton
            label="Zoom out"
            onClick={() => mapRef.current?.zoomOut()}
            divider
          >
            <Minus className="size-4" />
          </MapIconButton>
        </div>
        <MapIconButton
          label="Reset map extent"
          onClick={handleReset}
          className="pointer-events-auto rounded-xl border border-black/5 bg-[#fffdf8]/92 shadow-[0_18px_40px_-24px_rgba(20,38,30,0.85)] backdrop-blur-md"
        >
          <RotateCcw className="size-4" />
        </MapIconButton>
      </div>

      {/* Stale banner (refresh failed but data is still on screen) */}
      {status === "error" && hasRetainedData ? (
        <div className="pointer-events-none absolute inset-x-0 top-[4.6rem] z-[850] flex justify-center px-3 lg:top-4">
          <div
            role="status"
            className="pointer-events-auto flex items-center gap-2 rounded-xl border border-ember-200 bg-ember-50/95 px-3 py-1.5 shadow-[0_18px_40px_-24px_rgba(20,38,30,0.85)] backdrop-blur-md"
          >
            <TriangleAlert className="size-3.5 shrink-0 text-ember-700" />
            <span className="text-[11.5px] font-medium text-ember-900">
              Showing the last good data — refresh failed
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-ember-600 px-2 py-1 text-[11px] font-semibold text-ivory-50 transition-colors hover:bg-ember-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70"
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-24 left-3 z-[800] sm:bottom-28">
        <div className="pointer-events-auto rounded-xl border border-black/5 bg-[#fffdf8]/92 px-3 py-2.5 shadow-[0_18px_40px_-24px_rgba(20,38,30,0.85)] backdrop-blur-md">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-forest-800/60">
            Confidence
          </p>
          <ul className="mt-1.5 space-y-1">
            {CONFIDENCE_ORDER.map((confidence) => (
              <li key={confidence} className="flex items-center gap-2">
                <span
                  className="size-2.5 rounded-full ring-1 ring-white/70"
                  style={{ backgroundColor: CONFIDENCE_COLOR[confidence] }}
                />
                <span className="text-[11px] font-medium text-forest-900">
                  {CONFIDENCE_LABEL[confidence]}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 max-w-[9.5rem] text-[10px] leading-snug text-forest-800/55">
            Sensor confidence, not fire severity.
          </p>
        </div>
      </div>

      {/* Temporal filters */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[800] flex justify-center px-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-black/5 bg-[#fffdf8]/94 p-1.5 shadow-[0_22px_50px_-26px_rgba(20,38,30,0.9)] backdrop-blur-md">
          <div
            role="group"
            aria-label="Time window"
            className="flex items-center gap-1"
          >
            {([1, 2, 7] as WindowDays[]).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => onWindowChange(days)}
                aria-pressed={windowDays === days}
                className={cn(
                  "rounded-xl px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70",
                  windowDays === days
                    ? "bg-forest-800 text-ivory-50 shadow-[0_6px_16px_-10px_rgba(20,38,30,0.9)]"
                    : "text-forest-800/70 hover:bg-forest-800/8 hover:text-forest-900",
                )}
              >
                {WINDOW_SHORT[days]}
              </button>
            ))}
          </div>
          <div className="hidden h-5 w-px bg-forest-900/10 sm:block" />
          <div className="hidden items-center gap-1.5 pr-2 text-[11px] text-forest-800/60 sm:flex">
            <Clock className="size-3.5" />
            <span className="tnum">
              {detectionTotal > 0
                ? `${formatCount(detectionTotal)} in view`
                : status === "loading"
                  ? "loading…"
                  : "no data"}
            </span>
          </div>
          {refreshing ? (
            <Loader2 className="mr-1 size-3.5 animate-spin text-ember-600" />
          ) : null}
        </div>
      </div>

      {/* Status overlays */}
      {libraryError ? (
        <MapOverlayCard
          tone="error"
          icon={<CircleAlert className="size-5" />}
          title="The map library did not load"
          body={libraryError}
          action={
            <Button
              size="sm"
              onClick={() => window.location.reload()}
              className="bg-forest-800 text-ivory-50 hover:bg-forest-700"
            >
              <RefreshCw className="size-3.5" />
              Reload page
            </Button>
          }
        />
      ) : status === "error" && !hasRetainedData ? (
        <MapOverlayCard
          tone="error"
          icon={<TriangleAlert className="size-5" />}
          title="Fire data could not be loaded"
          body={errorMessage ?? "The data service did not respond."}
          action={
            <Button
              size="sm"
              onClick={onRetry}
              className="bg-forest-800 text-ivory-50 hover:bg-forest-700"
            >
              <RefreshCw className="size-3.5" />
              Try again
            </Button>
          }
        />
      ) : status === "loading" && !hasRetainedData ? (
        <MapOverlayCard
          tone="neutral"
          icon={<Loader2 className="size-5 animate-spin" />}
          title="Loading detections"
          body={`Fetching VIIRS thermal anomalies for the last ${WINDOW_LABEL[windowDays].toLowerCase()}.`}
        />
      ) : status === "ready" && detections.length === 0 ? (
        <MapOverlayCard
          tone="neutral"
          icon={<Target className="size-5" />}
          title={emptyTitle}
          body={emptyBody}
        />
      ) : null}
    </div>
  );
}

function BaseButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70",
        active
          ? "bg-forest-800 text-ivory-50"
          : "text-forest-800/70 hover:bg-forest-800/8 hover:text-forest-900",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function MapIconButton({
  label,
  onClick,
  children,
  divider,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  divider?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid size-9 place-items-center text-forest-900 transition-colors hover:bg-forest-800/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ember-500/70",
        divider && "border-b border-forest-900/10",
        className,
      )}
    >
      {children}
    </button>
  );
}

function MapOverlayCard({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: "error" | "neutral";
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[900] grid place-items-center px-4">
      <div
        role="status"
        className={cn(
          "pointer-events-auto w-full max-w-sm rounded-2xl border p-5 text-center shadow-[0_30px_60px_-30px_rgba(20,38,30,0.9)] backdrop-blur-md",
          tone === "error"
            ? "border-[#d9b3ae] bg-[#fdf1ee]/95"
            : "border-black/5 bg-[#fffdf8]/95",
        )}
      >
        <div
          className={cn(
            "mx-auto grid size-10 place-items-center rounded-full",
            tone === "error"
              ? "bg-[#f6d9d4] text-[#8e1b12]"
              : "bg-forest-800/8 text-forest-800",
          )}
        >
          {icon}
        </div>
        <p className="mt-3 text-[14px] font-semibold text-forest-900">{title}</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-forest-800/70">{body}</p>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sidebar panel                                                              */
/* -------------------------------------------------------------------------- */

type SidebarProps = {
  payload: FiresPayload | null;
  status: LoadStatus;
  error: string | null;
  refreshing: boolean;
  lastSuccessAt: number | null;
  now: number;
  windowDays: WindowDays;
  region: RegionKey | "all";
  onRegionChange: (region: RegionKey | "all") => void;
  query: string;
  onQueryChange: (query: string) => void;
  confidence: Record<Confidence, boolean>;
  onConfidenceToggle: (confidence: Confidence) => void;
  regionCounts: Record<RegionKey, number>;
  maxRegionCount: number;
  outsideCount: number;
  visibleCount: number;
  highCount: number;
  scopeCount: number;
  latestAcquiredAt: string | null;
  latestInWindow: string | null;
  selected: Detection | null;
  onSelect: (detection: Detection) => void;
  onClearSelection: () => void;
  recent: Detection[];
  onRefresh: () => void;
  onExport: () => void;
  onAbout: () => void;
};

function SidebarPanel({
  payload,
  status,
  error,
  refreshing,
  lastSuccessAt,
  now,
  windowDays,
  region,
  onRegionChange,
  query,
  onQueryChange,
  confidence,
  onConfidenceToggle,
  regionCounts,
  maxRegionCount,
  outsideCount,
  visibleCount,
  highCount,
  scopeCount,
  latestAcquiredAt,
  latestInWindow,
  selected,
  onSelect,
  onClearSelection,
  recent,
  onRefresh,
  onExport,
  onAbout,
}: SidebarProps) {
  const failedSources = payload?.sources.filter((source) => !source.ok) ?? [];
  const totalSources = payload?.sources.length ?? 0;
  const hasData = payload !== null;
  /**
   * Nothing has been loaded for the selected window yet (first load, a failed
   * load, or a window that has not been fetched). We must never present this
   * as a count of zero.
   */
  const noData = !hasData;
  const loading = status === "loading" && noData;
  const stale = status === "error" && hasData;

  const filteredRegions = REGIONS.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const regionLabel = region === "all" ? "All regions" : REGION_NAME[region];

  return (
    <div className="flex h-full min-h-0 flex-col bg-ivory-100">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 pb-4 pt-5">
        <div className="ember-mark size-11 shrink-0">
          <Flame className="size-5 text-ember-400" strokeWidth={2.1} />
        </div>
        <div className="min-w-0">
          <p className="text-[17px] font-semibold leading-none tracking-[0.2em] text-forest-900">
            EMBER
          </p>
          <p className="mt-1 truncate text-[11.5px] leading-none text-forest-700/65">
            Indonesia fire watch
          </p>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
        {/* Overview */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-forest-800/70">
            Overview
          </h2>
          <span
            title="The dashboard refreshes every 5 minutes. Satellite data itself is typically a few hours old."
            className="inline-flex items-center gap-1.5 rounded-full border border-ember-200 bg-ember-50 px-2 py-[3px] text-[10.5px] font-semibold text-ember-700"
          >
            <span className="relative flex size-1.5">
              <span className="live-ping absolute inline-flex size-full rounded-full bg-ember-500" />
              <span className="relative inline-flex size-1.5 rounded-full bg-ember-500" />
            </span>
            Near-real-time
          </span>
        </div>

        {/* Metrics */}
        <div className="mt-3 overflow-hidden rounded-2xl border border-[color:var(--hairline)] bg-[#fffdf8] shadow-[0_18px_40px_-34px_rgba(20,38,30,0.95)]">
          <MetricRow
            label="Detections in view"
            hint={
              noData
                ? "No data loaded for this window"
                : `${regionLabel} · last ${WINDOW_LABEL[windowDays].toLowerCase()}`
            }
            value={noData ? "—" : formatCount(visibleCount)}
            muted={noData}
          />
          <MetricRow
            label="High confidence"
            hint="Sensor confidence — not a severity score"
            value={noData ? "—" : formatCount(highCount)}
            muted={noData}
            divider
          />
          <MetricRow
            label="Latest acquisition"
            hint={
              noData
                ? "No data loaded for this window"
                : latestInWindow
                  ? `${formatDateShort(latestInWindow)} · ${relativeAge(Date.parse(latestInWindow), now)}`
                  : "No acquisitions match these filters"
            }
            value={
              noData || !latestInWindow
                ? "—"
                : `${formatClockUtc(latestInWindow)} UTC`
            }
            muted={noData}
            divider
          />
        </div>

        {/* Freshness + refresh */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-[11.5px] leading-tight text-forest-800/60">
            {status === "loading"
              ? "Loading latest feed…"
              : lastSuccessAt
                ? `Fetched ${relativeAge(lastSuccessAt, now)}`
                : "No data loaded yet"}
          </p>
          <Button
            size="xs"
            variant="outline"
            onClick={onRefresh}
            disabled={refreshing}
            className="gap-1.5 border-forest-900/12 bg-[#fffdf8] text-forest-800 hover:bg-forest-800 hover:text-ivory-50"
          >
            {refreshing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Refresh
          </Button>
        </div>

        {/* Banners */}
        <div aria-live="polite" className="mt-3 space-y-2">
          {stale ? (
            <Banner
              tone="warn"
              icon={<TriangleAlert className="size-3.5" />}
              title="Refresh failed — showing the last good data"
              body={error ?? "The data service could not be reached."}
            />
          ) : null}

          {status === "error" && !hasData ? (
            <Banner
              tone="error"
              icon={<CircleAlert className="size-3.5" />}
              title="No data available"
              body={error ?? "The data service could not be reached."}
            />
          ) : null}

          {hasData && failedSources.length > 0 ? (
            <Banner
              tone="warn"
              icon={<CircleAlert className="size-3.5" />}
              title={`${failedSources.length} of ${totalSources} upstream feeds failed`}
              body={`${failedSources
                .map((source) => source.name)
                .join(", ")} did not respond, so counts may be incomplete.`}
            />
          ) : null}
        </div>

        {/* Region selector */}
        <div className="mt-5">
          <Label>Region</Label>
          <Select
            value={region}
            onValueChange={(value) => onRegionChange(value as RegionKey | "all")}
          >
            <SelectTrigger className="mt-1.5 h-9 w-full border-forest-900/12 bg-[#fffdf8] text-[13px] text-forest-900">
              <SelectValue placeholder="All regions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {REGIONS.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Region search */}
        <div className="relative mt-2.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-forest-800/40" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search regions…"
            aria-label="Search regions"
            className="h-9 border-forest-900/12 bg-[#fffdf8] pl-8 text-[13px] text-forest-900 placeholder:text-forest-800/35"
          />
        </div>

        {/* Confidence filters */}
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <Label>Confidence filters</Label>
            <span className="text-[10.5px] text-forest-800/45">
              {scopeCount > 0 ? `${formatCount(scopeCount)} in ${regionLabel.toLowerCase()}` : "—"}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CONFIDENCE_ORDER.map((level) => {
              const active = confidence[level];
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => onConfidenceToggle(level)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70",
                    active
                      ? "border-forest-900/15 bg-[#fffdf8] text-forest-900"
                      : "border-forest-900/8 bg-transparent text-forest-800/45 line-through decoration-forest-800/30",
                  )}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: CONFIDENCE_COLOR[level] }}
                  />
                  {CONFIDENCE_LABEL[level]}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10.5px] leading-snug text-forest-800/50">
            Confidence is the sensor&rsquo;s own assessment of a heat signature
            &mdash; it is not a measure of fire size or severity.
          </p>
        </div>

        {/* Region summary */}
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <Label>Regional views</Label>
            <span className="text-[10.5px] text-forest-800/45">click to focus</span>
          </div>

          <ul className="mt-1.5 space-y-0.5">
            {filteredRegions.map((item) => {
              const count = regionCounts[item.key] ?? 0;
              const isActive = region === item.key;
              const width = maxRegionCount > 0 ? (count / maxRegionCount) * 100 : 0;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => onRegionChange(isActive ? "all" : item.key)}
                    aria-pressed={isActive}
                    className={cn(
                      "group w-full rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70",
                      isActive ? "bg-forest-800/8" : "hover:bg-forest-800/5",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-[12.5px]",
                          isActive
                            ? "font-semibold text-forest-900"
                            : "font-medium text-forest-800/80",
                        )}
                      >
                        {item.name}
                      </span>
                      <span className="tnum shrink-0 text-[12.5px] font-semibold text-forest-900">
                        {noData ? "—" : formatCount(count)}
                      </span>
                    </span>
                    <span className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-forest-900/8">
                      <span
                        className="block h-full rounded-full bg-ember-500/70 transition-[width] duration-500"
                        style={{ width: `${width}%` }}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
            {filteredRegions.length === 0 ? (
              <li className="rounded-lg border border-dashed border-forest-900/15 px-3 py-4 text-center text-[12px] text-forest-800/55">
                No region matches “{query}”.
              </li>
            ) : null}
          </ul>

          <p className="mt-2 text-[10.5px] leading-snug text-forest-800/50">
            Approximate regional views — coarse bounding boxes, not administrative
            boundaries. Neighbouring countries can fall inside a box.
            {outsideCount > 0
              ? ` ${formatCount(outsideCount)} detections sit outside every box.`
              : ""}
          </p>
        </div>

        {/* Selected detection */}
        <div className="mt-5">
          <Label>Selected hotspot</Label>
          {selected ? (
            <div className="mt-1.5 rounded-2xl border border-[color:var(--hairline)] bg-[#fffdf8] p-3.5 shadow-[0_18px_40px_-34px_rgba(20,38,30,0.95)]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-forest-900">
                    {selected.satellite}
                  </p>
                  <p className="mt-0.5 font-mono text-[10.5px] text-forest-800/50">
                    {selected.id}
                  </p>
                </div>
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[10.5px] font-semibold text-forest-900"
                  style={{ backgroundColor: `${CONFIDENCE_COLOR[selected.confidence]}26` }}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: CONFIDENCE_COLOR[selected.confidence] }}
                  />
                  {CONFIDENCE_LABEL[selected.confidence]}
                </span>
              </div>

              <dl className="mt-3 space-y-1.5">
                <DetailRow
                  label="Acquired"
                  value={formatStampUtc(selected.acquiredAt)}
                  mono
                />
                <DetailRow
                  label="Coordinates"
                  value={`${selected.latitude.toFixed(3)}, ${selected.longitude.toFixed(3)}`}
                  mono
                />
                <DetailRow
                  label="Brightness"
                  value={
                    selected.brightness === null
                      ? "not reported"
                      : `${selected.brightness.toFixed(1)} K`
                  }
                />
                <DetailRow
                  label="Radiative power"
                  value={
                    selected.frp === null ? "not reported" : `${selected.frp.toFixed(1)} MW`
                  }
                />
                <DetailRow
                  label="Day / night"
                  value={
                    dayNightLabel(selected.daynight) === "Day"
                      ? "Daytime pass"
                      : dayNightLabel(selected.daynight) === "Night"
                        ? "Nighttime pass"
                        : dayNightLabel(selected.daynight)
                  }
                />
                <DetailRow
                  label="Regional view"
                  value={
                    (() => {
                      const key = regionOf(selected);
                      return key ? REGION_NAME[key] : "Outside the listed views";
                    })()
                  }
                />
              </dl>

              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onSelect(selected)}
                  className="gap-1.5 border-forest-900/12 bg-[#fffdf8] text-forest-800 hover:bg-forest-800 hover:text-ivory-50"
                >
                  <MapPin className="size-3" />
                  Centre on map
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={onClearSelection}
                  className="gap-1.5 text-forest-800/60 hover:bg-forest-800/8 hover:text-forest-900"
                >
                  <X className="size-3" />
                  Clear
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 rounded-2xl border border-dashed border-forest-900/15 bg-[#fffdf8]/60 px-3.5 py-5 text-center">
              <Target className="mx-auto size-4 text-forest-800/35" />
              <p className="mt-2 text-[12px] leading-relaxed text-forest-800/55">
                Select a marker on the map, or a recent detection below, to
                inspect its details.
              </p>
            </div>
          )}
        </div>

        {/* Recent detections */}
        {recent.length > 0 ? (
          <div className="mt-5">
            <Label>Most recent detections</Label>
            <ul className="mt-1.5 space-y-0.5">
              {recent.map((detection) => (
                <li key={detection.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(detection)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-forest-800/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-500/70"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: CONFIDENCE_COLOR[detection.confidence] }}
                    />
                    <span className="tnum shrink-0 text-[11.5px] font-semibold text-forest-900">
                      {formatClockUtc(detection.acquiredAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-forest-800/60">
                      {detection.satellite}
                    </span>
                    <span className="tnum shrink-0 text-[11px] text-forest-800/50">
                      {detection.latitude.toFixed(2)}, {detection.longitude.toFixed(2)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Export */}
        <Button
          onClick={onExport}
          disabled={visibleCount === 0}
          className="mt-5 w-full gap-2 bg-forest-800 text-ivory-50 hover:bg-forest-700"
        >
          <Download className="size-3.5" />
          Export filtered CSV
        </Button>
      </div>

      {/* Footer */}
      <div className="border-t border-[color:var(--hairline)] bg-ivory-100/95 px-5 py-3.5">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-forest-700/60" />
          <p className="text-[10.5px] leading-relaxed text-forest-800/55">
            Data: NASA FIRMS · VIIRS satellites.
            {hasData && totalSources > 0
              ? ` ${formatCount(totalSources - failedSources.length)}/${formatCount(
                  totalSources,
                )} feeds responding.`
              : ""}
            <span className="mt-0.5 block">
              Thermal anomalies are not confirmed forest fires.
            </span>
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={onAbout}
          className="mt-2 w-full gap-1.5 text-forest-800/70 hover:bg-forest-800/8 hover:text-forest-900"
        >
          <Info className="size-3" />
          About Ember, the data &amp; the caveats
        </Button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-forest-800/60">
      {children}
    </p>
  );
}

function MetricRow({
  label,
  hint,
  value,
  muted,
  divider,
}: {
  label: string;
  hint: string;
  value: string;
  muted?: boolean;
  divider?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-3",
        divider && "border-t border-[color:var(--hairline)]",
      )}
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-forest-800/65">
          {label}
        </p>
        <p className="mt-0.5 truncate text-[10.5px] text-forest-800/50">{hint}</p>
      </div>
      <p
        className={cn(
          "tnum shrink-0 text-[19px] font-semibold leading-none",
          muted ? "text-forest-800/35" : "text-forest-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11px] text-forest-800/55">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right text-[11.5px] font-medium text-forest-900",
          mono && "font-mono text-[11px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  body,
}: {
  tone: "warn" | "error";
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2.5",
        tone === "warn"
          ? "border-ember-200 bg-ember-50 text-ember-900"
          : "border-[#e0bdb7] bg-[#fdf1ee] text-[#7e1f16]",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11.5px] font-semibold leading-snug">{title}</p>
        <p className="mt-0.5 text-[10.5px] leading-relaxed opacity-80">{body}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  About dialog                                                               */
/* -------------------------------------------------------------------------- */

function AboutDialog({
  open,
  onOpenChange,
  payload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: FiresPayload | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-forest-900/10 bg-[#fffdf8] p-6 text-forest-900 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[17px]">
            <Flame className="size-4 text-ember-600" />
            About Ember
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-forest-800/70">
            Ember is an open, honest view of satellite-detected thermal
            anomalies over an Indonesia-centred area. It is a monitoring aid,
            not an official fire alert service.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-[12.5px] leading-relaxed text-forest-800/80">
          <Section title="Near-real-time updates">
            <p>
              The dashboard polls the data service every 5 minutes, and shows how
              old the data actually is. The satellite data itself is usually a few
              hours behind — NASA FIRMS publishes each VIIRS acquisition after it
              has been processed, so the newest detection on screen may be several
              hours old. A quiet map can mean &ldquo;no new acquisitions&rdquo;,
              not &ldquo;no fires&rdquo;. The satellite basemap is reference imagery;
              it does not show live flames or smoke.
            </p>
          </Section>

          <Section title="Thermal anomalies are not confirmed fires">
            <p>
              Every point on the map is a thermal anomaly: a pixel where a
              sensor registered unusually high brightness. That can be a
              forest fire, but it can also be planned agricultural burning,
              industrial flaring, gas flaring, or a hot surface such as a
              rooftop or a lava flow. Ember never labels a point
              &ldquo;forest fire&rdquo; and never estimates burned area.
            </p>
          </Section>

          <Section title="Confidence is not severity">
            <p>
              The confidence label (low, nominal, high) is the satellite
              product&rsquo;s own assessment of how sure the sensor is that it
              detected a fire, not a measure of how large or intense the fire
              is. Brightness and fire radiative power are sensor values; they
              are shown as reported and are not converted into area or damage.
            </p>
          </Section>

          <Section title="Scope and regional views">
            <p>
              The data covers a bounding box around Indonesia (roughly 94°E to
              142°E, 12°S to 7°N). It is not clipped to the Indonesian border, so
              points from Malaysia, Papua New Guinea, Timor-Leste and the
              southern Philippines can appear. The regional views in the sidebar
              are coarse rectangles used for scanning — they are approximate
              groupings, not administrative boundaries, and neighbouring areas
              can sit inside them.
            </p>
          </Section>

          <Section title="Data sources">
            <ul className="space-y-2">
              {(payload?.sources ?? []).map((source) => (
                <li
                  key={source.name}
                  className="flex items-start gap-2 rounded-lg border border-forest-900/8 bg-ivory-50 px-3 py-2"
                >
                  {source.ok ? (
                    <Check className="mt-0.5 size-3.5 shrink-0 text-forest-600" />
                  ) : (
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-[#a8231c]" />
                  )}
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-forest-900">
                      {source.name}
                    </p>
                    <p className="text-[11px] text-forest-800/60">
                      {source.ok
                        ? "Responding — data included."
                        : `Not responding${source.error ? `: ${source.error}` : "."} Data from this feed is missing.`}
                    </p>
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-0.5 inline-flex items-center gap-1 break-all font-mono text-[10.5px] text-forest-600 underline underline-offset-2"
                      >
                        {source.url}
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
              <li className="flex items-start gap-2 rounded-lg border border-forest-900/8 bg-ivory-50 px-3 py-2">
                <Radio className="mt-0.5 size-3.5 shrink-0 text-forest-600" />
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-forest-900">
                    NASA FIRMS — active fire / thermal anomaly
                  </p>
                  <a
                    href="https://firms.modaps.eosdis.nasa.gov/"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-0.5 inline-flex items-center gap-1 break-all font-mono text-[10.5px] text-forest-600 underline underline-offset-2"
                  >
                    firms.modaps.eosdis.nasa.gov
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                </div>
              </li>
              <li className="flex items-start gap-2 rounded-lg border border-forest-900/8 bg-ivory-50 px-3 py-2">
                <Layers className="mt-0.5 size-3.5 shrink-0 text-forest-600" />
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-forest-900">
                    Base imagery — Esri World Imagery and Esri World Street Map
                  </p>
                  <p className="text-[11px] text-forest-800/60">
                    Tiles are streamed from Esri; attribution is shown on the map.
                  </p>
                </div>
              </li>
            </ul>
          </Section>

          <Section title="What Ember does not do">
            <ul className="list-disc space-y-1 pl-4">
              <li>No burned-area estimate, no damage figure, no fire perimeter.</li>
              <li>No invented overlays, forecasts or mock records.</li>
              <li>No claim that a point is a confirmed forest fire.</li>
            </ul>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-forest-800/70">
        {title}
      </h3>
      <div className="text-[12.5px] leading-relaxed text-forest-800/80">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export default function Home() {
  const [windowDays, setWindowDays] = React.useState<WindowDays>(1);
  const [payload, setPayload] = React.useState<FiresPayload | null>(null);
  const [payloadDays, setPayloadDays] = React.useState<WindowDays | null>(null);
  const [status, setStatus] = React.useState<LoadStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastSuccessAt, setLastSuccessAt] = React.useState<number | null>(null);

  const [region, setRegion] = React.useState<RegionKey | "all">("all");
  const [query, setQuery] = React.useState("");
  const [confidence, setConfidence] = React.useState<Record<Confidence, boolean>>({
    low: true,
    nominal: true,
    high: true,
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [base, setBase] = React.useState<BaseLayer>("satellite");
  const [aboutOpen, setAboutOpen] = React.useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  const abortRef = React.useRef<AbortController | null>(null);
  const requestRef = React.useRef(0);

  /* ---- data loading ---------------------------------------------------- */

  const runFetch = React.useCallback(async (days: WindowDays) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRefreshing(true);
    setError(null);

    try {
      const response = await fetch(`/api/fires?days=${days}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        cache: "no-store",
      });

      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }

      if (!response.ok) {
        const message =
          extractErrorMessage(body) ??
          `The data service responded with HTTP ${response.status}.`;
        throw new Error(message);
      }

      const normalized = normalizePayload(body);
      if (!normalized) {
        throw new Error("The data service returned a response we could not read.");
      }
      if (requestId !== requestRef.current) return;

      setPayload(normalized);
      setPayloadDays(days);
      const fetchedMs = Date.parse(normalized.fetchedAt);
      setLastSuccessAt(Number.isFinite(fetchedMs) ? fetchedMs : Date.now());
      setStatus("ready");
      setError(null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (requestId !== requestRef.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Something went wrong while loading fire data.",
      );
      setStatus("error");
    } finally {
      if (requestId === requestRef.current) setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    setStatus((current) => (payloadDays === windowDays ? current : "loading"));
    void runFetch(windowDays);

    const timer = window.setInterval(() => {
      void runFetch(windowDays);
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays, runFetch]);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  /* ---- derived data ---------------------------------------------------- */

  const activePayload = payload && payloadDays === windowDays ? payload : null;

  const windowDetections = React.useMemo(() => {
    if (!activePayload) return [];
    const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
    const futureLimit = now + 30 * 60 * 1000;
    return activePayload.detections.filter((detection) => {
      const acquired = Date.parse(detection.acquiredAt);
      if (!Number.isFinite(acquired)) return false;
      return acquired >= cutoff && acquired <= futureLimit;
    });
  }, [activePayload, now, windowDays]);

  const scopedDetections = React.useMemo(() => {
    if (region === "all") return windowDetections;
    return windowDetections.filter((detection) => regionOf(detection) === region);
  }, [windowDetections, region]);

  const visibleDetections = React.useMemo(
    () => scopedDetections.filter((detection) => confidence[detection.confidence]),
    [scopedDetections, confidence],
  );

  const regionCounts = React.useMemo(() => {
    const counts = {} as Record<RegionKey, number>;
    for (const regionItem of REGIONS) counts[regionItem.key] = 0;
    for (const detection of windowDetections) {
      if (!confidence[detection.confidence]) continue;
      const key = regionOf(detection);
      if (key) counts[key] += 1;
    }
    return counts;
  }, [windowDetections, confidence]);

  const maxRegionCount = React.useMemo(
    () => Math.max(0, ...Object.values(regionCounts)),
    [regionCounts],
  );

  const outsideCount = React.useMemo(
    () =>
      windowDetections.filter(
        (detection) => confidence[detection.confidence] && regionOf(detection) === null,
      ).length,
    [windowDetections, confidence],
  );

  const highCount = React.useMemo(
    () => visibleDetections.filter((detection) => detection.confidence === "high").length,
    [visibleDetections],
  );

  const latestAcquiredAt = React.useMemo(() => {
    if (!activePayload || activePayload.detections.length === 0) return null;
    let latest = 0;
    for (const detection of activePayload.detections) {
      const acquired = Date.parse(detection.acquiredAt);
      if (Number.isFinite(acquired) && acquired > latest) latest = acquired;
    }
    return latest === 0 ? null : new Date(latest).toISOString();
  }, [activePayload]);

  const latestInWindow = React.useMemo(() => {
    if (visibleDetections.length === 0) return null;
    let latest = 0;
    for (const detection of visibleDetections) {
      const acquired = Date.parse(detection.acquiredAt);
      if (Number.isFinite(acquired) && acquired > latest) latest = acquired;
    }
    return latest === 0 ? null : new Date(latest).toISOString();
  }, [visibleDetections]);

  const selected = React.useMemo(
    () =>
      visibleDetections.find((detection) => detection.id === selectedId) ??
      null,
    [visibleDetections, selectedId],
  );

  const recent = React.useMemo(
    () =>
      [...visibleDetections]
        .sort((a, b) => Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt))
        .slice(0, 6),
    [visibleDetections],
  );

  const regionBounds = React.useMemo<LatLngBounds | null>(() => {
    if (region === "all") return null;
    const found = REGIONS.find((item) => item.key === region);
    return found ? found.bounds : null;
  }, [region]);

  /* ---- actions --------------------------------------------------------- */

  const handleSelect = React.useCallback(
    (detection: Detection) => {
      setSelectedId(detection.id);
      setMobilePanelOpen(false);
    },
    [],
  );

  const handleToggleConfidence = React.useCallback((level: Confidence) => {
    setConfidence((current) => {
      const next = { ...current, [level]: !current[level] };
      const enabled = (Object.keys(next) as Confidence[]).filter((key) => next[key]);
      if (enabled.length === 0) {
        // Never let the user filter everything out silently.
        return { ...current, [level]: true };
      }
      return next;
    });
  }, []);

  const handleExport = React.useCallback(() => {
    if (visibleDetections.length === 0) {
      toast.error("Nothing to export — the current filters match no detections.");
      return;
    }
    const header = [
      "detection_id",
      "acquired_at_utc",
      "satellite",
      "confidence",
      "latitude",
      "longitude",
      "brightness_kelvin",
      "frp_mw",
      "daynight",
    ];
    const lines = [header.join(",")];
    for (const detection of visibleDetections) {
      lines.push(
        [
          detection.id,
          detection.acquiredAt,
          detection.satellite,
          detection.confidence,
          detection.latitude.toFixed(4),
          detection.longitude.toFixed(4),
          detection.brightness === null ? "" : detection.brightness.toFixed(2),
          detection.frp === null ? "" : detection.frp.toFixed(2),
          detection.daynight,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const csv = `${lines.join("\r\n")}\r\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    anchor.href = url;
    anchor.download = `ember-thermal-anomalies-${region}-${windowDays}d-${stamp}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast.success(
      `Downloaded ${visibleDetections.length} thermal-anomaly record${visibleDetections.length === 1 ? "" : "s"} (not confirmed fires).`,
    );
  }, [visibleDetections, region, windowDays]);

  const handleRefresh = React.useCallback(() => {
    void runFetch(windowDays);
  }, [runFetch, windowDays]);

  const handleWindowChange = React.useCallback((days: WindowDays) => {
    setWindowDays(days);
  }, []);

  /* ---- empty / error copy ---------------------------------------------- */

  const emptyTitle = "No detections in this window";
  const emptyBody = latestAcquiredAt
    ? `Nothing was acquired in the last ${WINDOW_LABEL[windowDays].toLowerCase()}. The newest record in this feed is from ${formatStampUtc(latestAcquiredAt)} — that is normal when a satellite pass has not happened yet, and it does not mean there are no fires.`
    : `Nothing was acquired in the last ${WINDOW_LABEL[windowDays].toLowerCase()}.`;

  const sidebarProps: SidebarProps = {
    payload: activePayload,
    status,
    error,
    refreshing,
    lastSuccessAt,
    now,
    windowDays,
    region,
    onRegionChange: setRegion,
    query,
    onQueryChange: setQuery,
    confidence,
    onConfidenceToggle: handleToggleConfidence,
    regionCounts,
    maxRegionCount,
    outsideCount,
    visibleCount: visibleDetections.length,
    highCount,
    scopeCount: scopedDetections.length,
    latestAcquiredAt,
    latestInWindow,
    selected,
    onSelect: handleSelect,
    onClearSelection: () => setSelectedId(null),
    recent,
    onRefresh: handleRefresh,
    onExport: handleExport,
    onAbout: () => setAboutOpen(true),
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-[340px] shrink-0 border-r border-[color:var(--hairline)] lg:block">
        <SidebarPanel {...sidebarProps} />
      </aside>

      {/* Map */}
      <main className="relative min-w-0 flex-1">
        {/* Mobile header */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[850] flex items-center justify-between gap-3 px-3 py-3 lg:hidden">
          <div className="pointer-events-auto flex items-center gap-2.5 rounded-2xl border border-black/5 bg-[#fffdf8]/94 px-3 py-2 shadow-[0_18px_40px_-26px_rgba(20,38,30,0.9)] backdrop-blur-md">
            <div className="ember-mark size-8">
              <Flame className="size-4 text-ember-400" strokeWidth={2.1} />
            </div>
            <div>
              <p className="text-[13px] font-semibold leading-none tracking-[0.18em] text-forest-900">
                EMBER
              </p>
              <p className="mt-0.5 text-[10px] leading-none text-forest-700/65">
                Indonesia fire watch
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => setMobilePanelOpen(true)}
            className="pointer-events-auto gap-1.5 rounded-xl bg-forest-800 text-ivory-50 hover:bg-forest-700"
          >
            <Radio className="size-3.5" />
            Filters
            {visibleDetections.length > 0 ? (
              <span className="tnum ml-0.5 rounded-full bg-ember-500 px-1.5 text-[10px] font-semibold text-ivory-50">
                {visibleDetections.length}
              </span>
            ) : null}
          </Button>
        </div>

        <FireMap
          detections={visibleDetections}
          selectedId={selectedId}
          onSelect={handleSelect}
          regionBounds={regionBounds}
          base={base}
          onBaseChange={setBase}
          onResetExtent={() => setRegion("all")}
          status={status}
          errorMessage={error}
          onRetry={handleRefresh}
          refreshing={refreshing}
          windowDays={windowDays}
          onWindowChange={handleWindowChange}
          detectionTotal={visibleDetections.length}
          emptyTitle={emptyTitle}
          emptyBody={emptyBody}
          hasRetainedData={activePayload !== null}
        />
      </main>

      {/* Mobile filter panel */}
      <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
        <SheetContent
          side="left"
          className="w-[min(340px,88vw)] gap-0 border-r border-[color:var(--hairline)] bg-ivory-100 p-0 sm:max-w-[340px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Ember filters and metrics</SheetTitle>
            <SheetDescription>
              Region, confidence filters, live metrics and the selected hotspot.
            </SheetDescription>
          </SheetHeader>
          <SidebarPanel {...sidebarProps} />
        </SheetContent>
      </Sheet>

      <AboutDialog
        open={aboutOpen}
        onOpenChange={setAboutOpen}
        payload={activePayload ?? payload}
      />
    </div>
  );
}
