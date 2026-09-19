import { experimental_evaluate as evaluate } from "ai";
import {
  CLASSIFIER_MAX_RETRIES,
  CLASSIFIER_MODEL,
  CLASSIFIER_TIMEOUT_MS,
  evaluationQuestions,
  type ClassificationState,
  type Decision,
  type Intent,
} from "./decision-policy";

export interface Classifier {
  decide(state: ClassificationState): Promise<Decision>;
}

const INTENTS: Intent[] = ["answer", "capture", "update", "lookup", "evidence", "align", "none"];

function checkProbability(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error("classifier returned invalid probability");
  }
  return v;
}

export function mapEvaluationAnswers(raw: unknown, state: ClassificationState): Decision {
  if (!raw || typeof raw !== "object") throw new Error("classifier returned invalid answers");
  const answers = raw as Record<string, { probability?: unknown; choice?: unknown; probabilities?: Record<string, unknown>; score?: unknown } | undefined>;
  const addressed = checkProbability(answers?.addressed?.probability);
  const worthCapturing = checkProbability(answers?.worthCapturing?.probability);
  const intentChoice = answers?.intent?.choice;
  if (typeof intentChoice !== "string" || !INTENTS.includes(intentChoice as Intent)) throw new Error("classifier returned invalid intent choice");
  const intentProbability = checkProbability(answers?.intent?.probabilities?.[intentChoice]);
  for (const distribution of [answers?.intent?.probabilities, answers?.relatedShape?.probabilities]) {
    if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) throw new Error("classifier returned invalid distribution");
    for (const probability of Object.values(distribution)) checkProbability(probability);
  }
  const relatedChoice = answers?.relatedShape?.choice;
  let relatedShapeId: string | null = null;
  if (relatedChoice !== "none") {
    if (typeof relatedChoice !== "string" || !/^shape_(0|[1-9][0-9]*)$/.test(relatedChoice) || !state.shapes[Number(relatedChoice.slice(6))]) {
      throw new Error("classifier returned invalid relatedShape choice");
    }
    relatedShapeId = state.shapes[Number(relatedChoice.slice(6))]?.id ?? null;
  }
  const needsExternalData = checkProbability(answers?.needsExternalData?.probability);
  const captureScore = answers?.captureWish?.score;
  if (typeof captureScore !== "number" || !Number.isFinite(captureScore) || captureScore < 0 || captureScore > 4) {
    throw new Error("classifier returned invalid capture score");
  }
  return {
    addressedProbability: addressed,
    worthCapturingProbability: worthCapturing,
    intent: intentChoice as Intent,
    intentProbability,
    relatedShapeId,
    needsExternalDataProbability: needsExternalData,
    captureScore,
  };
}

export class JevClassifier implements Classifier {
  async decide(state: ClassificationState): Promise<Decision> {
    const result = await evaluate({
      model: CLASSIFIER_MODEL,
      state: state as never,
      questions: evaluationQuestions(state),
      maxRetries: CLASSIFIER_MAX_RETRIES,
      abortSignal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
    });
    return mapEvaluationAnswers(result.answers, state);
  }
}
