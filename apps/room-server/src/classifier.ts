import { experimental_evaluate as evaluate } from "ai";
import {
  CLASSIFIER_MAX_RETRIES,
  CLASSIFIER_MODEL,
  CLASSIFIER_TIMEOUT_MS,
  evaluationQuestions,
  type ClassificationState,
  type Decision,
} from "./decision-policy";

export interface Classifier {
  decide(state: ClassificationState): Promise<Decision>;
}

function checkProbability(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error("classifier returned invalid probability");
  }
  return v;
}

export function mapEvaluationAnswers(raw: unknown): Decision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("classifier returned invalid answers");
  const answers = raw as Record<string, { probability?: unknown } | undefined>;
  return { triggerProbability: checkProbability(answers.shouldTrigger?.probability) };
}

export class JevClassifier implements Classifier {
  async decide(state: ClassificationState): Promise<Decision> {
    const result = await evaluate({
      model: CLASSIFIER_MODEL,
      state: state as never,
      questions: evaluationQuestions(),
      maxRetries: CLASSIFIER_MAX_RETRIES,
      abortSignal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
    });
    return mapEvaluationAnswers(result.answers);
  }
}
