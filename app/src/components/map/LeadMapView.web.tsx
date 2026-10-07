import type * as Leaflet from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { STAGE_COLOR, type MapPoint } from '@/lib/leadMap';
import { type StormLayers } from '@/lib/stormLayers';

/**
 * The Lead map on the WEB (2026-10-07): Leaflet over OpenStreetMap's own
 * tiles (no key; a few staff viewing it is well inside the OSM tile usage
 * policy, with the attribution shown), darkened with a CSS filter to sit in
 * the app's dark palette. CARTO's free basemaps now answer "API key required",
 * so they are not used. One coloured dot per
 * person, dashed and faded when the address only placed to the street / ZIP.
 * Tapping a dot selects it; the screen shows the card. The phone build gets
 * its own map in the next native build (LeadMapView.tsx explains).
 *
 * SATELLITE (2026-10-07): a Map / Satellite switch (Leaflet's layer control,
 * top right; the choice is remembered per browser). Satellite is Esri World
 * Imagery — sharp enough at zoom 19 to see panels on a roof — with Esri's
 * place-name labels on top. Esri's keyless tiles are fine for trying it; for
 * steady commercial use Esri asks for a (free) ArcGIS developer account, whose
 * key would go on these URLs. `roof` (from the card's "See the roof") switches
 * to Satellite and flies to that pin at roof level.
 *
 * Leaflet draws into a plain <div> filling a View. Leaflet is IMPORTED IN THE
 * BROWSER ONLY (in the effect):
 * the web build pre-renders pages on the server, where Leaflet's top-level
 * `window` access throws "window is not defined".
 */
const KANSAS_CITY: Leaflet.LatLngTuple = [39.0997, -94.5786];
const DARK_TILES_STYLE = 'dc-dark-tiles-style';
const BASEMAP_KEY = 'dcsolar.leadmap.basemap';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

/** Satellite unless the person switched to Map (2026-10-09: satellite first, to see panels). */
function rememberedBasemap(): 'Map' | 'Satellite' {
  try {
    return localStorage.getItem(BASEMAP_KEY) === 'Map' ? 'Map' : 'Satellite';
  } catch {
    return 'Satellite';
  }
}

/** On a native build the map is real (react-native-maps); here it always is. */
export const NATIVE_MAP = true;

