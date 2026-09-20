"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
} from "framer-motion";
import { CheckIcon, ChevronDownIcon, PencilIcon } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { selectableAgentModels } from "@/lib/agent-models";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type AiModelEffort = "high" | "medium" | "low";

export type AiModel = {
  id: string;
  label: string;
  description?: string;
  efforts?: AiModelEffort[];
  contexts?: Array<string | number>;
  supportsFast?: boolean;
  supportsThinking?: boolean;
  defaultEffort?: AiModelEffort;
  defaultContext?: string | number;
  defaultFast?: boolean;
  defaultThinking?: boolean;
  disabled?: boolean;
};

export type AiModelSelection = {
  id: string;
  effort?: AiModelEffort;
  context?: string;
  fast?: boolean;
  thinking?: boolean;
};

export const DEFAULT_AI_MODELS: AiModel[] = [
  {
    id: "luna-high",
    label: "Luna High",
    description: "Deep reasoning for complex coding and agentic tasks.",
    efforts: ["high", "medium", "low"],
    contexts: ["200K", "1M"],
    supportsFast: true,
    supportsThinking: true,
    defaultEffort: "high",
    defaultContext: "200K",
    defaultFast: true,
  },
  {
    id: "terra",
    label: "Terra",
    description: "Balanced reasoning for everyday coding workflows.",
    efforts: ["high", "medium", "low"],
    contexts: ["128K", "256K"],
    supportsFast: true,
    supportsThinking: true,
    defaultEffort: "medium",
    defaultContext: "128K",
  },
  {
    id: "sol",
    label: "Sol",
    description: "Fast responses for focused coding tasks.",
    efforts: ["high", "medium", "low"],
    contexts: ["128K"],
    supportsFast: true,
    defaultEffort: "low",
    defaultContext: "128K",
    defaultFast: true,
  },
];

const EFFORT_LABEL: Record<AiModelEffort, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export interface ModelSelectorProps {
  children: React.ReactNode;
  models?: AiModel[];
  value?: AiModelSelection;
  defaultValue?: AiModelSelection;
  onValueChange?: (value: AiModelSelection) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export interface ModelSelectorTriggerProps extends Omit<
  HTMLMotionProps<"button">,
  "children"
> {
  children?: React.ReactNode;
}

export type ModelSelectorValueProps = React.HTMLAttributes<HTMLSpanElement>;

export interface ModelSelectorContentProps extends Omit<
  HTMLMotionProps<"div">,
  "children"
> {
  children?: React.ReactNode;
  side?: "top" | "bottom";
}

export interface ModelSelectorKitProps {
  models?: AiModel[];
  value?: AiModelSelection;
  defaultValue?: AiModelSelection;
  onValueChange?: (value: AiModelSelection) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

interface SelectorContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  selection: AiModelSelection;
  selectModel: (id: string) => void;
  patchSelection: (patch: Partial<AiModelSelection>) => void;
  models: AiModel[];
  selectedModel?: AiModel;
  disabled: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  contentId: string;
  ariaLabel: string;
  reduceMotion: boolean;
  side: "top" | "bottom";
  setSide: (side: "top" | "bottom") => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
}

const SelectorContext = React.createContext<SelectorContextValue | null>(null);

function useSelectorContext(name: string) {
  const context = React.useContext(SelectorContext);
  if (!context) throw new Error(`${name} must be used within <ModelSelector>`);
  return context;
}

function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: {
  value?: T;
  defaultValue: T;
  onChange?: (value: T) => void;
}) {
  const [internal, setInternal] = React.useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const set = React.useCallback(
    (next: T | ((previous: T) => T)) => {
      const resolved =
        typeof next === "function"
          ? (next as (previous: T) => T)(current)
          : next;
      if (!controlled) setInternal(resolved);
      onChange?.(resolved);
    },
    [controlled, current, onChange],
  );
  return [current, set] as const;
}

export function formatContext(context: string | number | undefined) {
  if (context === undefined || context === "") return null;
  if (typeof context === "number") {
    if (context >= 1_000_000) return `${Math.round(context / 1_000_000)}M`;
    if (context >= 1_000) return `${Math.round(context / 1_000)}K`;
  }
  return String(context);
}

