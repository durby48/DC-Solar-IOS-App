import type * as Leaflet from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { STAGE_COLOR, type MapPoint } from '@/lib/leadMap';
import { ZONE_METERS, zoneColor, type MapViewState, type StormLayers } from '@/lib/stormLayers';

/**
 * The Lead map on the WEB (2026-10-07; smoothed + storm zones 2026-10-09).
 *
 * BASEMAPS. Satellite (Esri World Imagery — panels visible at roof level) is
 * the default; Map is OpenStreetMap darkened with a CSS filter. The choice is
 * remembered per browser. Esri's place-name LABELS are their own layer, on by
 * default and shown only while zoomed out (≤ 15): past that Esri stops
 * drawing them and Leaflet used to stretch the last ones — huge, blurry,
 * jumping labels. `labels` turns them off entirely.
 *
 * SMOOTH (2026-10-09, Carson: "very glitchy navigating"). Everything vector
 * (pins, zones, report dots) draws on ONE canvas instead of hundreds of SVG
 * elements; pins are created once per data change and only RESTYLED when the
 * selection or the storm highlight changes (it used to wipe and redraw every
 * pin on every tap); the map zooms by itself only when asked (`focusKey` at
 * first load, `storms.fitKey` when a storm is picked) — never as a side
 * effect of another change; half-step zoom with a gentler mouse wheel.
 *
 * STORMS. Each report's 3-mile zone is a soft circle coloured by hail size
 * (wind: orange); overlapping circles blend into the storm's footprint. With a
 * storm picked, pins in its path get a white ring and the rest fade.
 *
 * Leaflet is IMPORTED IN THE BROWSER ONLY (the web build pre-renders on the
 * server, where Leaflet's `window` access throws) and draws into a plain
 * <div> (drawing into the React Native View measured a 0-wide box).
 */
const KANSAS_CITY: Leaflet.LatLngTuple = [39.0997, -94.5786];
const DARK_TILES_STYLE = 'dc-dark-tiles-style';
const BASEMAP_KEY = 'dcsolar.leadmap.basemap';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const LABELS_MAX_ZOOM = 15;

/** Satellite unless the person switched to Map. */
function rememberedBasemap(): 'Map' | 'Satellite' {
  try {
    return localStorage.getItem(BASEMAP_KEY) === 'Map' ? 'Map' : 'Satellite';
  } catch {
    return 'Satellite';
  }
}

/** On the web the map is always real. */
export const NATIVE_MAP = true;

function pinStyle(p: MapPoint, selected: boolean, highlight: Set<string> | null): Leaflet.CircleMarkerOptions {
  const inPath = highlight?.has(p.key) ?? false;
  const faded = highlight !== null && !inPath && !selected;
  return {
    radius: selected ? 11 : inPath ? 9 : 7,
    color: selected || inPath ? '#FFFFFF' : '#1E1C1A',
    weight: selected ? 3 : inPath ? 2.5 : 1.5,
    dashArray: p.approx ? '3 3' : undefined,
    fillColor: STAGE_COLOR[p.stage],
    fillOpacity: faded ? 0.2 : p.approx ? 0.55 : 0.95,
    opacity: faded ? 0.3 : 1,
  };
}

