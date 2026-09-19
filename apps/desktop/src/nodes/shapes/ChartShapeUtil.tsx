import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
} from "tldraw";

import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { NodeCard } from "./NodeCard";
import { chartShapeProps, type ChartShape } from "./types";

function seriesColor(index: number) {
  return `var(--chart-${(index % 5) + 1})`;
}

function InteractiveLegend({
  shape,
  onToggle,
}: {
  shape: ChartShape;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
      {shape.props.spec.series.map((series, index) => {
        const hidden = shape.props.hiddenSeries.includes(series.key);
        return (
          <button
            key={series.key}
            type="button"
            data-testid={`legend-${series.key}`}
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground",
              hidden && "line-through opacity-50",
            )}
            onPointerDown={stopEventPropagation}
            onClick={() => onToggle(series.key)}
          >
            <span
              className="size-2 shrink-0"
              style={{ backgroundColor: seriesColor(index) }}
            />
            {series.label ?? series.key}
          </button>
        );
      })}
    </div>
  );
}

export class ChartShapeUtil extends BaseBoxShapeUtil<ChartShape> {
  static override type = "kan-chart" as const;
  static override props = chartShapeProps;

  getDefaultProps(): ChartShape["props"] {
    return {
      w: 480,
      h: 320,
      title: "Chart",
      spec: { kind: "bar", x: "x", series: [{ key: "value" }] },
      data: [{ x: "Item", value: 1 }],
      sourceNote: "",
      hiddenSeries: [],
      focusX: null,
    };
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return true;
  }

  override isAspectRatioLocked() {
    return false;
  }

  override getIndicatorPath(shape: ChartShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: ChartShape) {
    const keys = shape.props.spec.series.map(({ key }) => key).join(", ");
    return `${shape.props.title}\n${keys}`;
  }

  component(shape: ChartShape) {
    const { spec, data, hiddenSeries, focusX } = shape.props;
    const indexedSeries = spec.series.map((series, index) => ({
      ...series,
      index,
    }));
    const config = Object.fromEntries(
      indexedSeries.map((series) => [
        series.key,
        {
          label: series.label ?? series.key,
          color: seriesColor(series.index),
        },
      ]),
    ) satisfies ChartConfig;

    const update = (props: Partial<ChartShape["props"]>) => {
      this.editor.updateShape({ id: shape.id, type: shape.type, props });
    };
    const toggleSeries = (key: string) => {
      update({
        hiddenSeries: hiddenSeries.includes(key)
          ? hiddenSeries.filter((item) => item !== key)
          : [...hiddenSeries, key],
      });
    };
    const toggleFocus = (value: unknown) => {
      const next = String(value ?? "");
      update({ focusX: focusX === next ? null : next });
    };
    const legend = (
      <InteractiveLegend shape={shape} onToggle={toggleSeries} />
    );
    const commonCartesian = (
      <>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={spec.x} tickLine={false} axisLine={false} />
        <YAxis
          tickLine={false}
          axisLine={false}
          label={
            spec.yLabel
              ? { value: spec.yLabel, angle: -90, position: "insideLeft" }
              : undefined
          }
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={() => legend} />
      </>
    );

    let chart;
    if (spec.kind === "bar") {
      chart = (
        <BarChart accessibilityLayer data={data}>
          {commonCartesian}
          {indexedSeries
            .filter(({ key }) => !hiddenSeries.includes(key))
            .map((series) => (
              <Bar
                key={series.key}
                dataKey={series.key}
                fill={`var(--color-${series.key})`}
                stackId={spec.stacked ? "stack" : undefined}
              >
                {data.map((row, rowIndex) => (
                  <Cell
                    key={`${series.key}-${rowIndex}`}
                    opacity={
                      focusX === null || String(row[spec.x]) === focusX
                        ? 1
                        : 0.35
                    }
                    fill={seriesColor(series.index)}
                    onClick={() => toggleFocus(row[spec.x])}
                  />
                ))}
              </Bar>
            ))}
        </BarChart>
      );
    } else if (spec.kind === "line") {
      chart = (
        <LineChart
          accessibilityLayer
          data={data}
          onClick={(state) => {
            if (state?.activeLabel != null) toggleFocus(state.activeLabel);
          }}
        >
          {commonCartesian}
          {focusX ? <ReferenceLine x={focusX} /> : null}
          {indexedSeries
            .filter(({ key }) => !hiddenSeries.includes(key))
            .map((series) => (
              <Line
                key={series.key}
                dataKey={series.key}
                type="monotone"
                stroke={seriesColor(series.index)}
                strokeWidth={2}
                activeDot={{ r: 5 }}
              />
            ))}
        </LineChart>
      );
    } else if (spec.kind === "area") {
      chart = (
        <AreaChart
          accessibilityLayer
          data={data}
          onClick={(state) => {
            if (state?.activeLabel != null) toggleFocus(state.activeLabel);
          }}
        >
          {commonCartesian}
          {focusX ? <ReferenceLine x={focusX} /> : null}
          {indexedSeries
            .filter(({ key }) => !hiddenSeries.includes(key))
            .map((series) => (
              <Area
                key={series.key}
                dataKey={series.key}
                type="monotone"
                fill={seriesColor(series.index)}
                fillOpacity={0.25}
                stroke={seriesColor(series.index)}
                stackId={spec.stacked ? "stack" : undefined}
              />
            ))}
        </AreaChart>
      );
    } else {
      const series = spec.series[0];
      chart = (
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey={spec.x} />} />
          <ChartLegend content={() => legend} />
          {!hiddenSeries.includes(series.key) ? (
            <Pie
              data={data}
              dataKey={series.key}
              nameKey={spec.x}
              innerRadius="35%"
              outerRadius="75%"
            >
              {data.map((row, index) => (
                <Cell
                  key={`${String(row[spec.x])}-${index}`}
                  fill={seriesColor(index)}
                  opacity={
                    focusX === null || String(row[spec.x]) === focusX ? 1 : 0.35
                  }
                  onClick={() => toggleFocus(row[spec.x])}
                />
              ))}
            </Pie>
          ) : null}
        </PieChart>
      );
    }

    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="chart"
          title={shape.props.title}
          description={shape.props.sourceNote || undefined}
        >
          <div
            className="min-h-0 flex-1"
            onPointerDown={stopEventPropagation}
          >
            <ChartContainer
              config={config}
              className="size-full min-h-0 aspect-auto"
            >
              {chart}
            </ChartContainer>
          </div>
        </NodeCard>
      </HTMLContainer>
    );
  }
}