export function defaultSelectionFor(model: AiModel): AiModelSelection {
  return {
    id: model.id,
    effort: model.defaultEffort ?? model.efforts?.[0],
    context:
      formatContext(model.defaultContext ?? model.contexts?.[0]) ?? undefined,
    fast: model.defaultFast ?? false,
    thinking: model.defaultThinking ?? false,
  };
}

function resolveSelection(models: AiModel[], value?: AiModelSelection) {
  const model = models.find((item) => item.id === value?.id) ?? models[0];
  if (!model) return { id: value?.id ?? "" };
  const base = defaultSelectionFor(model);
  if (!value || value.id !== model.id) return base;
  return {
    id: model.id,
    effort: value.effort ?? base.effort,
    context: value.context ?? base.context,
    fast: value.fast ?? base.fast,
    thinking: value.thinking ?? base.thinking,
  };
}

function ModelLabel({
  model,
  selection,
}: {
  model?: AiModel;
  selection: AiModelSelection;
}) {
  if (!model)
    return <span className="text-muted-foreground">Select model</span>;
  const modifiers = [
    selection.effort ? EFFORT_LABEL[selection.effort] : null,
    selection.fast ? "Fast" : null,
    selection.thinking ? "Thinking" : null,
  ].filter(Boolean);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate font-medium text-foreground">
        {model.label}
      </span>
      {modifiers.map((modifier) => (
        <span key={modifier} className="shrink-0 text-muted-foreground/70">
          {modifier}
        </span>
      ))}
    </span>
  );
}

export function ModelSelector({
  children,
  models: availableModels = DEFAULT_AI_MODELS,
  value,
  defaultValue,
  onValueChange,
  open: openValue,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  "aria-label": ariaLabel = "AI models",
}: ModelSelectorProps) {
  const reduceMotion = !!useReducedMotion();
  const contentId = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const models = selectableAgentModels(availableModels, value?.id ?? defaultValue?.id);
  const initial =
    defaultValue ?? (models[0] ? defaultSelectionFor(models[0]) : { id: "" });
  const [rawSelection, setSelection] = useControllableState({
    value,
    defaultValue: initial,
    onChange: onValueChange,
  });
  const [open, setOpenState] = useControllableState({
    value: openValue,
    defaultValue: defaultOpen,
    onChange: onOpenChange,
  });
  const [side, setSide] = React.useState<"top" | "bottom">("top");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const selection = resolveSelection(availableModels, rawSelection);
  const selectedModel =
    models.find((model) => model.id === selection.id) ?? availableModels.find((model) => model.id === selection.id);
  const configCache = React.useRef<Record<string, AiModelSelection>>({});

  React.useEffect(() => {
    if (selection.id) configCache.current[selection.id] = selection;
  }, [selection]);

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (disabled && next) return;
      setOpenState(next);
      if (!next) setEditingId(null);
    },
    [disabled, setOpenState],
  );

  const selectModel = React.useCallback(
    (id: string) => {
      const model = models.find((item) => item.id === id);
      if (!model || model.disabled) return;
      setSelection(
        resolveSelection(
          models,
          configCache.current[id] ?? defaultSelectionFor(model),
        ),
      );
      setOpen(false);
      triggerRef.current?.focus();
    },
    [models, setOpen, setSelection],
  );

  const patchSelection = React.useCallback(
    (patch: Partial<AiModelSelection>) => {
      setSelection((previous) => {
        const next = resolveSelection(models, {
          ...previous,
          ...patch,
          id: patch.id ?? previous.id,
        });
        configCache.current[next.id] = next;
        return next;
      });
    },
    [models, setSelection],
  );

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !contentRef.current?.contains(target)
      )
        setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", keydown);
    };
  }, [open, setOpen]);

  return (
    <SelectorContext.Provider
      value={{
        open,
        setOpen,
        selection,
        selectModel,
        patchSelection,
        models,
        selectedModel,
        disabled,
        triggerRef,
        contentRef,
        contentId,
        ariaLabel,
        reduceMotion,
        side,
        setSide,
        editingId,
        setEditingId,
      }}
    >
      <div
        data-slot="model-selector"
        className={cn("relative inline-flex", className)}
      >
        {children}
      </div>
    </SelectorContext.Provider>
  );
}

