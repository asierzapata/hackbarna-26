/**
 * Test-only scripted conversations, fed line by line into the thread by
 * `ConversationSimulator` so a node-producing agent has something realistic
 * to react to without a live call.
 *
 * The JSON is deliberately data-only (no ids, no seq): those are wire/view
 * concerns assigned at playback time, in `useConversationPlayer`.
 */
import hackathonConversationRaw from "./fixtures/hackathon-conversation.json";

export interface ConversationTrigger {
  label: string;
  confidence: number;
}

export interface ConversationLine {
  /** Participant id, resolved against the room roster at render time. */
  speaker: string;
  text: string;
  /** Set on lines worth a node-producing agent acting on. */
  trigger?: ConversationTrigger;
}

export interface ConversationParticipant {
  id: string;
  name: string;
}

export interface ConversationScript {
  id: string;
  title: string;
  description?: string;
  participants: ConversationParticipant[];
  lines: ConversationLine[];
}

export const hackathonConversation = hackathonConversationRaw as ConversationScript;
