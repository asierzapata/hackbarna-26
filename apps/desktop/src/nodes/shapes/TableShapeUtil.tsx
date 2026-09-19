import * as React from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
} from "tldraw";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  brandForText,
  brandInitials,
  brandfetchImageUrl,
  faviconImageUrl,
} from "@/lib/brand-assets";
import { cn } from "@/lib/utils";
import type { CellValue } from "../schema";
import { NodeCard } from "./NodeCard";
import { tableShapeProps, type TableShape } from "./types";

function compareValues(a: CellValue, b: CellValue) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function displayValue(value: CellValue) {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function companyBrand(value: CellValue) {
  return typeof value === "string" ? brandForText(value) : null;
}

function CompanyLogo({ domain, name }: { domain: string; name: string }) {
  const brandfetchUrl = brandfetchImageUrl(domain);
  const [source, setSource] = React.useState<"brandfetch" | "favicon" | "initials">(
    brandfetchUrl ? "brandfetch" : "favicon",
  );

  React.useEffect(() => {
    setSource(brandfetchUrl ? "brandfetch" : "favicon");
  }, [brandfetchUrl, domain]);

  const faviconUrl = faviconImageUrl(domain);
  const imageUrl = source === "brandfetch" ? brandfetchUrl ?? faviconUrl : faviconUrl;
  const displayName = name || domain;

  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted"
      data-testid={`table-company-logo-${domain.replace(/\./g, "-")}`}
    >
      {source === "initials" ? (
        <span className="font-heading text-[10px] font-semibold text-muted-foreground">
          {brandInitials(displayName)}
        </span>
      ) : (
        <img
          className="size-full object-contain p-1"
          src={imageUrl}
          alt={`${displayName} logo`}
          draggable={false}
          onError={() =>
            setSource((current) =>
              current === "brandfetch" ? "favicon" : "initials",
            )
          }
        />
      )}
    </span>
  );
}

export class TableShapeUtil extends BaseBoxShapeUtil<TableShape> {
  static override type = "kan-table" as const;
  static override props = tableShapeProps;

  getDefaultProps(): TableShape["props"] {
    return {
      w: 480,
      h: 280,
      title: "Table",
      columns: ["Column"],
      rows: [],
      highlightRow: -1,
      sourceNote: "",
      sortBy: null,
      selectedRows: [],
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

  override getIndicatorPath(shape: TableShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: TableShape) {
    return `${shape.props.title}\n${shape.props.columns.join(", ")}`;
  }

  component(shape: TableShape) {
    const { columns, rows, sortBy, selectedRows, highlightRow } = shape.props;
    const viewRows = rows.map((row, originalIndex) => ({ row, originalIndex }));
    if (sortBy) {
      viewRows.sort((a, b) => {
        const result = compareValues(
          a.row[sortBy.column] ?? null,
          b.row[sortBy.column] ?? null,
        );
        return sortBy.dir === "asc" ? result : -result;
      });
    }
    const namedLogoColumn = columns.findIndex((column) =>
      /company|sponsor|partner|brand|name/i.test(column),
    );
    const logoColumnIndex = namedLogoColumn >= 0
      ? namedLogoColumn
      : rows.some((row) => companyBrand(row[0] ?? null))
        ? 0
        : -1;

    const update = (props: Partial<TableShape["props"]>) => {
      this.editor.updateShape({ id: shape.id, type: shape.type, props });
    };
    const cycleSort = (column: number) => {
      if (!sortBy || sortBy.column !== column) {
        update({ sortBy: { column, dir: "asc" } });
      } else if (sortBy.dir === "asc") {
        update({ sortBy: { column, dir: "desc" } });
      } else {
        update({ sortBy: null });
      }
    };
    const toggleRow = (index: number) => {
      update({
        selectedRows: selectedRows.includes(index)
          ? selectedRows.filter((item) => item !== index)
          : [...selectedRows, index],
      });
    };

    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="table"
          title={shape.props.title}
          description={shape.props.sourceNote || undefined}
          headerMeta={<span className="text-xs text-muted-foreground">{rows.length} rows</span>}
          contentClassName="px-0"
        >
          <ScrollArea className="min-h-0 flex-1">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column, index) => (
                    <TableHead key={`${column}-${index}`}>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="w-full justify-start px-0"
                        data-testid={`table-sort-${index}`}
                        onPointerDown={stopEventPropagation}
                        onClick={() => cycleSort(index)}
                      >
                        {column}
                        {sortBy?.column === index
                          ? sortBy.dir === "asc"
                            ? " ↑"
                            : " ↓"
                          : null}
                      </Button>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewRows.map(({ row, originalIndex }) => {
                  const selected = selectedRows.includes(originalIndex);
                  return (
                    <TableRow
                      key={originalIndex}
                      data-testid={`table-row-${originalIndex}`}
                      data-state={selected ? "selected" : undefined}
                      className={cn(
                        "h-12 cursor-pointer",
                        originalIndex === highlightRow && "bg-accent",
                        selected && "border-l-2 border-l-primary bg-primary/10",
                      )}
                      onPointerDown={stopEventPropagation}
                      onClick={() => toggleRow(originalIndex)}
                    >
                      {columns.map((_, cellIndex) => {
                        const value = row[cellIndex] ?? null;
                        const isLogoCell = cellIndex === logoColumnIndex;
                        const name = displayValue(value);
                        const brand = isLogoCell ? companyBrand(value) : null;

                        return (
                          <TableCell
                            key={cellIndex}
                            className={cn(isLogoCell ? "py-2" : "py-3")}
                          >
                            {brand ? (
                              <div className="flex min-w-0 items-center gap-2">
                                <CompanyLogo domain={brand.domain} name={name} />
                                <span className="truncate">{name}</span>
                              </div>
                            ) : (
                              name
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        </NodeCard>
      </HTMLContainer>
    );
  }
}
