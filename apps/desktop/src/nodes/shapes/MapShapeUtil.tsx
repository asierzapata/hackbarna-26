import * as React from "react";
import * as maptilersdk from "@maptiler/sdk";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  useValue,
} from "tldraw";

import { Badge } from "@/components/ui/badge";
import {
  brandForText,
  brandInitials,
  brandfetchImageUrl,
  faviconImageUrl,
} from "@/lib/brand-assets";
import { config } from "@/lib/config";
import { NodeCard } from "./NodeCard";
import {
  mapShapeProps,
  type MapMarker,
  type MapNodeStyle,
  type MapShape,
} from "./types";

const DEMO_STYLE = "https://demotiles.maplibre.org/style.json";
const CENTER_EPSILON = 0.00001;
const ZOOM_EPSILON = 0.01;
const MAP_ZOOM_STEP = 0.1;

function mapStyleFor(style: MapNodeStyle) {
  switch (style) {
    case "streets":
      return maptilersdk.MapStyle.STREETS;
    case "aquarelle":
      return maptilersdk.MapStyle.AQUARELLE;
    case "light":
      return maptilersdk.MapStyle.BASE.LIGHT;
    case "dark":
      return maptilersdk.MapStyle.STREETS.DARK;
    case "satellite":
      return maptilersdk.MapStyle.SATELLITE;
    case "outdoor":
      return maptilersdk.MapStyle.OUTDOOR;
  }
}

function viewDiffers(
  map: maptilersdk.Map,
  center: { lat: number; lng: number },
  zoom: number,
) {
  const current = map.getCenter();
  return (
    Math.abs(current.lat - center.lat) > CENTER_EPSILON ||
    Math.abs(current.lng - center.lng) > CENTER_EPSILON ||
    Math.abs(map.getZoom() - zoom) > ZOOM_EPSILON
  );
}

function createBrandMarkerElement(markerData: MapMarker, selected: boolean) {
  const brand = brandForText(`${markerData.label} ${markerData.note ?? ""}`);
  if (!brand) return null;

  const element = document.createElement("button");
  element.type = "button";
  element.className = [
    "flex cursor-pointer items-center justify-center",
    selected ? "size-12" : "size-10",
  ].join(" ");
  element.setAttribute("aria-label", `${markerData.label} marker`);
  element.title = markerData.label;

  const image = document.createElement("img");
  image.className = "size-full object-contain";
  image.alt = `${brand.name} logo`;
  image.draggable = false;

  const fallback = document.createElement("span");
  fallback.className = "font-heading text-[10px] font-semibold text-muted-foreground";
  fallback.textContent = brandInitials(brand.name);

  const brandfetchUrl = brandfetchImageUrl(brand.domain);
  const faviconUrl = faviconImageUrl(brand.domain);
  let source: "brandfetch" | "favicon" = brandfetchUrl ? "brandfetch" : "favicon";
  image.addEventListener("error", () => {
    if (source === "brandfetch") {
      source = "favicon";
      image.src = faviconUrl;
      return;
    }
    image.remove();
    element.append(fallback);
  });
  image.src = brandfetchUrl ?? faviconUrl;
  element.append(image);

  return element;
}

export class MapShapeUtil extends BaseBoxShapeUtil<MapShape> {
  static override type = "kan-map" as const;
  static override props = mapShapeProps;

  getDefaultProps(): MapShape["props"] {
    return {
      w: 480,
      h: 360,
      title: "Map",
      markers: [{ lat: 41.387, lng: 2.1701, label: "Barcelona" }],
      center: null,
      zoom: null,
      style: "aquarelle",
      selectedMarker: -1,
    };
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return true;
  }

  override canScroll() {
    return true;
  }

  override isAspectRatioLocked() {
    return false;
  }

  override getIndicatorPath(shape: MapShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: MapShape) {
    return `${shape.props.title}\n${shape.props.markers.map(({ label }) => label).join("\n")}`;
  }

