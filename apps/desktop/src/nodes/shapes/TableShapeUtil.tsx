import * as React from "react";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  type Editor,
} from "tldraw";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

function parseEditedCellValue(text: string, previous: CellValue): CellValue {
  if (previous === null && text === "") return null;
  if (typeof previous === "number" && text.trim()) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  if (typeof previous === "boolean") {
    const normalized = text.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "no") return false;
  }
  return text;
}

type EditableTextProps = {
  value: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  dataTestId?: string;
};

function EditableText({
  value,
  ariaLabel,
  onCommit,
  placeholder,
  className,
  dataTestId,
}: EditableTextProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const editingRef = React.useRef(false);
  const cancelledRef = React.useRef(false);

  const startEditing = () => {
    cancelledRef.current = false;
    editingRef.current = true;
    setDraft(value);
    setEditing(true);
  };
  const finishEditing = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const cancelled = cancelledRef.current;
    cancelledRef.current = false;
    setEditing(false);
    if (!cancelled && draft !== value) onCommit(draft);
  };
  const cancelEditing = () => {
    cancelledRef.current = true;
    editingRef.current = false;
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={ariaLabel}
        data-testid={dataTestId}
        value={draft}
        placeholder={placeholder}
        className={cn(
          "box-border h-7 max-w-full min-w-0 rounded-sm border-primary/40 bg-background px-2 shadow-sm focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20",
          className,
        )}
        onPointerDown={stopEventPropagation}
        onClick={stopEventPropagation}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          stopEventPropagation(event);
          if (event.key === "Enter") {
            event.preventDefault();
            finishEditing();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelEditing();
          }
        }}
        onBlur={finishEditing}
        onFocus={(event) => event.currentTarget.select()}
      />
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      title="Double-click to edit"
      className={cn(
        "box-border block h-7 min-w-8 max-w-full cursor-text truncate rounded-sm px-2 py-1 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        className,
      )}
      onDoubleClick={(event) => {
        stopEventPropagation(event);
        startEditing();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        stopEventPropagation(event);
        startEditing();
      }}
    >
      {value || placeholder}
    </span>
  );
}

const SHORT_TABLE_ROW_LIMIT = 10;
const TABLE_MIN_HEIGHT = 280;
const TABLE_HEADER_HEIGHT = 40;
const TABLE_ROW_HEIGHT = 48;
const TABLE_CHROME_HEIGHT = 96;

function tableHeightForRows(rowCount: number) {
  return Math.max(
    TABLE_MIN_HEIGHT,
    TABLE_CHROME_HEIGHT +
      TABLE_HEADER_HEIGHT +
      Math.max(rowCount, 1) * TABLE_ROW_HEIGHT,
  );
}

function TableHeightSync({ editor, shape }: { editor: Editor; shape: TableShape }) {
  const rowCount = shape.props.rows.length;
  const lastHeightRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (rowCount >= SHORT_TABLE_ROW_LIMIT) return;
    const nextHeight = tableHeightForRows(rowCount);
    if (shape.props.h >= nextHeight || lastHeightRef.current === nextHeight) return;
    lastHeightRef.current = nextHeight;
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: { h: nextHeight },
    });
  }, [editor, rowCount, shape.id, shape.props.h, shape.type]);

  return null;
}

function TableViewport({
  scroll,
  children,
}: {
  scroll: boolean;
  children: React.ReactNode;
}) {
  return scroll ? (
    <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>
  ) : (
    <div className="min-h-0 flex-1 overflow-visible">{children}</div>
  );
}

