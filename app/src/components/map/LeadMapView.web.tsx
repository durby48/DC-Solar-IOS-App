import type * as Leaflet from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { STAGE_COLOR, type MapPoint } from '@/lib/leadMap';

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
 * Leaflet draws into a plain <div> filling a View. Leaflet is IMPORTED IN THE
 * BROWSER ONLY (in the effect):
 * the web build pre-renders pages on the server, where Leaflet's top-level
 * `window` access throws "window is not defined".
 */
const KANSAS_CITY: Leaflet.LatLngTuple = [39.0997, -94.5786];
const DARK_TILES_STYLE = 'dc-dark-tiles-style';

export function LeadMapView({
  points,
  selectedKey,
  onSelect,
}: {
  points: MapPoint[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [L, setL] = useState<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const fitted = useRef(false);
  // Bounds waiting for the box to have a real size (see the ResizeObserver).
  const pendingFit = useRef<Leaflet.LatLngBounds | null>(null);
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
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      className: 'dc-dark-tiles',
    }).addTo(m);
    m.on('click', () => select.current(null));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // Leaflet measures its box once; on the web the box can still be 0 wide
    // when the map is created (it was, in testing). Re-measure on every size
    // change, and do the first fit-to-pins once there is a real width.
    const observer = new ResizeObserver(() => {
      m.invalidateSize();
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
      fitted.current = false;
      pendingFit.current = null;
    };
  }, [L]);

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
    if (!fitted.current && points.length > 0) {
      fitted.current = true;
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as Leaflet.LatLngTuple));
      m.invalidateSize();
      if (m.getSize().x > 0) m.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
      else pendingFit.current = bounds; // the ResizeObserver fits it
    }
  }, [L, points, selectedKey]);

  // A plain <div>, absolutely filling the View: drawing into the React Native
  // View itself left Leaflet measuring a 0-wide box.
  return (
    <View style={{ flex: 1, minHeight: 320, borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
      <div ref={host} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
    </View>
  );
}