  component(shape: MapShape) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const mapRef = React.useRef<maptilersdk.Map | null>(null);
    const markerRefs = React.useRef<maptilersdk.Marker[]>([]);
    const resizeObserverRef = React.useRef<ResizeObserver | null>(null);
    const moveTimerRef = React.useRef<number | null>(null);
    const applyingPropsRef = React.useRef(false);
    const appliedStyleRef = React.useRef(shape.props.style);
    const dragPointRef = React.useRef<{ x: number; y: number } | null>(null);
    const latestShapeRef = React.useRef(shape);
    latestShapeRef.current = shape;
    const canvasZoom = useValue(
      "canvas zoom for map resize",
      () => this.editor.getZoomLevel(),
      [this.editor],
    );
    const hasMaptilerKey = Boolean(config.maptilerKey);

    React.useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      if (config.maptilerKey) maptilersdk.config.apiKey = config.maptilerKey;

      const firstMarker = latestShapeRef.current.props.markers[0];
      const map = new maptilersdk.Map({
        container,
        style: config.maptilerKey
          ? mapStyleFor(latestShapeRef.current.props.style)
          : DEMO_STYLE,
        apiKey: config.maptilerKey,
        center: latestShapeRef.current.props.center
          ? [
              latestShapeRef.current.props.center.lng,
              latestShapeRef.current.props.center.lat,
            ]
          : [firstMarker.lng, firstMarker.lat],
        zoom: latestShapeRef.current.props.zoom ?? 12,
        navigationControl: false,
        geolocateControl: false,
        attributionControl: { compact: true },
        dragPan: false,
        scrollZoom: false,
      });
      mapRef.current = map;

      const fitInitialView = () => {
        const props = latestShapeRef.current.props;
        if (props.center && props.zoom !== null) return;
        applyingPropsRef.current = true;
        if (props.markers.length === 1) {
          map.setCenter([props.markers[0].lng, props.markers[0].lat]);
          map.setZoom(12);
        } else {
          const bounds = new maptilersdk.LngLatBounds();
          props.markers.forEach(({ lng, lat }) => bounds.extend([lng, lat]));
          map.fitBounds(bounds, { padding: 40, maxZoom: 14, animate: false });
        }
      };
      map.on("load", fitInitialView);

      const syncView = () => {
        if (!map.loaded()) return;
        if (applyingPropsRef.current) {
          applyingPropsRef.current = false;
          return;
        }
        if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
        moveTimerRef.current = window.setTimeout(() => {
          const currentShape = latestShapeRef.current;
          const center = map.getCenter();
          const zoom = map.getZoom();
          const storedCenter = currentShape.props.center;
          if (
            !storedCenter ||
            Math.abs(center.lat - storedCenter.lat) > CENTER_EPSILON ||
            Math.abs(center.lng - storedCenter.lng) > CENTER_EPSILON ||
            currentShape.props.zoom === null ||
            Math.abs(zoom - currentShape.props.zoom) > ZOOM_EPSILON
          ) {
            this.editor.updateShape({
              id: currentShape.id,
              type: currentShape.type,
              props: {
                center: { lat: center.lat, lng: center.lng },
                zoom,
              },
            });
          }
        }, 500);
      };
      map.on("moveend", syncView);

      const observer = new ResizeObserver(() => map.resize());
      observer.observe(container);
      resizeObserverRef.current = observer;

