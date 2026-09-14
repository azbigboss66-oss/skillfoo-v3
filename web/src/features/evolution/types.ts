export type CaseId = "A" | "B" | "C";
export type Scores = [number, number, number, number, number];
export type Lane = "root" | "exploit" | "diversify" | "direct";
export type MutationEdit = { target: string; replacement: string; reason: string };
export type TextCheck = { id: string; label: string; required?: string; forbidden?: string; section?: string };
export type CandidateDefinition = {
  id: string; generation: number; parentId: string; lane: "exploit" | "diversify";
  strategy: string; title: string; mutationEdits: MutationEdit[]; trainScorecard: Scores;
  publicScorecard?: Scores; selectionReason: string;
};
export type RootDefinition = { trainScorecard: Scores; publicScorecard: Scores; strategy: string };
export type CaseDefinition = {
  id: CaseId; label: string; tagline: string; title: string; goal: string; application: string;
  routeName: string; inputs: { id: string; title: string; text: string }[];
  issues: string[]; before: string; after: string; improvements: { label: string; text: string }[];
  protectedBehavior: string; baselineContent: string; scaffoldEdits: MutationEdit[];
  roots: { B0: RootDefinition; S0: RootDefinition }; checks: TextCheck[];
  candidates: CandidateDefinition[];
  direct: { rootId: "B0" | "S0"; edits: MutationEdit[]; output: string; publicScorecard: Scores; limitation: string };
  holdout: { starting: Scores; adaptive: Scores; direct: Scores; task: string; identities: Record<"starting" | "adaptive" | "direct", { candidateId: string; skillHash: string }> };
  dimensionReasons: string[]; criticalChecks: { label: string; detail: string }[];
  reviewDimensions?: string[]; reviewedObjectDecision?: string;
};
export type Qualification = { eligible: boolean; checks: { id: string; label: string; passed: boolean }[] };
export type Candidate = {
  id: string; caseId: CaseId; generation: number; parentId: string | null; lane: Lane;
  strategy: string; title: string; skillContent: string; skillHash: string;
  mutationEdits: MutationEdit[]; diff: MutationEdit[]; trainScore: number; trainScorecard?: Scores;
  qualification: Qualification; rejectionReason: string | null; publicScorecard?: Scores;
  selectionReason: string;
};
export type Population = { anchorId: string; eliteId: string; diversityId: string | null };
export type Generation = { number: number; before: Population; after: Population; attemptedIds: string[] };
export type PublicDecision = { startingReferenceId: string; championId: string | null; delta: number; reason: string };
export type HoldoutComparison = { candidateId: string; skillHash: string; dimensions: Scores; passed: boolean };
export type HoldoutResult = { starting: HoldoutComparison; adaptive: HoldoutComparison; direct: HoldoutComparison };
export type Resolution = { outcome: "ADOPT" | "RETAIN" | "FAILED"; finalCandidateId: string | null; reasons: string[] };
export type StageEvent = { id: string; stage: number; generation: number; title: string; duration: number };
export type EvolutionCase = {
  definition: CaseDefinition; candidates: Candidate[]; byId: Record<string, Candidate>; roots: Candidate[];
  direct: Candidate; generations: Generation[]; publicDecision: PublicDecision; holdout: HoldoutResult;
  resolution: Resolution; starting: Candidate; champion: Candidate | null; final: Candidate;
  ancestry: string[]; events: StageEvent[];
  stats: { attempts: number; valid: number; rejected: number; selected: number; generations: number };
};
export type PlaybackState = {
  caseId: CaseId; eventIndex: number; playing: boolean; generation: number;
  selectedCandidateId: string; evaluationTab: "public" | "holdout";
};
export type PlaybackAction =
  | { type: "case"; caseId: CaseId }
  | { type: "start"; reduced: boolean }
  | { type: "pause" }
  | { type: "resume"; reduced: boolean }
  | { type: "step"; delta: number; automatic?: boolean; caseId?: CaseId; expectedIndex?: number }
  | { type: "stage"; stage: number }
  | { type: "generation"; generation: number }
  | { type: "candidate"; id: string }
  | { type: "evaluation"; tab: "public" | "holdout" }
  | { type: "final" };