export function LeadMapView({
  points,
  selectedKey,
  onSelect,
  roof,
  focusKey,
  storms,
}: {
  points: MapPoint[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Fly to this pin at roof level on Satellite; `n` changes on every request. */
  roof?: { key: string; n: number } | null;
  /** Start zoomed in on this pin, on Satellite (opened from a record's panel map). */
  focusKey?: string | null;
  /** Storm coverage (2026-10-09): radar, NWS warnings, hail / wind reports. */
  storms?: StormLayers | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [L, setL] = useState<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const fitted = useRef(false);
  // Bounds waiting for the box to have a real size (see the ResizeObserver).
  const pendingFit = useRef<Leaflet.LatLngBounds | null>(null);
  const pendingCenter = useRef<Leaflet.LatLngTuple | null>(null);
  const basemaps = useRef<{ Map: Leaflet.Layer; Satellite: Leaflet.Layer } | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    let alive = true;
    void import('leaflet').then((mod) => {
      if (alive) setL(((mod as unknown as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || !L) return;
    const m = L.map(el, { zoomControl: true }).setView(KANSAS_CITY, 10);
    if (!document.getElementById(DARK_TILES_STYLE)) {
      const style = document.createElement('style');
      style.id = DARK_TILES_STYLE;
      style.textContent =
        '.dc-dark-tiles { filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(85%) saturate(60%); }';
      document.head.appendChild(style);
    }
    const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      className: 'dc-dark-tiles',
    });
    const satellite = L.layerGroup([
      L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
        maxZoom: 19,
      }),
      L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19 }),
    ]);
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
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // Leaflet measures its box once; on the web the box can still be 0 wide
    // when the map is created (it was, in testing). Re-measure on every size
    // change, and do the first fit-to-pins once there is a real width.
    const observer = new ResizeObserver(() => {
      m.invalidateSize();
      if (pendingCenter.current && m.getSize().x > 0) {
        m.setView(pendingCenter.current, 18);
        pendingCenter.current = null;
      }
      if (pendingFit.current && m.getSize().x > 0) {
        m.fitBounds(pendingFit.current, { padding: [30, 30], maxZoom: 13 });
        pendingFit.current = null;
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      layer.current = null;
      basemaps.current = null;
      fitted.current = false;
      pendingFit.current = null;
      pendingCenter.current = null;
    };
  }, [L]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group || !L) return;
    group.clearLayers();
    for (const p of points) {
      const selected = p.key === selectedKey;
      const dot = L.circleMarker([p.lat, p.lng], {
        radius: selected ? 11 : 7,
        color: selected ? '#FFFFFF' : '#1E1C1A',
        weight: selected ? 3 : 1.5,
        dashArray: p.approx ? '3 3' : undefined,
        fillColor: STAGE_COLOR[p.stage],
        fillOpacity: p.approx ? 0.55 : 0.95,
      });
      dot.bindTooltip(p.name, { direction: 'top', offset: [0, -6] });
      dot.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        select.current(p.key);
      });
      dot.addTo(group);
    }
    const focus = focusKey ? points.find((p) => p.key === focusKey) : undefined;
    if (!fitted.current && focus) {
      // Opened from a record: start on it at roof level; the rest still show.
      fitted.current = true;
      const center: Leaflet.LatLngTuple = [focus.lat, focus.lng];
      m.invalidateSize();
      if (m.getSize().x > 0) m.setView(center, 18);
      else pendingCenter.current = center;
    }
    if (!fitted.current && points.length > 0) {
      fitted.current = true;
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as Leaflet.LatLngTuple));
      m.invalidateSize();
      if (m.getSize().x > 0) m.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
      else pendingFit.current = bounds; // the ResizeObserver fits it
    }
  }, [L, points, selectedKey, focusKey]);

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

  // Storms (2026-10-09): live radar tiles (Iowa Environmental Mesonet's NEXRAD
  // mosaic), active NWS severe-thunderstorm / tornado warnings, and NOAA
  // hail / wind reports sized by hail size. Fits to the reports when asked.
  const stormGroup = useRef<Leaflet.LayerGroup | null>(null);
  const radarLayer = useRef<Leaflet.TileLayer | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!m || !L) return;
    if (!stormGroup.current) stormGroup.current = L.layerGroup().addTo(m);
    const g = stormGroup.current;
    g.clearLayers();
    if (storms?.radar) {
      if (!radarLayer.current) {
        radarLayer.current = L.tileLayer(
          'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
          { opacity: 0.6, maxZoom: 19, attribution: 'Radar &copy; Iowa Environmental Mesonet' },
        );
      }
      radarLayer.current.addTo(m);
    } else if (radarLayer.current) {
      m.removeLayer(radarLayer.current);
    }
    for (const w of storms?.warnings ?? []) {
      L.polygon(w.rings, { color: w.tornado ? '#FF4D4D' : '#FFB020', weight: 2, fillOpacity: 0.12 })
        .bindTooltip(w.label)
        .addTo(g);
    }
    for (const r of storms?.reports ?? []) {
      const hail = r.kind === 'hail';
      const radius = hail ? 4 + Math.min(10, (r.size ?? 1) * 3) : 4;
      L.circleMarker([r.lat, r.lng], {
        radius,
        color: hail ? '#BFE3FF' : '#FFB020',
        weight: 1.5,
        fillColor: hail ? '#3FA9F5' : '#FF8C1A',
        fillOpacity: 0.55,
      })
        .bindTooltip(r.label, { direction: 'top' })
        .addTo(g);
    }
    if (storms?.fitTo && storms.fitTo.length > 0) {
      const b = L.latLngBounds(storms.fitTo.map((x) => [x.lat, x.lng] as Leaflet.LatLngTuple));
      m.invalidateSize();
      if (m.getSize().x > 0) m.fitBounds(b.pad(0.4), { maxZoom: 13 });
      else pendingFit.current = b.pad(0.4);
      fitted.current = true;
    }
  }, [L, storms]);

  // A plain <div>, absolutely filling the View: drawing into the React Native
  // View itself left Leaflet measuring a 0-wide box.
  return (
    <View style={{ flex: 1, minHeight: 320, borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
      <div ref={host} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
    </View>
  );
}
