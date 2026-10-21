import "./no-telemetry.js";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { ClassifyResult } from "./classify.js";
import { executePlan, savePlan } from "./execute.js";
import { writeFollowUps } from "./followups.js";
import { fingerprint } from "./guard.js";
import { buildPlan, PlanItemSchema } from "./plan.js";
import { applyReviewGate, type Predictor } from "./review.js";
import { scanFolder, type ScannedFile } from "./scan.js";

// `dz tidy` as a Mastra workflow: analyze -> plan -> approve -> move.
// The approve step suspends the run until a person answers, then resumes with
// their choices. Every step calls Dropzone Zero's own functions; no step hands
// the model a tool, so the guard and the executor keep the final say. Approving
// can release REVIEW items only: BLOCK items stay blocked, because the executor
// judges every item again before it moves.

const ScannedFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  ext: z.string(),
  size: z.number(),
  // Snapshots may be serialized, so accept the date back as a string.
  modifiedAt: z.coerce.date(),
  ageDays: z.number(),
  sha256: z.string(),
  partial: z.boolean(),
  executable: z.boolean(),
  duplicateOf: z.string().optional(),
});

const RunResultSchema = z.object({
  run: z.string(),
  moved: z.number(),
  moves: z.array(z.object({ from: z.string(), to: z.string() })),
  failed: z.array(z.object({ name: z.string(), error: z.string() })),
});

/** What the person decides while the run is suspended. */
export const TidyDecisionSchema = z.object({
  /** Names of REVIEW items to release for this run. */
  approve: z.array(z.string()),
  /** False cancels: nothing moves. */
  confirmed: z.boolean(),
});
export type TidyDecision = z.infer<typeof TidyDecisionSchema>;

export interface TidyDeps {
  inbox: string;
  model: string;
  classify: (file: ScannedFile) => Promise<ClassifyResult>;
  predictor?: Predictor;
  onProgress?: (done: number, total: number) => void;
}

export function createTidyWorkflow(deps: TidyDeps) {
  const analyze = createStep({
    id: "analyze",
    description: "Scan the folder: hashes, duplicates, partial downloads",
    inputSchema: z.object({}),
    outputSchema: z.object({ files: z.array(ScannedFileSchema) }),
    execute: async () => ({ files: await scanFolder(deps.inbox) }),
  });

  const plan = createStep({
    id: "plan",
    description: "Classify with the local model, judge every item, and save the plan",
    inputSchema: z.object({ files: z.array(ScannedFileSchema) }),
    outputSchema: z.object({ items: z.array(PlanItemSchema), gate: z.string() }),
    execute: async ({ inputData }) => {
      const items = await buildPlan(inputData.files, { inbox: deps.inbox, classify: deps.classify, onProgress: deps.onProgress });
      const gate = await applyReviewGate(deps.inbox, items, deps.predictor);
      await savePlan(deps.inbox, deps.model, items);
      return { items, gate: gate.note };
    },
  });

  const approve = createStep({
    id: "approve",
    description: "Wait for a person to release review items and confirm the run",
    inputSchema: z.object({ items: z.array(PlanItemSchema), gate: z.string() }),
    outputSchema: z.object({ items: z.array(PlanItemSchema), confirmed: z.boolean() }),
    suspendSchema: z.object({ items: z.array(PlanItemSchema), gate: z.string() }),
    resumeSchema: TidyDecisionSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) return await suspend({ items: inputData.items, gate: inputData.gate });
      const at = new Date().toISOString();
      const items = inputData.items.map((item) =>
        item.verdict === "review" && resumeData.approve.includes(item.name)
          ? { ...item, approval: { at, fingerprint: fingerprint(item) } }
          : item,
      );
      await savePlan(deps.inbox, deps.model, items);
      return { items, confirmed: resumeData.confirmed };
    },
  });

  const move = createStep({
    id: "move",
    description: "Carry out allowed and approved moves, verified by hash and journaled",
    inputSchema: z.object({ items: z.array(PlanItemSchema), confirmed: z.boolean() }),
    outputSchema: z.object({ cancelled: z.boolean(), result: RunResultSchema.nullable() }),
    execute: async ({ inputData }) => {
      if (!inputData.confirmed) return { cancelled: true, result: null };
      const result = await executePlan(deps.inbox, inputData.items);
      // Due dates and bookings ahead become calendar follow-ups, as with dz run.
      await writeFollowUps(deps.inbox, result.moves, inputData.items);
      return { cancelled: false, result };
    },
  });

  return createWorkflow({
    id: "tidy",
    description: "Analyze a folder, plan with a local model, wait for approval, then move",
    inputSchema: z.object({}),
    outputSchema: z.object({ cancelled: z.boolean(), result: RunResultSchema.nullable() }),
  })
    .then(analyze)
    .then(plan)
    .then(approve)
    .then(move)
    .commit();
}

/**
 * Starts a tidy run and returns the plan waiting for approval, plus a function
 * that resumes the run with the person's decision. Snapshots live in memory: the
 * durable record is the saved plan and the journal, as with every other command.
 */
export async function startTidy(deps: TidyDeps) {
  const mastra = new Mastra({ workflows: { tidy: createTidyWorkflow(deps) }, storage: new InMemoryStore(), logger: false });
  const run = await mastra.getWorkflow("tidy").createRun();
  const started = await run.start({ inputData: {} });
  if (started.status !== "suspended") throw new Error(`Tidy workflow stopped early (${started.status})`);
  const waiting = started.steps.approve;
  const payload = z
    .object({ items: z.array(PlanItemSchema), gate: z.string() })
    .parse(waiting && "suspendPayload" in waiting ? waiting.suspendPayload : undefined);

  return {
    items: payload.items,
    gate: payload.gate,
    async decide(decision: TidyDecision) {
      const finished = await run.resume({ step: "approve", resumeData: decision });
      if (finished.status !== "success") throw new Error(`Tidy workflow did not finish (${finished.status})`);
      return z.object({ cancelled: z.boolean(), result: RunResultSchema.nullable() }).parse(finished.result);
    },
  };
}