export function LeadMapView({
  points,
  selectedKey,
  onSelect,
  roof,
  focusKey,
  storms,
  labels = true,
  initialView = null,
  onViewChange,
}: {
  points: MapPoint[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Fly to this pin at roof level on Satellite; `n` changes on every request. */
  roof?: { key: string; n: number } | null;
  /** Start zoomed in on this pin, on Satellite (opened from a record's panel map). */
  focusKey?: string | null;
  storms?: StormLayers | null;
  /** Esri place-name labels over the satellite (zoomed out only). */
  labels?: boolean;
  /** Start exactly here (the full-screen map opening where the small one was). */
  initialView?: MapViewState | null;
  /** Reports where the map is looking after every move. */
  onViewChange?: (view: MapViewState) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [L, setL] = useState<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const canvas = useRef<Leaflet.Canvas | null>(null);
  const pinLayer = useRef<Leaflet.LayerGroup | null>(null);
  const pins = useRef(new Map<string, { marker: Leaflet.CircleMarker; point: MapPoint }>());
  const stormLayer = useRef<Leaflet.LayerGroup | null>(null);
  const radarLayer = useRef<Leaflet.TileLayer | null>(null);
  const labelLayer = useRef<Leaflet.TileLayer | null>(null);
  const basemaps = useRef<{ Map: Leaflet.Layer; Satellite: Leaflet.Layer } | null>(null);
  const firstView = useRef(false);
  const pendingView = useRef<(() => void) | null>(null);
  const lastFit = useRef<string | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const viewChange = useRef(onViewChange);
  viewChange.current = onViewChange;
  const latest = useRef({ selectedKey, highlight: storms?.highlight ?? null });
  latest.current = { selectedKey, highlight: storms?.highlight ?? null };

  useEffect(() => {
    let alive = true;
    void import('leaflet').then((mod) => {
      if (alive) setL(((mod as unknown as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** Run a view change now if the box has a size, else when it gets one. */
  const whenSized = (fn: () => void) => {
    const m = map.current;
    if (!m) return;
    m.invalidateSize();
    if (m.getSize().x > 0) fn();
    else pendingView.current = fn;
  };

  // The map itself — once.
  useEffect(() => {
    const el = host.current;
    if (!el || !L) return;
    const m = L.map(el, {
      zoomControl: true,
      preferCanvas: true,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 110,
      wheelDebounceTime: 30,
      maxZoom: 20,
    }).setView(initialView ? [initialView.lat, initialView.lng] : KANSAS_CITY, initialView?.zoom ?? 10);
    if (initialView) {
      // Opening where another map was: no automatic zoom on top of that.
      firstView.current = true;
      lastFit.current = storms?.fitKey ?? null;
    }
    m.on('moveend', () => {
      const c = m.getCenter();
      viewChange.current?.({ lat: c.lat, lng: c.lng, zoom: m.getZoom() });
    });
    canvas.current = L.canvas({ padding: 0.5, tolerance: 6 });
    if (!document.getElementById(DARK_TILES_STYLE)) {
      const style = document.createElement('style');
      style.id = DARK_TILES_STYLE;
      style.textContent =
        '.dc-dark-tiles { filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(85%) saturate(60%); }';
      document.head.appendChild(style);
    }
    const tileOpts = { keepBuffer: 4, updateWhenZooming: false };
    const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      ...tileOpts,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxNativeZoom: 19,
      maxZoom: 20,
      className: 'dc-dark-tiles',
    });
    const satellite = L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
      ...tileOpts,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
      maxNativeZoom: 19,
      maxZoom: 20,
    });
    labelLayer.current = L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
      ...tileOpts,
      maxZoom: LABELS_MAX_ZOOM,
      pane: 'overlayPane',
    });
    basemaps.current = { Map: street, Satellite: satellite };
    (focusKey || rememberedBasemap() === 'Satellite' ? satellite : street).addTo(m);
    L.control.layers({ Map: street, Satellite: satellite }, undefined, { position: 'topright' }).addTo(m);
    m.on('baselayerchange', (e: Leaflet.LayersControlEvent) => {
      try {
        localStorage.setItem(BASEMAP_KEY, e.name);
      } catch {
        // Private mode / blocked storage: forgetting the choice is fine.
      }
    });
    m.on('click', () => select.current(null));
    stormLayer.current = L.layerGroup().addTo(m);
    pinLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    const observer = new ResizeObserver(() => {
      m.invalidateSize();
      if (pendingView.current && m.getSize().x > 0) {
        const fn = pendingView.current;
        pendingView.current = null;
        fn();
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      pinLayer.current = null;
      stormLayer.current = null;
      radarLayer.current = null;
      labelLayer.current = null;
      basemaps.current = null;
      pins.current.clear();
      firstView.current = false;
      lastFit.current = null;
      pendingView.current = null;
    };
  }, [L]); // eslint-disable-line react-hooks/exhaustive-deps

  // Labels on / off.
  useEffect(() => {
    const m = map.current;
    const layer = labelLayer.current;
    if (!m || !layer) return;
    if (labels) layer.addTo(m);
    else m.removeLayer(layer);
  }, [L, labels]);

  // Pins: (re)built only when the points change.
  useEffect(() => {
    const m = map.current;
    const group = pinLayer.current;
    if (!m || !group || !L) return;
    group.clearLayers();
    pins.current.clear();
    const { selectedKey: sel, highlight } = latest.current;
    for (const p of points) {
      const marker = L.circleMarker([p.lat, p.lng], {
        renderer: canvas.current ?? undefined,
        ...pinStyle(p, p.key === sel, highlight),
      });
      marker.bindTooltip(p.name, { direction: 'top', offset: [0, -6] });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        select.current(p.key);
      });
      marker.addTo(group);
      pins.current.set(p.key, { marker, point: p });
    }
    if (!firstView.current && points.length > 0) {
      firstView.current = true;
      const focus = focusKey ? points.find((p) => p.key === focusKey) : undefined;
      if (focus) {
        whenSized(() => m.setView([focus.lat, focus.lng], 18));
      } else if (!storms?.fitKey) {
        const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as Leaflet.LatLngTuple));
        whenSized(() => m.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 }));
      }
    }
  }, [L, points]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selection / storm highlight: restyle in place, no redraw of the layer.
  useEffect(() => {
    const highlight = storms?.highlight ?? null;
    for (const { marker, point } of pins.current.values()) {
      marker.setStyle(pinStyle(point, point.key === selectedKey, highlight));
      if (point.key === selectedKey || highlight?.has(point.key)) marker.bringToFront();
    }
  }, [selectedKey, storms?.highlight]);

  // Storm zones, report dots, warnings, radar.
  useEffect(() => {
    const m = map.current;
    const g = stormLayer.current;
    if (!m || !g || !L) return;
    g.clearLayers();
    if (storms?.radar) {
      if (!radarLayer.current) {
        radarLayer.current = L.tileLayer(
          'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
          { opacity: 0.55, maxZoom: 20, maxNativeZoom: 16, attribution: 'Radar &copy; Iowa Environmental Mesonet' },
        );
      }
      radarLayer.current.addTo(m);
    } else if (radarLayer.current) {
      m.removeLayer(radarLayer.current);
    }
    for (const w of storms?.warnings ?? []) {
      L.polygon(w.rings, {
        color: w.tornado ? '#FF4D4D' : '#FFB020',
        weight: 2,
        fillOpacity: 0.1,
        renderer: canvas.current ?? undefined,
      })
        .bindTooltip(w.label)
        .addTo(g);
    }
    const reports = storms?.reports ?? [];
    for (const r of reports) {
      L.circle([r.lat, r.lng], {
        radius: ZONE_METERS,
        stroke: false,
        fillColor: zoneColor(r),
        fillOpacity: 0.16,
        interactive: false,
        renderer: canvas.current ?? undefined,
      }).addTo(g);
    }
    for (const r of reports) {
      L.circleMarker([r.lat, r.lng], {
        radius: r.kind === 'hail' ? 3 + Math.min(6, (r.size ?? 1) * 2) : 3.5,
        color: '#FFFFFF',
        weight: 1,
        fillColor: zoneColor(r),
        fillOpacity: 0.95,
        renderer: canvas.current ?? undefined,
      })
        .bindTooltip(r.label, { direction: 'top' })
        .addTo(g);
    }
    // Zoom to a storm only when a storm was just picked.
    const fitKey = storms?.fitKey ?? null;
    if (fitKey && fitKey !== lastFit.current && reports.length > 0) {
      lastFit.current = fitKey;
      firstView.current = true;
      const b = L.latLngBounds(reports.map((x) => [x.lat, x.lng] as Leaflet.LatLngTuple)).pad(0.25);
      whenSized(() => m.flyToBounds(b, { maxZoom: 13, duration: 0.8 }));
    }
    if (!fitKey) lastFit.current = null;
  }, [L, storms]); // eslint-disable-line react-hooks/exhaustive-deps

  // "See the roof": Satellite on, then fly to the pin at roof level.
  useEffect(() => {
    const m = map.current;
    const layers = basemaps.current;
    if (!roof || !m || !layers) return;
    const p = points.find((x) => x.key === roof.key);
    if (!p) return;
    if (!m.hasLayer(layers.Satellite)) {
      m.removeLayer(layers.Map);
      layers.Satellite.addTo(m);
      m.fire('baselayerchange', { name: 'Satellite', layer: layers.Satellite });
    }
    m.flyTo([p.lat, p.lng], 19, { duration: 1.2 });
  }, [roof]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, minHeight: 320, borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
      <div ref={host} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
    </View>
  );
}
