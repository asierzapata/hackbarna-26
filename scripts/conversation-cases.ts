export interface ConversationTurn {
  atMs: number;
  speaker: string;
  prompt: string;
  expected: { nodeCount: number; color?: string; labels?: string[]; edit?: { node: string; contains: string } };
}
export interface ConversationCase { id: string; title: string; turns: ConversationTurn[] }

export const conversationCases: ConversationCase[] = [
  {
    id: "colors", title: "Two people changing the same box",
    turns: [
      { atMs: 0, speaker: "Alex", prompt: "Draw a red box.", expected: { nodeCount: 1, color: "red" } },
      { atMs: 500, speaker: "Sam", prompt: "Make the box blue.", expected: { nodeCount: 1, color: "blue" } },
      { atMs: 1250, speaker: "Alex", prompt: "Make the box green.", expected: { nodeCount: 1, color: "green" } },
      { atMs: 2000, speaker: "Sam", prompt: "Make the box orange.", expected: { nodeCount: 1, color: "orange" } },
      { atMs: 2750, speaker: "Alex", prompt: "Make the box violet.", expected: { nodeCount: 1, color: "violet" } },
    ],
  },
  {
    id: "solar-system", title: "Guided solar-system learning with revisits",
    turns: [
      { atMs: 0, speaker: "Learner", prompt: "I want to learn about the solar system. Guide me using a growing diagram of separate editable nodes, with one brief fact per node. Start with just the Sun and Mercury, and suggest what to explore next.", expected: { nodeCount: 2, labels: ["Sun", "Mercury"] } },
      { atMs: 1500, speaker: "Learner", prompt: "Add Venus and Earth as two more nodes, each with a short fact. Keep the existing Sun and Mercury nodes.", expected: { nodeCount: 4, labels: ["Sun", "Mercury", "Venus", "Earth"] } },
      { atMs: 3000, speaker: "Learner", prompt: "Go back to Mercury. Update its existing node to mention that its year is 88 Earth days. Do not add a duplicate.", expected: { nodeCount: 4, edit: { node: "Mercury", contains: "88" } } },
      { atMs: 4500, speaker: "Learner", prompt: "Now add Jupiter as one new node. Explain briefly that it is a gas giant. Keep all earlier planets.", expected: { nodeCount: 5, labels: ["Sun", "Mercury", "Venus", "Earth", "Jupiter"] } },
      { atMs: 6000, speaker: "Learner", prompt: "Return to Earth and update its existing node with the fact that about 71% of its surface is covered by water. Keep the earlier nodes and Mercury's 88-day fact.", expected: { nodeCount: 5, edit: { node: "Earth", contains: "71" }, labels: ["Sun", "Mercury", "Venus", "Earth", "Jupiter"] } },
    ],
  },
];