      return () => {
        if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
        observer.disconnect();
        resizeObserverRef.current = null;
        markerRefs.current.forEach((marker) => marker.remove());
        markerRefs.current = [];
        map.remove();
        mapRef.current = null;
      };
    }, []);

    React.useEffect(() => {
      mapRef.current?.resize();
    }, [canvasZoom, shape.props.w, shape.props.h]);

    React.useEffect(() => {
      const map = mapRef.current;
      if (
        !map ||
        !hasMaptilerKey ||
        appliedStyleRef.current === shape.props.style
      ) return;
      appliedStyleRef.current = shape.props.style;
      map.setStyle(mapStyleFor(shape.props.style));
    }, [hasMaptilerKey, shape.props.style]);

    React.useEffect(() => {
      const map = mapRef.current;
      if (!map || !shape.props.center || shape.props.zoom === null) return;
      if (viewDiffers(map, shape.props.center, shape.props.zoom)) {
        applyingPropsRef.current = true;
        map.jumpTo({
          center: [shape.props.center.lng, shape.props.center.lat],
          zoom: shape.props.zoom,
        });
      }
    }, [shape.props.center, shape.props.zoom]);

    React.useEffect(() => {
      const map = mapRef.current;
      if (!map) return;
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current = [];
      const styles = getComputedStyle(document.documentElement);
      const primary = styles.getPropertyValue("--primary").trim();
      const selected = styles.getPropertyValue("--agent").trim();

      markerRefs.current = shape.props.markers.map((markerData, index) => {
        const customElement = createBrandMarkerElement(
          markerData,
          index === shape.props.selectedMarker,
        );
        const marker = new maptilersdk.Marker(
          customElement
            ? { element: customElement, anchor: "bottom" }
            : {
                color: index === shape.props.selectedMarker ? selected : primary,
                scale: index === shape.props.selectedMarker ? 1.2 : 0.9,
              },
        )
          .setLngLat([markerData.lng, markerData.lat])
          .addTo(map);
        marker.getElement().dataset.testid = `map-marker-${index}`;
        marker.getElement().addEventListener("click", (event) => {
          event.stopPropagation();
          this.editor.updateShape({
            id: shape.id,
            type: shape.type,
            props: { selectedMarker: index },
          });
        });
        const popupContent = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = markerData.label;
        popupContent.append(label);
        if (markerData.note) {
          const note = document.createElement("div");
          note.textContent = markerData.note;
          popupContent.append(note);
        }
        marker.setPopup(
          new maptilersdk.Popup({ offset: 24 }).setDOMContent(popupContent),
        );
        return marker;
      });
    }, [shape.id, shape.props.markers, shape.props.selectedMarker, shape.type]);

    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="map"
          title={shape.props.title}
          headerMeta={
            !hasMaptilerKey ? <Badge variant="outline">demo tiles</Badge> : undefined
          }
          contentClassName="px-0"
          footer={
            <div className="flex w-full items-center justify-between gap-2">
              <span>{shape.props.markers.length} places</span>
              <span>© MapTiler © OpenStreetMap</span>
            </div>
          }
        >
          <div
            ref={containerRef}
            data-testid="map-canvas"
            className="min-h-0 flex-1"
            onPointerDown={(event) => {
              stopEventPropagation(event);
              applyingPropsRef.current = false;
              dragPointRef.current = { x: event.clientX, y: event.clientY };
              if (event.nativeEvent.isTrusted) {
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            }}
            onPointerMove={(event) => {
              if (!dragPointRef.current || !mapRef.current) return;
              const dx = (event.clientX - dragPointRef.current.x) / canvasZoom;
              const dy = (event.clientY - dragPointRef.current.y) / canvasZoom;
              dragPointRef.current = { x: event.clientX, y: event.clientY };
              mapRef.current.panBy([-dx, -dy], { animate: false });
            }}
            onPointerUp={(event) => {
              dragPointRef.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              const map = mapRef.current;
              if (!map) return;
              if (moveTimerRef.current !== null) {
                window.clearTimeout(moveTimerRef.current);
              }
              moveTimerRef.current = window.setTimeout(() => {
                const center = map.getCenter();
                this.editor.updateShape({
                  id: shape.id,
                  type: shape.type,
                  props: {
                    center: { lat: center.lat, lng: center.lng },
                    zoom: map.getZoom(),
                  },
                });
              }, 500);
            }}
            onPointerCancel={() => {
              dragPointRef.current = null;
            }}
            onWheelCapture={(event) => {
              event.stopPropagation();
              event.preventDefault();
              const map = mapRef.current;
              if (!map) return;
              applyingPropsRef.current = false;
              const zoom = Math.min(
                22,
                Math.max(
                  0,
                  map.getZoom() +
                    (event.deltaY < 0 ? MAP_ZOOM_STEP : -MAP_ZOOM_STEP),
                ),
              );
              map.zoomTo(zoom, { duration: 0 });
              if (moveTimerRef.current !== null) {
                window.clearTimeout(moveTimerRef.current);
              }
              moveTimerRef.current = window.setTimeout(() => {
                const center = map.getCenter();
                this.editor.updateShape({
                  id: shape.id,
                  type: shape.type,
                  props: {
                    center: { lat: center.lat, lng: center.lng },
                    zoom: map.getZoom(),
                  },
                });
              }, 500);
            }}
          />
        </NodeCard>
      </HTMLContainer>
    );
  }
}
