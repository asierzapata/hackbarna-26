import { isDeepStrictEqual } from "node:util";

export function checkMutationIntegrity(run) {
  if (run.applicationError) return { applicable: true, score: 0, failures: [run.applicationError], checks: [] };
  const expected = new Map();
  for (const operation of run.proposedResult?.operations ?? []) {
    const field = operation.type === "style" ? "color" : operation.type === "label" ? "label" : operation.type === "update" ? "draft" : null;
    if (field) expected.set(`${operation.shapeId}:${field}`, { shapeId: operation.shapeId, field, expected: operation[field === "label" ? "text" : field] });
  }
  const checks = [...expected.values()].map(check => {
    const shape = run.afterCanvas?.find(shape => shape.id === check.shapeId);
    const actual = check.field === "label" ? shape?.label : shape?.props[check.field];
    return { ...check, actual, passed: isDeepStrictEqual(actual, check.expected) };
  });
  const failures = checks.filter(check => !check.passed).map(check => `${check.shapeId}.${check.field} did not retain its final requested value`);
  return { applicable: checks.length > 0, score: checks.length ? Number(!failures.length) : null, failures, checks };
}

const atPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function comparableShape(shape, allowed = []) {
  const value = structuredClone(Object.fromEntries(["id", "type", "parentId", "x", "y", "rotation", "isLocked", "props", "label"].filter(key => shape[key] !== undefined).map(key => [key, shape[key]])));
  const paths = allowed.flatMap(path => path === "label" ? ["label", "props.richText"] : [path]);
  if (shape.type === "arrow") paths.push("x", "y", "props.start", "props.end");
  for (const path of paths) {
    const parts = path.split("."), last = parts.pop();
    const parent = parts.reduce((object, key) => object?.[key], value);
    if (parent) delete parent[last];
  }
  return value;
}

export function checkRequestedOutcome(turn, expectation) {
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  check("Execution completed", !turn.applicationError && turn.turnStatus === "done", turn.applicationError);
  const before = new Map((turn.beforeCanvas ?? []).map(shape => [shape.id, shape]));
  const after = new Map((turn.afterCanvas ?? []).map(shape => [shape.id, shape]));
  for (const wanted of expectation.values ?? []) {
    const actual = atPath(after.get(wanted.id), wanted.path);
    check(`${wanted.id}.${wanted.path} satisfies the request`, isDeepStrictEqual(actual, wanted.expected), { expected: wanted.expected, actual });
  }
  for (const [id, shape] of before) {
    const actual = after.get(id), allowed = expectation.allowedChanges?.[id] ?? [];
    check(`${id} retains identity and unrelated content`, actual && isDeepStrictEqual(comparableShape(shape, allowed), comparableShape(actual, allowed)));
  }
  const added = [...after.values()].filter(shape => !before.has(shape.id));
  check("No missing or extra new shapes", added.length === (expectation.added?.count ?? 0), { expected: expectation.added?.count ?? 0, actual: added.length });
  for (const shape of added) {
    if (expectation.added?.types) check(`New ${shape.id} has an allowed type`, expectation.added.types.includes(shape.type));
    for (const [key, value] of Object.entries(expectation.added?.props ?? {})) check(`New ${shape.id}.${key} matches`, isDeepStrictEqual(shape.props?.[key], value));
  }
  const bindings = turn.afterBindings ?? [];
  for (const prior of turn.beforeBindings ?? []) check(`Existing connection ${prior.id} is preserved`, bindings.some(binding => binding.id === prior.id && binding.fromId === prior.fromId && binding.toId === prior.toId && binding.props?.terminal === prior.props?.terminal));
  for (const requested of expectation.connections ?? []) {
    const arrows = [...after.values()].filter(shape => shape.type === "arrow");
    check(`Requested connection ${requested.from} -> ${requested.to} exists`, arrows.some(arrow => bindings.some(b => b.fromId === arrow.id && b.toId === requested.from && b.props?.terminal === "start") && bindings.some(b => b.fromId === arrow.id && b.toId === requested.to && b.props?.terminal === "end") && (requested.label === undefined || arrow.label === requested.label)));
  }
  for (const relation of expectation.relative ?? []) {
    const a = after.get(relation.a)?.[relation.axis], b = after.get(relation.b)?.[relation.axis];
    check(`Requested arrangement ${relation.a} ${relation.order} ${relation.b}`, typeof a === "number" && typeof b === "number" && (relation.order === "less" ? a < b : a > b));
  }
  if (expectation.resultKind) check("Expected clarification or refusal response", turn.proposedResult?.kind === expectation.resultKind && typeof turn.reply === "string" && turn.reply.trim().length > 0);
  return { score: Number(checks.every(check => check.passed)), failures: checks.filter(check => !check.passed).map(check => check.name), checks };
}

export function checkScenarioOutcome(run) {
  const turns = (run.turns ?? []).map(turn => checkRequestedOutcome(turn, turn.expectation));
  return { score: Number(turns.length > 0 && turns.every(turn => turn.score === 1)), passedTurns: turns.filter(turn => turn.score === 1).length, totalTurns: turns.length, turns };
}