function CompanyLogo({ domain, name }: { domain: string; name: string }) {
  const brandfetchUrl = brandfetchImageUrl(domain);
  const [source, setSource] = React.useState<
    "brandfetch" | "favicon" | "initials"
  >(brandfetchUrl ? "brandfetch" : "favicon");

  React.useEffect(() => {
    setSource(brandfetchUrl ? "brandfetch" : "favicon");
  }, [brandfetchUrl, domain]);

  const faviconUrl = faviconImageUrl(domain);
  const imageUrl =
    source === "brandfetch" ? (brandfetchUrl ?? faviconUrl) : faviconUrl;
  const displayName = name || domain;

  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted"
      data-testid={`table-company-logo-${domain.replace(/\./g, "-")}`}
    >
      {source === "initials" ? (
        <span className="font-heading text-xs font-semibold text-muted-foreground">
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
    const logoColumnIndex =
      namedLogoColumn >= 0
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
        <TableHeightSync editor={this.editor} shape={shape} />
        <NodeCard
          type="table"
          title={
            <EditableText
              value={shape.props.title}
              ariaLabel="Table title"
              dataTestId="table-title"
              placeholder="Table title"
              className="w-full"
              onCommit={(title) => update({ title })}
            />
          }
          description={
            <EditableText
              value={shape.props.sourceNote}
              ariaLabel="Table source note"
              dataTestId="table-source-note"
              placeholder="Add source note"
              className="w-full"
              onCommit={(sourceNote) => update({ sourceNote })}
            />
          }
          headerMeta={<span className="text-xs text-muted-foreground">{rows.length} rows</span>}
          contentClassName="px-0"
        >
          <TableViewport scroll={rows.length >= SHORT_TABLE_ROW_LIMIT}>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  {columns.map((column, index) => {
                    const columnLabel = column || `Column ${index + 1}`;
                    return (
                      <TableHead key={`${column}-${index}`} className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1">
                          <EditableText
                            value={column}
                            ariaLabel={`Column ${index + 1}`}
                            dataTestId={`table-column-${index}`}
                            className="min-w-0 flex-1"
                            onCommit={(nextColumn) =>
                              update({
                                columns: columns.map((current, columnIndex) =>
                                  columnIndex === index ? nextColumn : current,
                                ),
                              })
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="shrink-0"
                            aria-label={`Sort by ${columnLabel}`}
                            data-testid={`table-sort-${index}`}
                            onPointerDown={stopEventPropagation}
                            onClick={() => cycleSort(index)}
                          >
                            {sortBy?.column === index
                              ? sortBy.dir === "asc"
                                ? "↑"
                                : "↓"
                              : "↕"}
                          </Button>
                        </div>
                      </TableHead>
                    );
                  })}
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
                        const editCell = (text: string) => {
                          const nextRows = rows.map((currentRow, rowIndex) => {
                            if (rowIndex !== originalIndex) return currentRow;
                            const nextRow = [...currentRow];
                            nextRow[cellIndex] = parseEditedCellValue(text, value);
                            return nextRow;
                          });
                          update({ rows: nextRows });
                        };

                        return (
                          <TableCell
                            key={cellIndex}
                            className={cn("min-w-0", isLogoCell ? "py-2" : "py-3")}
                          >
                            {brand ? (
                              <div className="flex min-w-0 items-center gap-2">
                                <CompanyLogo domain={brand.domain} name={name} />
                                <EditableText
                                  value={value === null ? "" : name}
                                  placeholder={value === null ? "—" : undefined}
                                  ariaLabel={`Row ${originalIndex + 1}, column ${cellIndex + 1}`}
                                  dataTestId={`table-cell-${originalIndex}-${cellIndex}`}
                                  className="min-w-0 flex-1 truncate"
                                  onCommit={editCell}
                                />
                              </div>
                            ) : (
                              <EditableText
                                value={value === null ? "" : name}
                                placeholder={value === null ? "—" : undefined}
                                ariaLabel={`Row ${originalIndex + 1}, column ${cellIndex + 1}`}
                                dataTestId={`table-cell-${originalIndex}-${cellIndex}`}
                                className="w-full truncate"
                                onCommit={editCell}
                              />
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableViewport>
        </NodeCard>
      </HTMLContainer>
    );
  }
}
