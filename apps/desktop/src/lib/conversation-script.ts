/**
 * Test-only scripted conversation: a realistic call transcript for the canvas
 * prompt tests to build context from. The in-app simulator that used to play
 * it into the thread is gone; the fixture stays because the prompt builder is
 * still tested against it.
 *
 * The JSON is deliberately data-only (no ids, no seq): those are wire/view
 * concerns, assigned by whoever consumes a line.
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