export const ModelSelectorTrigger = React.forwardRef<
  HTMLButtonElement,
  ModelSelectorTriggerProps
>(({ children, className, onClick, disabled, ...props }, ref) => {
  const {
    open,
    setOpen,
    triggerRef,
    contentId,
    selectedModel,
    disabled: rootDisabled,
  } = useSelectorContext("ModelSelectorTrigger");
  const isDisabled = disabled || rootDisabled;
  return (
    <motion.button
      {...props}
      ref={(node) => {
        triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      type="button"
      disabled={isDisabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={contentId}
      aria-label={`Model: ${selectedModel?.label ?? "Select model"}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !isDisabled) setOpen(!open);
      }}
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40",
        open && "bg-muted text-foreground",
        className,
      )}
    >
      {children ?? <ModelSelectorValue />}
      <ChevronDownIcon
        className={cn(
          "size-3.5 opacity-60 transition-transform",
          open && "rotate-180",
        )}
        aria-hidden
      />
    </motion.button>
  );
});
ModelSelectorTrigger.displayName = "ModelSelectorTrigger";

export function ModelSelectorValue({
  className,
  ...props
}: ModelSelectorValueProps) {
  const { selectedModel, selection } = useSelectorContext("ModelSelectorValue");
  return (
    <span {...props} className={cn("min-w-0", className)}>
      <ModelLabel model={selectedModel} selection={selection} />
    </span>
  );
}
ModelSelectorValue.displayName = "ModelSelectorValue";

export const ModelSelectorContent = React.forwardRef<
  HTMLDivElement,
  ModelSelectorContentProps
>(({ children, side: sideProp = "top", className, style, ...props }, ref) => {
  const {
    open,
    triggerRef,
    contentRef,
    contentId,
    models,
    selectedModel,
    selectModel,
    patchSelection,
    editingId,
    setEditingId,
    reduceMotion,
    ariaLabel,
    setSide,
    selection,
  } = useSelectorContext("ModelSelectorContent");
  const [mounted, setMounted] = React.useState(false);
  const [position, setPosition] = React.useState({
    top: 0,
    left: 0,
    maxHeight: 0,
  });

  React.useEffect(() => setMounted(true), []);
  React.useLayoutEffect(() => {
    if (!open || !mounted) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const content = contentRef.current;
      if (!rect || !content) return;
      const margin = 8;
      const above = Math.max(0, rect.top - margin * 2);
      const below = Math.max(0, window.innerHeight - rect.bottom - margin * 2);
      const preferredSpace = sideProp === "top" ? above : below;
      const actualSide =
        content.scrollHeight <= preferredSpace
          ? sideProp
          : above >= below
            ? "top"
            : "bottom";
      const maxHeight = actualSide === "top" ? above : below;
      const height = Math.min(content.offsetHeight, maxHeight);
      setSide(actualSide);
      setPosition({
        top:
          actualSide === "top"
            ? Math.max(margin, rect.top - margin - height)
            : rect.bottom + margin,
        left: Math.max(
          margin,
          Math.min(rect.left, window.innerWidth - content.offsetWidth - margin),
        ),
        maxHeight,
      });
    };
    const observer = new ResizeObserver(update);
    if (contentRef.current) observer.observe(contentRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, mounted, sideProp, triggerRef, contentRef, setSide]);

  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          {...props}
          {...(reduceMotion
            ? {
                initial: { opacity: 0 },
                animate: { opacity: 1 },
                exit: { opacity: 0 },
              }
            : {
                initial: { opacity: 0, y: 6, scale: 0.97 },
                animate: { opacity: 1, y: 0, scale: 1 },
                exit: { opacity: 0, y: 4, scale: 0.98 },
              })}
          ref={(node) => {
            contentRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          id={contentId}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            ...style,
            position: "fixed",
            top: position.top,
            left: position.left,
            maxHeight: position.maxHeight || undefined,
            maxWidth: "calc(100vw - 16px)",
            zIndex: 50,
          }}
          className={cn(
            "flex flex-wrap items-start gap-3 overflow-y-auto rounded-2xl border-2 border-border bg-popover p-1.5 text-popover-foreground shadow-lg",
            className,
          )}
        >
          <div className="flex w-64 min-w-0 max-w-full flex-col gap-0.5">
            {children ??
              models.map((model) => (
                <div
                  key={model.id}
                  className={cn(
                    "group flex items-center rounded-xl",
                    model.id === selection.id && "bg-muted",
                  )}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={model.id === selection.id}
                    disabled={model.disabled}
                    onClick={() => selectModel(model.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm disabled:opacity-40"
                  >
                    <span className="min-w-0 flex-1">
                      <ModelLabel
                        model={model}
                        selection={
                          selection.id === model.id
                            ? selection
                            : defaultSelectionFor(model)
                        }
                      />
                    </span>
                    {model.id === selection.id ? (
                      <CheckIcon className="size-3.5 shrink-0" aria-hidden />
                    ) : null}
                  </button>
                  {model.efforts?.length ||
                  model.contexts?.length ||
                  model.supportsFast ||
                  model.supportsThinking ? (
                    <button
                      type="button"
                      aria-label={`Edit ${model.label} settings`}
                      onClick={() => {
                        if (editingId === model.id) setEditingId(null);
                        else {
                          patchSelection({
                            ...defaultSelectionFor(model),
                            id: model.id,
                          });
                          setEditingId(model.id);
                        }
                      }}
                      className="mr-1 flex size-7 items-center justify-center rounded-lg text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <PencilIcon className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
              ))}
          </div>
          {editingId && selectedModel?.id === editingId ? (
            <ModelSettings model={selectedModel} />
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
});
ModelSelectorContent.displayName = "ModelSelectorContent";

function ModelSettings({ model }: { model: AiModel }) {
  const { selection, patchSelection } = useSelectorContext("ModelSettings");
  const options = (model.efforts ?? []).map((effort) => ({
    label: EFFORT_LABEL[effort],
    patch: { effort },
  }));
  const contexts = (model.contexts ?? []).map((context) => ({
    label: formatContext(context) ?? String(context),
    patch: { context: formatContext(context) ?? String(context) },
  }));
  return (
    <aside className="flex w-48 shrink-0 flex-col gap-2 rounded-xl border border-border p-2">
      <strong className="px-1 text-xs">{model.label}</strong>
      {options.length ? (
        <SettingGroup
          label="Effort"
          options={options}
          selected={selection.effort}
          onSelect={(effort) =>
            patchSelection({ id: model.id, effort: effort as AiModelEffort })
          }
        />
      ) : null}
      {contexts.length ? (
        <SettingGroup
          label="Context"
          options={contexts}
          selected={selection.context}
          onSelect={(context) => patchSelection({ id: model.id, context })}
        />
      ) : null}
      {model.supportsFast || model.supportsThinking ? (
        <div className="flex flex-col gap-0.5">
          <span className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Modes
          </span>
          {model.supportsFast ? (
            <SettingButton
              label="Fast"
              selected={!!selection.fast}
              onClick={() =>
                patchSelection({ id: model.id, fast: !selection.fast })
              }
            />
          ) : null}
          {model.supportsThinking ? (
            <SettingButton
              label="Thinking"
              selected={!!selection.thinking}
              onClick={() =>
                patchSelection({ id: model.id, thinking: !selection.thinking })
              }
            />
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function SettingGroup({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: Array<{ label: string; patch: Record<string, string> }>;
  selected?: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {options.map((option) => (
        <SettingButton
          key={option.label}
          label={option.label}
          selected={selected === option.label}
          onClick={() => onSelect(option.patch[Object.keys(option.patch)[0]])}
        />
      ))}
    </div>
  );
}

function SettingButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs",
        selected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <span>{label}</span>
      {selected ? <CheckIcon className="size-3.5" aria-hidden /> : null}
    </button>
  );
}

export function ModelSelectorKit({
  models = DEFAULT_AI_MODELS,
  value,
  defaultValue,
  onValueChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: ModelSelectorKitProps) {
  return (
    <ModelSelector
      models={models}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      className={className}
      aria-label={ariaLabel}
    >
      <ModelSelectorTrigger>
        <ModelSelectorValue />
      </ModelSelectorTrigger>
      <ModelSelectorContent />
    </ModelSelector>
  );
}

export default ModelSelectorKit;
