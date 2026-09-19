import * as React from "react";
import { BaseBoxShapeUtil, HTMLContainer } from "tldraw";

import {
  brandInitials,
  brandfetchImageUrl,
  faviconImageUrl,
} from "@/lib/brand-assets";
import { logoShapeProps, type LogoShape } from "./types";

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
    const brandfetchUrl = brandfetchImageUrl(shape.props.domain);
    const [source, setSource] = React.useState<"brandfetch" | "favicon" | "initials">(
      brandfetchUrl ? "brandfetch" : "favicon",
    );

    React.useEffect(() => {
      setSource(brandfetchUrl ? "brandfetch" : "favicon");
    }, [brandfetchUrl, shape.props.domain]);

    const faviconUrl = faviconImageUrl(shape.props.domain);
    const imageUrl = source === "brandfetch" ? brandfetchUrl ?? faviconUrl : faviconUrl;
    const displayName = shape.props.name || shape.props.domain;

    return (
      <HTMLContainer style={{ pointerEvents: "none" }}>
        <div
          data-testid="logo-body"
          className="flex size-full flex-col bg-transparent"
        >
          {source === "initials" ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted font-heading text-3xl text-muted-foreground">
              {brandInitials(displayName)}
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
