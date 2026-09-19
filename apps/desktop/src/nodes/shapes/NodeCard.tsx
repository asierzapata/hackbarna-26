import type { ReactNode } from "react";
import {
  RiBarChartLine,
  RiBuilding2Line,
  RiCalendarLine,
  RiFileTextLine,
  RiImageLine,
  RiMap2Line,
  RiTable2,
  RiTimelineView,
} from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NodeType } from "../schema";

const typeIcons = {
  markdown: RiFileTextLine,
  chart: RiBarChartLine,
  table: RiTable2,
  image: RiImageLine,
  map: RiMap2Line,
  logo: RiBuilding2Line,
  timeline: RiTimelineView,
  calendar: RiCalendarLine,
};

export function NodeCard({
  type,
  title,
  description,
  headerMeta,
  children,
  footer,
  className,
  contentClassName,
}: {
  type: Exclude<NodeType, "geo">;
  title: ReactNode;
  description?: ReactNode;
  headerMeta?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const Icon = typeIcons[type];

  return (
    <Card
      size="sm"
      data-node-type={type}
      className={cn("kan-node size-full overflow-hidden text-sm font-sans", className)}
    >
      <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-2 border-b">
        <div className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden="true" />
          <CardTitle className="truncate">{title}</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          {headerMeta}
          <Badge variant="outline" data-node-badge>{type}</Badge>
        </div>
        {description ? (
          <CardDescription
            className="col-span-2 truncate"
            title={typeof description === "string" ? description : undefined}
          >
            {description}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent
        className={cn("flex min-h-0 flex-1 flex-col", contentClassName)}
      >
        {children}
      </CardContent>
      {footer ? (
        <CardFooter className="min-h-8 gap-2 py-2 text-xs text-muted-foreground">
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  );
}
