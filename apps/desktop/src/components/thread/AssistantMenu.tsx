import type { ReactNode } from "react";
import { RiArrowDownSLine } from "@remixicon/react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CHIME_IN_OPTIONS,
  chimeInOption,
  type ChimeIn,
} from "@/lib/assistant-settings";

export interface AssistantMenuRoomSettings {
  /** Run triggers other people raised, not just my own. */
  lend: boolean;
  onLendChange: (value: boolean) => void;
  backgroundChecks: boolean;
  onBackgroundChecksChange: (value: boolean) => void;
  /** Room-wide, affects everyone: stop contextual assistance for now. */
  paused: boolean;
  onPausedChange: (value: boolean) => void;
  settings?: ReactNode;
}

export interface AssistantMenuProps {
  /** Whether a local agent is actually connected. */
  ready: boolean;
  /** Provider name to show when connected, e.g. "Devin". */
  agentName?: string;
  chimeIn: ChimeIn;
  onChimeInChange: (value: ChimeIn) => void;
  /**
   * Room settings. Omitted on an offline canvas, where lending an agent to
   * other people and pausing for everyone are both meaningless.
   */
  room?: AssistantMenuRoomSettings;
}

/**
 * The single assistant control in the thread header.
 *
 * It replaces a four-control settings form that sat permanently above the
 * conversation: the scope toggle group, the background-checks switch, the
 * eagerness select and the room pause switch. All four are set once and then
 * forgotten, so they were paying rent on the most valuable pixels in the panel.
 *
 * The chip carries the two things worth knowing at a glance, whether an agent
 * is connected and how talkative it is, and hides the rest one click away.
 */
export function AssistantMenu({
  ready,
  agentName,
  chimeIn,
  onChimeInChange,
  room,
}: AssistantMenuProps) {
  const option = chimeInOption(chimeIn);
  const summary = ready ? option.label.toLowerCase() : "not connected";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-testid="assistant-menu"
            data-ready={ready}
            aria-label={`Kan assistant: ${summary}`}
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            ready ? "bg-primary" : "bg-muted-foreground",
          )}
        />
        <span className="max-w-32 truncate">Kan<span className="hidden @[380px]/thread:inline"> · {summary}</span></span>
        <RiArrowDownSLine data-icon="inline-end" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {ready
              ? `${agentName ?? "Agent"} connected`
              : "No agent connected. Sign in from the header bar."}
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuRadioGroup
          value={chimeIn}
          onValueChange={(value) => onChimeInChange(value as ChimeIn)}
        >
          <DropdownMenuLabel>Chime in</DropdownMenuLabel>
          {CHIME_IN_OPTIONS.map(({ value, label, description }) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              closeOnClick={false}
              data-testid={`chime-in-${value}`}
            >
              <span className="flex flex-col items-start">
                <span>{label}</span>
                <span className="text-xs text-muted-foreground">
                  {description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        {room ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>This room</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={room.lend}
                closeOnClick={false}
                onCheckedChange={room.onLendChange}
                data-testid="assistant-lend"
              >
                <span className="flex flex-col items-start">
                  <span>Lend my agent to the room</span>
                  <span className="text-xs text-muted-foreground">
                    Runs requests other people raise, not only mine
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={room.backgroundChecks}
                closeOnClick={false}
                onCheckedChange={room.onBackgroundChecksChange}
                data-testid="assistant-background"
              >
                Allow background checks using my agent
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={room.paused}
                closeOnClick={false}
                onCheckedChange={room.onPausedChange}
                data-testid="assistant-paused"
              >
                <span className="flex flex-col items-start">
                  <span>Pause contextual assistance</span>
                  <span className="text-xs text-muted-foreground">
                    Affects everyone in the room
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            {room.settings ? <div className="border-t border-border px-2 py-2">{room.settings}</div> : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
