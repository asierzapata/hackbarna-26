import * as React from "react";
import { BaseBoxShapeUtil, HTMLContainer } from "tldraw";

import { config } from "@/lib/config";
import { logoShapeProps, type LogoShape } from "./types";

function initials(name: string) {
  return name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
}

export class LogoShapeUtil extends BaseBoxShapeUtil<LogoShape> {
  static override type = "kan-logo" as const;
  static override props = logoShapeProps;

  getDefaultProps(): LogoShape["props"] {
    return {
      w: 160,
      h: 160,
      domain: "example.com",
      name: "",
      note: "",
    };
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return true;
  }

  override isAspectRatioLocked() {
    return true;
  }

  override getIndicatorPath(shape: LogoShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  override getText(shape: LogoShape) {
    return `${shape.props.name}\n${shape.props.domain}`;
  }

  component(shape: LogoShape) {
    const hasBrandfetch = Boolean(config.brandfetchClientId);
    const [source, setSource] = React.useState<"brandfetch" | "favicon" | "initials">(
      hasBrandfetch ? "brandfetch" : "favicon",
    );

    React.useEffect(() => {
      setSource(hasBrandfetch ? "brandfetch" : "favicon");
    }, [hasBrandfetch, shape.props.domain]);

    const brandfetchUrl = config.brandfetchClientId
      ? `https://cdn.brandfetch.io/domain/${shape.props.domain}/w/512/h/512/fallback/lettermark?c=${encodeURIComponent(config.brandfetchClientId)}`
      : "";
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(shape.props.domain)}&sz=128`;
    const imageUrl = source === "brandfetch" ? brandfetchUrl : faviconUrl;
    const displayName = shape.props.name || shape.props.domain;

    return (
      <HTMLContainer style={{ pointerEvents: "none" }}>
        <div
          data-testid="logo-body"
          className="flex size-full flex-col bg-transparent"
        >
          {source === "initials" ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted font-heading text-3xl text-muted-foreground">
              {initials(displayName)}
            </div>
          ) : (
            <img
              className="min-h-0 w-full flex-1 object-contain"
              src={imageUrl}
              alt={`${displayName} logo`}
              data-testid="logo-image"
              draggable={false}
              onError={() =>
                setSource((current) =>
                  current === "brandfetch" ? "favicon" : "initials",
                )
              }
            />
          )}
          {shape.props.name ? (
            <span className="truncate text-center text-xs text-muted-foreground">
              {shape.props.name}
            </span>
          ) : null}
        </div>
      </HTMLContainer>
    );
  }
}
