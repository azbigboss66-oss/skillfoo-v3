import { useEffect, useId, useRef } from "react";
import { LockKeyhole } from "lucide-react";

type Point = Readonly<{ x: number; y: number }>;
type Band = "anchor" | "elite" | "diversity";
type Emphasis = "background" | "middle" | "foreground" | "hero";
type StageId = "input" | "confirm" | "roots" | "population" | "public" | "direct" | "holdout" | "decision";
type PathKind = "structure" | "candidate" | "direct" | "rail" | "final";
type NodeId = "input" | "confirm" | "b0" | "s0" | "public" | "directStart" | "directEnd" | "decision" | "adopt" | "retain" | "failed";

type StagePathRef = Readonly<{
  id: string;
  kind: PathKind;
}>;

type StageVisualSpec = Readonly<{
  id: StageId;
  maskRange: readonly [number, number];
  secondaryPaths: readonly StagePathRef[];
  heroPaths: readonly StagePathRef[];
  nodes: readonly NodeId[];
  gates: boolean;
  rejections: boolean;
  particlePaths: readonly StagePathRef[];
}>;

type CandidateSpec = Readonly<{
  id: string;
  band: Band;
  emphasis: Emphasis;
}>;

type CandidatePath = Readonly<{
  id: string;
  band: Band;
  points: readonly Point[];
  d: string;
  emphasis: Emphasis;
  status: "survivor" | "rejected";
  survivesTo: "public" | "gen1" | "gen2" | "genn";
  rejectedAt?: Readonly<{ stage: "gen1" | "gen2" | "genn"; point: Point }>;
}>;

const VIEWBOX = Object.freeze({ width: 1925, height: 817 });

const GEOMETRY = Object.freeze({
  stages: [
    { id: "input", label: "01 输入", x: 106, hit: [0, 208] },
    { id: "confirm", label: "02 双重确认", x: 308, hit: [208, 412] },
    { id: "roots", label: "03 B0 / S0", x: 516, hit: [412, 620] },
    { id: "population", label: "04 自适应种群", x: 863, hit: [620, 1147] },
    { id: "public", label: "05 公共选择", x: 1247, hit: [1147, 1336] },
    { id: "direct", label: "06 Direct 对照", x: 1427, hit: [1336, 1529] },
    { id: "holdout", label: "07 Sealed Holdout", x: 1637, hit: [1529, 1731] },
    { id: "decision", label: "08 最终决策", x: 1828, hit: [1731, 1925] },
  ] as const,
  stageAxes: [
    { x: 105, stage: 0 },
    { x: 308, stage: 1 },
    { x: 515, stage: 2 },
    { x: 1246, stage: 4 },
    { x: 1425, stage: 5 },
    { x: 1635, stage: 6 },
    { x: 1826, stage: 7 },
  ] as const,
  generationGates: [
    { id: "gen1", label: "GEN 1", x: 726, segments: [[172, 275], [313, 433], [469, 562]] },
    { id: "gen2", label: "GEN 2", x: 887, segments: [[176, 246], [320, 418], [474, 550]] },
    { id: "genn", label: "GEN N", x: 1049, segments: [[177, 245], [322, 409], [483, 551]] },
  ] as const,
  nodes: {
    input: { x: 31, y: 400 },
    confirm: { x: 308, y: 400 },
    fork: { x: 395, y: 400 },
    b0: { x: 516, y: 315 },
    s0: { x: 516, y: 473 },
    eliteJunction: { x: 610, y: 394 },
    public: { x: 1246, y: 404 },
    directStart: { x: 516, y: 689 },
    directEnd: { x: 1425, y: 615 },
    decision: { x: 1764, y: 407 },
    adopt: { x: 1826, y: 354 },
    retain: { x: 1826, y: 408 },
    failed: { x: 1826, y: 464 },
  },
  lock: { x: 1613, y: 357, width: 44, height: 97, radius: 9 },
  primaryStructurePaths: [
    { id: "input-spine", stage: "confirm", d: "M31 400 H395" },
    { id: "branch-b0", stage: "roots", d: "M395 400 C438 400 445 315 495 315 H516" },
    { id: "branch-s0", stage: "roots", d: "M395 400 C438 400 445 473 495 473 H516" },
    { id: "b0-anchor-feeder", stage: "population", d: "M516 315 C540 315 544 256 570 256" },
    { id: "b0-elite-feeder", stage: "population", d: "M516 315 C536 339 548 372 570 372 C588 372 596 394 610 394" },
    { id: "s0-elite-feeder", stage: "population", d: "M516 473 C538 447 550 411 570 411 C588 411 598 394 610 394" },
    { id: "s0-diversity-feeder", stage: "population", d: "M516 473 C540 473 544 518 570 518" },
  ] as const,
  directBaseline: {
    id: "direct-baseline",
    d: "M516 689 H1390 C1410 689 1425 674 1425 654 V615",
  },
  comparisonRails: [
    {
      id: "comparison-upper",
      d: "M1246 404 C1318 404 1352 370 1425 370 H1613 H1657 C1660 391 1674 401 1698 402 C1726 402 1742 407 1764 407",
    },
    {
      id: "comparison-lower",
      d: "M1246 404 C1318 404 1352 439 1425 439 H1613 H1657 C1661 420 1676 411 1700 410 C1726 410 1744 407 1764 407",
    },
  ] as const,
  finalBranches: [
    { id: "outcome-adopt", d: "M1764 407 C1778 407 1784 354 1812 354 H1826" },
    { id: "outcome-retain", d: "M1764 407 H1826" },
    { id: "outcome-failed", d: "M1764 407 C1778 407 1784 464 1812 464 H1826" },
  ] as const,
});

type ReferenceConfidence = "h" | "m" | "l";
type ReferenceTrackGeometry = readonly [
  sampleOffset: number,
  centerY: readonly number[],
  measuredSlope: readonly number[],
  confidence: string,
];

// Fixed samples measured in the 1925 x 817 reference coordinate space.
// Values before each track's visible lifetime stay absent rather than fanning out from B0/S0.
const REFERENCE_SAMPLE_X = [516, 532, 545, 558, 570, 590, 610, 640, 680, 706, 723, 729, 766, 806, 846, 884, 890, 928, 968, 1008, 1046, 1052, 1080, 1110, 1145, 1170, 1192, 1215, 1230, 1246] as const;

const REFERENCE_CANDIDATE_GEOMETRY: Readonly<Record<string, ReferenceTrackGeometry>> = Object.freeze({
  "anchor-01": [4, [254.99, 248.98, 237.95, 220.51, 196.08, 176.64, 173.82, 173.46, 179.23, 191, 183.82, 175.94, 176.31, 182.07, 191, 183.57, 176.9, 177.39, 193.71, 218.49, 284.53, 329.59, 356.33, 383.01, 395.09, 405.51], [-0.3005, -0.426, -0.5694, -0.59814, -0.6647, -0.51767, -0.13826, 0.12581, 0.22779, 0.05738, -0.19308, -0.17068, 0.13932, 0.18833, 0.01875, -0.18077, -0.14045, 0.49441, 0.70862, 1.39723, 1.85167, 1.52766, 1.18711, 1.02, 0.72581, 0.65125], "llhhmhhlhhlhllhlllmhhlllll"],
  "anchor-02": [4, [254.99, 249.21, 238.01, 221.49, 203.18, 188.11, 183.28, 182.88, 190.47, 198, 191.19, 184.06, 184.04, 189.43, 197.01, 189.35, 183.41, 183.77, 203.97, 228.51, 295.38, 336.51, 362.34, 389.13, 396.77, 405.51], [-0.289, -0.4245, -0.5544, -0.49757, -0.50576, -0.46279, -0.22739, 0.16721, 0.19636, 0.009, -0.17872, -0.1625, 0.12205, 0.16628, -0.001, -0.17436, -0.12682, 0.60471, 0.77138, 1.40631, 1.8, 1.42468, 1.16933, 0.90605, 0.52839, 0.54625], "llhhhlllhmlllhmmhhlmhhllll"],
  "anchor-03": [4, [254.99, 257.72, 258.01, 257, 257.5, 256.64, 253.98, 254.18, 257.33, 263.37], [0.1365, 0.0755, -0.0144, -0.00729, -0.00545, -0.08186, -0.10696, 0.07791, 0.11935, 0.151], "llmhmhhhll"],
  "anchor-04": [4, [254.99, 249.79, 240.23, 227.88, 210.11, 198.96, 192.74, 192.32, 197.08, 203.54, 202.97, 201.98, 201.03, 201.62, 204, 202.67, 200.46, 199.27, 213.68, 236.88, 304.23, 344.51, 369.45, 390.12, 396.76, 405.51], [-0.26, -0.369, -0.4382, -0.43029, -0.43818, -0.40395, -0.2887, 0.10093, 0.14571, 0.07362, -0.02, -0.04409, -0.00818, 0.03808, 0.01312, -0.04538, -0.07727, 0.38882, 0.64845, 1.39308, 1.79383, 1.38766, 1.01356, 0.71868, 0.49645, 0.54688], "llhmlmhhllhhhlhmllhlhmhlll"],
  "anchor-05": [4, [254.99, 250.96, 244.32, 234.26, 221.74, 209.2, 207, 206.57, 206.05, 207.96, 205.31, 204.45, 207.61, 209.13, 212.01, 210.99, 208.94, 209.24, 223.23, 242.5, 309.73, 351, 371.51, 392.99, 397.74, 405.51], [-0.2015, -0.26675, -0.334, -0.32257, -0.3797, -0.34279, -0.11435, -0.02209, 0.01805, -0.00925, -0.045, 0.05227, 0.10636, 0.05641, 0.02325, -0.03936, -0.03977, 0.42029, 0.57345, 1.33077, 1.80833, 1.31447, 0.93311, 0.69026, 0.40387, 0.48562], "llhlmmhhllllllhmllhmlhhlll"],
  "anchor-06": [4, [254.99, 251.99, 244.75, 237.24, 229.27, 223.11, 220.76, 220.38, 217.46, 214.01, 213, 214.08, 214.21, 217.6, 221, 218.82, 216.44, 217.71, 230.96, 248.49, 316.48, 358.37, 376.66, 398.52, 402.3, 405.51], [-0.15, -0.256, -0.295, -0.22114, -0.21409, -0.19791, -0.1187, -0.07674, -0.08273, -0.05575, 0.0009, 0.0275, 0.08, 0.08705, 0.01525, -0.05846, -0.02523, 0.42706, 0.53069, 1.31569, 1.83133, 1.28043, 0.89222, 0.67474, 0.22548, 0.20062], "llhmmhhhhhhhhlmmhhlmmhmlll"],
  "anchor-07": [4, [254.99, 251.77, 245.84, 239.87, 234.67, 232.09, 230.14, 229.86, 226.84, 223.87, 224.96, 225.52, 224.03, 224.98, 228.13, 226.96, 229.04, 228.98, 240.18, 260.26, 326.82, 365.14, 382.22, 401.53, 403.15, 405.51], [-0.161, -0.22875, -0.238, -0.15957, -0.11788, -0.10535, -0.09696, -0.07674, -0.07779, -0.0235, 0.02115, -0.02114, -0.01227, 0.05256, 0.02475, 0.01167, 0.04591, 0.32765, 0.53931, 1.33292, 1.748, 1.17872, 0.80867, 0.55079, 0.12839, 0.1475], "llmmlmlllhhllhmlhhlmmlmlll"],
  "anchor-08": [4, [254.99, 256.03, 254.41, 248.47, 247.17, 243.97, 244.78, 243.84, 237.73, 232, 232.73, 238.96, 238.92, 243.27, 248.76], [0.052, -0.0145, -0.1512, -0.10343, -0.06818, -0.05558, -0.00565, -0.16395, -0.15377, -0.0625, 0.08923, 0.14068, 0.09795, 0.12615, 0.13725], "lllllllllhmhhmh"],
  "anchor-09": [4, [254.99, 254.82, 250.57, 247, 243.48, 244.06, 243.14, 242.44, 233.74, 229.38, 231.6, 236.09, 236.1, 232.26, 229.88, 235.88, 240.36, 240.82, 251.73, 268.11, 331.09, 372, 386.73, 402.88, 403.01, 405.51], [-0.0085, -0.1105, -0.1564, -0.10129, -0.04455, -0.00791, -0.07043, -0.2186, -0.16961, -0.02675, 0.08603, 0.10227, -0.08705, -0.07974, 0.04525, 0.13436, 0.11227, 0.33441, 0.47052, 1.22092, 1.7315, 1.18383, 0.68622, 0.42842, 0.08484, 0.15625], "lllhllllmmhlllhlhhlmllllll"],
  "anchor-10": [4, [254.99, 258.73, 260.09, 264.55, 266.23, 265.89, 267.54, 267.45, 264.18, 258.38, 249.84, 241.58, 240.96, 238.63, 238.95, 238.59, 240.05, 240.61, 251.92, 270.99, 339.4, 380.01, 393.2, 403, 403.1, 405.51], [0.187, 0.1275, 0.1164, 0.08771, 0.0203, 0.03047, 0.06783, -0.07814, -0.11779, -0.17925, -0.21538, -0.20182, -0.06705, -0.02577, -0.0005, 0.0141, 0.04591, 0.34912, 0.52379, 1.34585, 1.817, 1.14468, 0.51089, 0.26053, 0.08097, 0.15062], "llhmlmlhhllhhmlllllmllhlll"],
  "anchor-11": [4, [254.99, 258.81, 260.22, 265.13, 272.03, 273.12, 273.4, 274.95, 269.92, 263.63, 254.14, 246.44, 247.24, 244.04, 247.56, 244.87, 244.82, 245.28, 255.99, 271.73, 343.98, 385.45, 395.63, 403, 403.04, 405.51], [0.191, 0.13075, 0.1264, 0.16871, 0.12106, 0.03186, 0.07957, -0.08093, -0.14701, -0.19725, -0.22038, -0.15682, -0.05455, 0.0041, 0.01038, -0.03513, 0.00932, 0.32853, 0.45603, 1.35369, 1.89533, 1.09894, 0.39, 0.195, 0.08097, 0.15437], "llhhhhlllllllmmllllllmhlll"],

  "elite-01": [4, [372.63, 369.8, 364.65, 356.51, 333.27, 317.28, 314.84, 314.54, 321.57, 334, 329.86, 323.53, 323.61, 328.97, 338, 333.77, 325.91, 325.87, 333.26, 344.76, 369.12, 383.99, 393.48, 401.52, 403.21, 405.51], [-0.1415, -0.1995, -0.2658, -0.44829, -0.59439, -0.4286, -0.11913, 0.15651, 0.25273, 0.10363, -0.13423, -0.14205, 0.12364, 0.18449, 0.06, -0.155, -0.17955, 0.21618, 0.32569, 0.55169, 0.65383, 0.5183, 0.38956, 0.25605, 0.12871, 0.14375], "lllhlhllhhmhhlhllhlhhhhlll"],
  "elite-02": [4, [372.63, 371.04, 370.04, 363.38, 343.5, 330.05, 323.29, 321.51, 332.16, 340.12, 334.7, 329.01, 329.09, 336.1, 344.01, 335.55, 328.51, 328.64, 340.64, 353.89, 375.21, 386.46, 395.41, 402.02, 403.19, 405.51], [-0.0795, -0.06475, -0.1532, -0.37914, -0.505, -0.47, -0.3713, 0.20628, 0.24169, 0.03175, -0.14244, -0.1275, 0.16114, 0.19128, -0.00688, -0.19872, -0.15705, 0.35676, 0.43534, 0.53185, 0.54283, 0.42979, 0.34578, 0.20474, 0.11258, 0.145], "lllhlmllhhlllhmhhhmmhmhlll"],
  "elite-03": [4, [372.63, 373.64, 370.95, 370, 350.69, 337.31, 332.65, 332.03, 338.3, 348, 340.58, 335.9, 335.96, 342.28, 350.99, 344.09, 339.01, 339.04, 351.61, 363.12, 382.03, 391.76, 396.07, 402.52, 403.17, 405.51], [0.0505, -0.042, -0.0728, -0.28943, -0.4953, -0.41953, -0.22957, 0.1314, 0.2074, 0.0285, -0.15513, -0.105, 0.145, 0.19269, 0.02263, -0.15359, -0.11477, 0.37059, 0.41517, 0.468, 0.47733, 0.29872, 0.23911, 0.18684, 0.09645, 0.14625], "llhhmmhhlhmhhlhmhhhlmmhlll"],
  "elite-04": [4, [372.63, 374.98, 375.53, 377.75, 360.4, 349.46, 344.8, 344.42, 348.82, 356.01, 351.11, 347.02, 347.33, 351.55, 359, 350.98, 346.9, 347.73, 357.54, 372.12, 385.38, 391.88, 395.97, 403, 403.04, 405.51], [0.1175, 0.0725, 0.0554, -0.21614, -0.42864, -0.36279, -0.21913, 0.09349, 0.15052, 0.02863, -0.11526, -0.08591, 0.10295, 0.14962, -0.00712, -0.15513, -0.07386, 0.31294, 0.42052, 0.42831, 0.32933, 0.22532, 0.24711, 0.18605, 0.08097, 0.15437], "llhhlmhhlhlhhlhmlllmmmhlll"],
  "elite-05": [4, [372.63, 374.34, 381.23, 386, 370.94, 359.48, 353.27, 352.89, 357.7, 365.01, 356.96, 350.76, 350.5, 360.04, 367.99, 359.53, 352.45, 352.68, 367.28, 382.12, 392.15, 396.56, 400.15, 403, 403.04, 405.51], [0.0855, 0.215, 0.2332, -0.147, -0.40182, -0.41093, -0.28652, 0.10302, 0.1574, -0.00925, -0.18269, -0.14682, 0.21091, 0.22423, -0.00638, -0.19923, -0.15568, 0.43618, 0.50759, 0.38262, 0.24067, 0.17021, 0.14311, 0.07605, 0.08097, 0.15437], "lllhlmllmmmllmhmlllhhhhlll"],
  "elite-06": [4, [372.63, 374.41, 385.39, 391.01, 377.08, 368.24, 361.88, 361.75, 366.27, 372.52, 369.4, 367.99, 368.04, 371.7, 373, 368.74, 361.99, 361.99, 375.12, 391, 393.79, 398, 401.27, 403, 403.03, 405.51], [0.089, 0.319, 0.332, -0.11871, -0.345, -0.35349, -0.28217, 0.10209, 0.13987, 0.03912, -0.05808, -0.03091, 0.08432, 0.06359, -0.037, -0.14115, -0.15341, 0.38618, 0.50017, 0.28723, 0.11667, 0.15915, 0.11111, 0.04632, 0.08097, 0.155], "llmlmhhhlhmllmhhhhhmhhhlll"],
  "elite-07": [6, [395.55, 394.88, 387.77, 380.46, 377.7, 377.36, 374.5, 375, 374.83, 378.48, 378.53, 378.01, 374.48, 377.11, 380.38, 380.75, 385.88, 392.4, 397.98, 398, 401.49, 403, 403.03, 405.51], [-0.02233, -0.11114, -0.21848, -0.23419, -0.13478, -0.07442, -0.03065, 0.00412, 0.04462, 0.08409, -0.01068, -0.05192, -0.01125, 0.07564, 0.08273, 0.16176, 0.20086, 0.18615, 0.09333, 0.07468, 0.11111, 0.04053, 0.08097, 0.155], "hhhhhhlhhhhhhhllmlhhhlll"],
  "elite-08": [4, [409.87, 409.26, 403.9, 401.25, 390.12, 385.55, 383.19, 382.09, 380.02, 381.01, 381.04, 380, 380, 379.46, 382.02, 382.93, 382.95, 383.03, 391.68, 400.52, 398.95, 398.75, 401.44, 402.95, 403, 405.51], [-0.0305, -0.14925, -0.1602, -0.19686, -0.23788, -0.16116, -0.15043, -0.07372, -0.01403, 0.01275, -0.01295, -0.02364, -0.01227, 0.0259, 0.04338, 0.01192, 0.00227, 0.25676, 0.30155, 0.11185, -0.0295, 0.05298, 0.09333, 0.04105, 0.08258, 0.15687], "llhmhlllhhhhhhmlhhlmhhhlll"],
  "elite-09": [4, [409.87, 409.6, 408.21, 405.13, 397.85, 395.07, 393.2, 392.8, 386.64, 382.49, 383.21, 387.12, 387.5, 384.83, 383.99, 386.63, 391.44, 391.72, 397.23, 405.02, 409.43, 409.01, 408, 409, 408.11, 405.51], [-0.0135, -0.0415, -0.0894, -0.148, -0.15242, -0.10814, -0.0987, -0.15256, -0.1339, -0.04288, 0.05936, 0.0975, -0.05205, -0.045, 0.0225, 0.09551, 0.11568, 0.17029, 0.22931, 0.18769, 0.0665, -0.03043, -0.00022, 0.00289, -0.11258, -0.1625], "lllmllllmmmhhlmhhlmlmhmlll"],
  "elite-10": [4, [409.87, 409.33, 409.43, 409.13, 404.35, 404.07, 401.65, 401.28, 396.9, 389.01, 392.86, 399.47, 399.48, 395.01, 390.25, 392.94, 399.04, 398.14, 405.31, 409.75, 411.63, 413.97, 413.16, 412, 409.48, 405.51], [-0.027, -0.011, -0.004, -0.07257, -0.07667, -0.06279, -0.1213, -0.11047, -0.15935, -0.0505, 0.1341, 0.15045, -0.10136, -0.11833, -0.02587, 0.11269, 0.11818, 0.18441, 0.20017, 0.09723, 0.07033, 0.03255, -0.04378, -0.09684, -0.20935, -0.24813], "lllmmhhhmmhhhlmhlllhllllll"],
  "elite-11": [4, [409.87, 409.26, 410.25, 409.75, 410.34, 412.01, 414.62, 414.31, 403.98, 395.25, 398.92, 403.43, 403.36, 399.8, 391.99, 399.22, 405.36, 405.61, 411.27, 415.89, 418.82, 420.03, 417.65, 417, 410.14, 405.51], [-0.0305, 0.0095, 0.0098, 0.00129, 0.03424, 0.09953, 0.1, -0.24744, -0.24753, -0.06325, 0.10487, 0.10091, -0.0825, -0.14577, -0.00725, 0.17141, 0.14523, 0.17382, 0.17724, 0.11615, 0.069, -0.02489, -0.06733, -0.19763, -0.37065, -0.28937], "lllhlmhhlmhlllhlhhllllmlll"],
  "elite-12": [4, [409.87, 410.97, 411.14, 410.75, 415.71, 421.36, 422.91, 423.93, 421.97, 420], [0.055, 0.03175, -0.0044, 0.06529, 0.16076, 0.16744, 0.11174, -0.02186, -0.05104, -0.04925], "lllhmlllhh"],
  // x=1008 is intentionally clipped: the verified rejection tangent is x=992.
  "elite-13": [4, [409.87, 411.21, 411.96, 413.98, 425.48, 431.02, 431.48, 432.72, 415.85, 396.99, 405.99, 418.87, 419.58, 419.89, 421], [0.067, 0.05225, 0.0554, 0.19314, 0.25818, 0.13953, 0.07391, -0.36349, -0.46403, -0.12325, 0.28051, 0.30886, 0.02318, 0.01821, 0.06475], "llllhhlllmllllh"],

  "diversity-01": [4, [518, 517.95, 512.3, 503.99, 486.68, 473.02, 470.72, 470.59, 477.86, 491, 486.4, 479.14, 479.36, 487.16, 496.01, 490.37, 484.73, 484.38, 477.62, 469.88, 438.41, 419.04, 411.15, 403.49, 403.13, 405.51], [-0.0025, -0.1425, -0.2792, -0.366, -0.46924, -0.37116, -0.10565, 0.16605, 0.26506, 0.10675, -0.15205, -0.16, 0.18227, 0.21346, 0.04012, -0.14462, -0.13614, -0.20912, -0.25, -0.60323, -0.84733, -0.58, -0.34556, -0.21105, 0.06516, 0.14875], "lllmlhhlhhlhhlhlllllllllll"],
  "diversity-02": [4, [518, 518.58, 516.15, 508.76, 494.01, 485.96, 481.18, 480.97, 488.65, 496.99, 491.1, 483.87, 483.59, 494.02, 502, 493.58, 487.61, 487.5, 485.71, 484.88, 449.64, 425.98, 417.07, 405.48, 403.86, 405.51], [0.029, -0.04625, -0.1964, -0.31629, -0.34545, -0.29837, -0.21696, 0.17372, 0.20805, 0.03063, -0.16821, -0.17068, 0.23068, 0.23603, -0.0055, -0.18449, -0.13818, -0.05588, -0.04517, -0.55492, -0.98167, -0.69298, -0.45556, -0.34763, 0.00097, 0.10312], "llhmlmllhhlllhmhhhmmmlhlll"],
  "diversity-03": [4, [518, 519.15, 516.62, 515.13, 503.32, 493.37, 492.14, 491.98, 497.76, 504.01, 496.93, 492.99, 493.37, 499.71, 509.87, 507.05, 498.82, 498.97, 499.26, 495.26, 458.22, 432.88, 419.32, 409.01, 404.78, 405.51], [0.0575, -0.0345, -0.0804, -0.19, -0.3297, -0.26, -0.06043, 0.1307, 0.15623, -0.01037, -0.14128, -0.08091, 0.15273, 0.21154, 0.09175, -0.14167, -0.18364, 0.01294, -0.06397, -0.63138, -1.03967, -0.82766, -0.53044, -0.38263, -0.1129, 0.04563], "llhhmllllhhhllmlhhlhmmllll"],
  "diversity-04": [4, [518, 519.94, 518.92, 517.47, 510.66, 505.66, 502.71, 502.46, 506.82, 513, 511.64, 505.86, 506.07, 512.25, 517.25, 510.13, 507.6, 507.58, 507.28, 506.49, 468.63, 443, 425.93, 411.87, 408.82, 405.51], [0.097, 0.023, -0.0494, -0.118, -0.17894, -0.18488, -0.13913, 0.09558, 0.13688, 0.06025, -0.09154, -0.12659, 0.14523, 0.14333, -0.0265, -0.12372, -0.05795, -0.00941, -0.01879, -0.59462, -1.05817, -0.90851, -0.69178, -0.45026, -0.20516, -0.20688], "llmlhhhhlhlhhlhmhlmhmmmlll"],
  "diversity-05": [4, [518, 520.47, 523.24, 523.99, 519.24, 518, 515.91, 516.01, 519.14, 522, 514.75, 511, 512.47, 518.72, 527.01, 524.84, 521.61, 519.9, 521.72, 518.25, 476.84, 448.97, 432.24, 415, 410.05, 405.51], [0.1235, 0.131, 0.0704, -0.05714, -0.09076, -0.07744, -0.08652, 0.07512, 0.07779, -0.05487, -0.14103, -0.05182, 0.17545, 0.18641, 0.0765, -0.06923, -0.11227, 0.00324, -0.02845, -0.69046, -1.15467, -0.94894, -0.75489, -0.58395, -0.30613, -0.28375], "llmhmmhhlmlllhmllllhmlmlll"],
  "diversity-06": [4, [518, 521.01, 524.35, 527, 528.91, 525.98, 528.51, 528.54, 527.99, 528.01, 526.4, 529.52, 529.59, 531.62, 532, 529.01, 525.02, 525.92, 528.97, 528.25, 485.42, 459, 438.57, 415.5, 410.18, 405.51], [0.1505, 0.15875, 0.1198, 0.06514, -0.01545, -0.0093, 0.1113, -0.01209, -0.00688, -0.01988, 0.01936, 0.0725, 0.04773, 0.0309, -0.03263, -0.08949, -0.07023, 0.11618, 0.04017, -0.67, -1.15417, -0.99681, -0.96667, -0.74711, -0.32226, -0.29188], "llhlmmhhhlmhhhlmhhmhlmhlll"],
  "diversity-07": [4, [518, 520.9, 525.81, 529.86, 534.98, 539.56, 538.97, 538.98, 536.43, 530.88, 532.2, 533.39, 533.45, 533.4, 534.99, 535.71, 537.46, 538.01, 539.98, 536.94, 493.14, 467.12, 443.15, 419.39, 410.82, 405.51], [0.145, 0.19525, 0.1792, 0.131, 0.14697, 0.09279, -0.02522, -0.05907, -0.10519, -0.05287, 0.03218, 0.02841, 0.00023, 0.01974, 0.02888, 0.03167, 0.05227, 0.07412, -0.01845, -0.72062, -1.16367, -1.06362, -1.06067, -0.85079, -0.44774, -0.33188], "llhmlmlllhhhlmhhlhhllhllll"],
  "diversity-08": [4, [518, 522.34, 526.02, 535.25, 541.81, 546.84, 549.95, 549.95, 541.87, 535.89, 539.5, 544.78, 544.18, 544.83, 543, 547.06, 549.34, 549.51, 553.27, 557.88], [0.217, 0.2005, 0.2582, 0.22557, 0.17561, 0.1893, 0.13522, -0.18791, -0.1826, -0.02963, 0.11397, 0.10636, 0.00114, -0.01513, 0.02787, 0.08128, 0.05568, 0.11559, 0.14431, 0.15367], "llhhhmllhllhlhllllhh"],
  "diversity-09": [4, [518, 522.62, 529.56, 539.93, 553, 559.64, 560.31, 560.53, 562.83, 563.25], [0.231, 0.289, 0.3462, 0.33486, 0.29864, 0.17, 0.0387, 0.0586, 0.03532, 0.0105], "llllhhhllh"],
});

const REJECTIONS: Readonly<Record<string, Readonly<{
  stage: "gen1" | "gen2" | "genn";
  tangent: Point;
  end: Point;
}>>> = Object.freeze({
  "anchor-03": { stage: "gen1", tangent: { x: 826, y: 266 }, end: { x: 842, y: 268 } },
  "anchor-08": { stage: "gen2", tangent: { x: 976, y: 251 }, end: { x: 987, y: 253 } },
  "elite-12": { stage: "gen1", tangent: { x: 826, y: 423 }, end: { x: 842, y: 427 } },
  "elite-13": { stage: "genn", tangent: { x: 992, y: 424 }, end: { x: 1010, y: 426 } },
  "diversity-08": { stage: "genn", tangent: { x: 1122, y: 559 }, end: { x: 1133, y: 561 } },
  "diversity-09": { stage: "gen1", tangent: { x: 814, y: 564 }, end: { x: 826, y: 566 } },
});

const CANDIDATE_SPECS: readonly CandidateSpec[] = [
  { id: "anchor-01", band: "anchor", emphasis: "foreground" },
  { id: "anchor-02", band: "anchor", emphasis: "middle" },
  { id: "anchor-03", band: "anchor", emphasis: "middle" },
  { id: "anchor-04", band: "anchor", emphasis: "background" },
  { id: "anchor-05", band: "anchor", emphasis: "middle" },
  { id: "anchor-06", band: "anchor", emphasis: "foreground" },
  { id: "anchor-07", band: "anchor", emphasis: "middle" },
  { id: "anchor-08", band: "anchor", emphasis: "middle" },
  { id: "anchor-09", band: "anchor", emphasis: "middle" },
  { id: "anchor-10", band: "anchor", emphasis: "background" },
  { id: "anchor-11", band: "anchor", emphasis: "foreground" },
  { id: "elite-01", band: "elite", emphasis: "middle" },
  { id: "elite-02", band: "elite", emphasis: "background" },
  { id: "elite-03", band: "elite", emphasis: "middle" },
  { id: "elite-04", band: "elite", emphasis: "foreground" },
  { id: "elite-05", band: "elite", emphasis: "middle" },
  { id: "elite-06", band: "elite", emphasis: "middle" },
  { id: "elite-07", band: "elite", emphasis: "hero" },
  { id: "elite-08", band: "elite", emphasis: "middle" },
  { id: "elite-09", band: "elite", emphasis: "middle" },
  { id: "elite-10", band: "elite", emphasis: "foreground" },
  { id: "elite-11", band: "elite", emphasis: "middle" },
  { id: "elite-12", band: "elite", emphasis: "middle" },
  { id: "elite-13", band: "elite", emphasis: "middle" },
  { id: "diversity-01", band: "diversity", emphasis: "foreground" },
  { id: "diversity-02", band: "diversity", emphasis: "middle" },
  { id: "diversity-03", band: "diversity", emphasis: "background" },
  { id: "diversity-04", band: "diversity", emphasis: "middle" },
  { id: "diversity-05", band: "diversity", emphasis: "foreground" },
  { id: "diversity-06", band: "diversity", emphasis: "middle" },
  { id: "diversity-07", band: "diversity", emphasis: "background" },
  { id: "diversity-08", band: "diversity", emphasis: "middle" },
  { id: "diversity-09", band: "diversity", emphasis: "middle" },
] as const;

const TRACK_STYLE: Record<Emphasis, { width: number; opacity: number; haloWidth: number; haloOpacity: number }> = {
  background: { width: 0.76, opacity: 0.19, haloWidth: 3, haloOpacity: 0.055 },
  middle: { width: 0.9, opacity: 0.32, haloWidth: 3.4, haloOpacity: 0.075 },
  foreground: { width: 1.02, opacity: 0.46, haloWidth: 3.9, haloOpacity: 0.11 },
  hero: { width: 2, opacity: 0.98, haloWidth: 5.2, haloOpacity: 0.25 },
};

type ReferencePathSample = Readonly<{
  point: Point;
  measuredSlope: number;
  confidence: ReferenceConfidence;
}>;

function secantSlope(a: Point, b: Point): number {
  return (b.y - a.y) / (b.x - a.x);
}

function envelopeSlope(samples: readonly ReferencePathSample[], index: number): number {
  if (index === 0) return secantSlope(samples[0].point, samples[1].point);
  if (index === samples.length - 1) return secantSlope(samples[index - 1].point, samples[index].point);

  const previous = samples[index - 1].point;
  const current = samples[index].point;
  const next = samples[index + 1].point;
  const leftSpan = current.x - previous.x;
  const rightSpan = next.x - current.x;
  const left = secantSlope(previous, current);
  const right = secantSlope(current, next);
  return (left * rightSpan + right * leftSpan) / (leftSpan + rightSpan);
}

function referenceSlope(samples: readonly ReferencePathSample[], index: number): number {
  const sample = samples[index];
  const envelope = envelopeSlope(samples, index);
  const trust = sample.confidence === "h" ? 0.9 : sample.confidence === "m" ? 0.68 : 0.34;
  const blended = sample.measuredSlope * trust + envelope * (1 - trust);
  const adjacent = [
    index > 0 ? Math.abs(secantSlope(samples[index - 1].point, sample.point)) : 0,
    index < samples.length - 1 ? Math.abs(secantSlope(sample.point, samples[index + 1].point)) : 0,
  ];
  const limit = Math.max(0.08, ...adjacent) * 2.4;
  return Math.max(-limit, Math.min(limit, blended));
}

function controlReach(samples: readonly ReferencePathSample[], index: number): number {
  if (index === 0) return (samples[1].point.x - samples[0].point.x) / 3;
  if (index === samples.length - 1) return (samples[index].point.x - samples[index - 1].point.x) / 3;
  const left = samples[index].point.x - samples[index - 1].point.x;
  const right = samples[index + 1].point.x - samples[index].point.x;
  return Math.min(left, right) / 3;
}

function svgNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

// Cubic Hermite controls share the same handle at each knot. This keeps the
// joined path C1 while every control x remains inside its strictly increasing segment.
function referencePathD(samples: readonly ReferencePathSample[]): string {
  if (samples.length === 0) return "";
  if (samples.length === 1) return "M" + svgNumber(samples[0].point.x) + " " + svgNumber(samples[0].point.y);

  const slopes = samples.map((_, index) => referenceSlope(samples, index));
  const reaches = samples.map((_, index) => controlReach(samples, index));
  let d = "M" + svgNumber(samples[0].point.x) + " " + svgNumber(samples[0].point.y);

  for (let index = 0; index < samples.length - 1; index += 1) {
    const current = samples[index].point;
    const next = samples[index + 1].point;
    const c1x = current.x + reaches[index];
    const c2x = next.x - reaches[index + 1];
    const c1y = current.y + slopes[index] * reaches[index];
    const c2y = next.y - slopes[index + 1] * reaches[index + 1];
    d += " C" + svgNumber(c1x) + " " + svgNumber(c1y)
      + " " + svgNumber(c2x) + " " + svgNumber(c2y)
      + " " + svgNumber(next.x) + " " + svgNumber(next.y);
  }
  return d;
}

function releasePoint(spec: CandidateSpec): Point {
  if (spec.band === "anchor") return { x: 570, y: 256 };
  if (spec.band === "diversity") return { x: 570, y: 518 };
  if (spec.id === "elite-07") return GEOMETRY.nodes.eliteJunction;
  return { x: 570, y: Number(spec.id.slice(-2)) < 7 ? 372 : 411 };
}

function buildCandidatePath(spec: CandidateSpec): CandidatePath {
  const geometry = REFERENCE_CANDIDATE_GEOMETRY[spec.id];
  if (!geometry) throw new Error("Missing reference geometry for " + spec.id);
  const [sampleOffset, centerY, measuredSlope, confidence] = geometry;
  if (centerY.length < 2 || centerY.length !== measuredSlope.length || centerY.length !== confidence.length) {
    throw new Error("Mismatched reference geometry for " + spec.id);
  }
  if (sampleOffset < 0 || sampleOffset + centerY.length > REFERENCE_SAMPLE_X.length) {
    throw new Error("Out-of-range reference geometry for " + spec.id);
  }
  if (!centerY.every(Number.isFinite) || !measuredSlope.every(Number.isFinite) || !/^[hml]+$/.test(confidence)) {
    throw new Error("Invalid reference samples for " + spec.id);
  }

  const samples: ReferencePathSample[] = centerY.map((y, index) => ({
    point: { x: REFERENCE_SAMPLE_X[sampleOffset + index], y },
    measuredSlope: measuredSlope[index],
    confidence: confidence[index] as ReferenceConfidence,
  }));
  const rejection = REJECTIONS[spec.id];

  // Endpoint ridge samples are low confidence because bright junctions bias the
  // detector. Pin only those seams to the frozen feeder/public topology.
  const release = releasePoint(spec);
  if (samples[0].point.x !== release.x) throw new Error("Invalid release point for " + spec.id);
  samples[0] = { ...samples[0], point: release };
  if (!rejection) {
    samples[samples.length - 1] = { ...samples[samples.length - 1], point: GEOMETRY.nodes.public };
  }

  if (rejection) {
    const last = samples[samples.length - 1].point;
    if (last.x >= rejection.tangent.x || rejection.tangent.x >= rejection.end.x) {
      throw new Error("Non-monotonic rejection geometry for " + spec.id);
    }
    const incoming = secantSlope(last, rejection.tangent);
    const outgoing = secantSlope(rejection.tangent, rejection.end);
    samples.push(
      { point: rejection.tangent, measuredSlope: (incoming + outgoing) / 2, confidence: "h" },
      { point: rejection.end, measuredSlope: outgoing, confidence: "h" },
    );
  }
  const points = samples.map((sample) => sample.point);

  return {
    id: spec.id,
    band: spec.band,
    points,
    d: referencePathD(samples),
    emphasis: spec.emphasis,
    status: rejection ? "rejected" : "survivor",
    survivesTo: rejection?.stage ?? "public",
    rejectedAt: rejection ? { stage: rejection.stage, point: rejection.end } : undefined,
  };
}

const CANDIDATE_PATHS = CANDIDATE_SPECS.map(buildCandidatePath);
const CANDIDATE_BY_ID = new Map(CANDIDATE_PATHS.map((candidate) => [candidate.id, candidate] as const));
const candidateRef = (id: string): StagePathRef => ({ id, kind: "candidate" });
const pathRef = (id: string, kind: Exclude<PathKind, "candidate">): StagePathRef => ({ id, kind });
const POPULATION_SECONDARY = CANDIDATE_PATHS.filter((candidate) => candidate.id !== "elite-07").map((candidate) => candidateRef(candidate.id));
const PUBLIC_SECONDARY = CANDIDATE_PATHS.filter((candidate) => candidate.status === "survivor" && candidate.id !== "elite-07").map((candidate) => candidateRef(candidate.id));

const STAGE_VISUAL_SPEC: readonly StageVisualSpec[] = Object.freeze([
  {
    id: "input",
    maskRange: [0, 208],
    secondaryPaths: [],
    heroPaths: [pathRef("input-spine", "structure")],
    nodes: ["input"],
    gates: false,
    rejections: false,
    particlePaths: [pathRef("input-spine", "structure")],
  },
  {
    id: "confirm",
    maskRange: [208, 412],
    secondaryPaths: [],
    heroPaths: [pathRef("input-spine", "structure")],
    nodes: ["confirm"],
    gates: false,
    rejections: false,
    particlePaths: [pathRef("input-spine", "structure")],
  },
  {
    id: "roots",
    maskRange: [395, 620],
    secondaryPaths: [
      pathRef("b0-anchor-feeder", "structure"),
      pathRef("b0-elite-feeder", "structure"),
      pathRef("s0-elite-feeder", "structure"),
      pathRef("s0-diversity-feeder", "structure"),
    ],
    heroPaths: [pathRef("branch-b0", "structure"), pathRef("branch-s0", "structure")],
    nodes: ["b0", "s0"],
    gates: false,
    rejections: false,
    particlePaths: [pathRef("branch-b0", "structure"), pathRef("branch-s0", "structure"), pathRef("b0-anchor-feeder", "structure"), pathRef("s0-diversity-feeder", "structure")],
  },
  {
    id: "population",
    maskRange: [516, 1246],
    secondaryPaths: [
      ...POPULATION_SECONDARY,
      pathRef("b0-anchor-feeder", "structure"),
      pathRef("b0-elite-feeder", "structure"),
      pathRef("s0-elite-feeder", "structure"),
      pathRef("s0-diversity-feeder", "structure"),
    ],
    heroPaths: [candidateRef("elite-07")],
    nodes: ["b0", "s0", "public"],
    gates: true,
    rejections: true,
    particlePaths: [candidateRef("elite-07"), candidateRef("anchor-01"), candidateRef("anchor-06"), candidateRef("elite-04"), candidateRef("diversity-01"), candidateRef("diversity-05")],
  },
  {
    id: "public",
    maskRange: [1049, 1336],
    secondaryPaths: [...PUBLIC_SECONDARY, pathRef("comparison-upper", "rail"), pathRef("comparison-lower", "rail")],
    heroPaths: [candidateRef("elite-07")],
    nodes: ["public"],
    gates: false,
    rejections: false,
    particlePaths: [candidateRef("elite-07"), candidateRef("anchor-01"), candidateRef("diversity-01"), pathRef("comparison-upper", "rail"), pathRef("comparison-lower", "rail")],
  },
  {
    id: "direct",
    maskRange: [516, 1613],
    secondaryPaths: [pathRef("comparison-upper", "rail"), pathRef("comparison-lower", "rail")],
    heroPaths: [pathRef("direct-baseline", "direct")],
    nodes: ["directStart", "directEnd", "public"],
    gates: false,
    rejections: false,
    particlePaths: [pathRef("direct-baseline", "direct"), pathRef("comparison-upper", "rail"), pathRef("comparison-lower", "rail")],
  },
  {
    id: "holdout",
    maskRange: [1529, 1764],
    secondaryPaths: [],
    heroPaths: [pathRef("comparison-upper", "rail"), pathRef("comparison-lower", "rail")],
    nodes: ["decision"],
    gates: false,
    rejections: false,
    particlePaths: [pathRef("comparison-upper", "rail"), pathRef("comparison-lower", "rail")],
  },
  {
    id: "decision",
    maskRange: [1731, 1925],
    secondaryPaths: [],
    heroPaths: [pathRef("outcome-adopt", "final"), pathRef("outcome-retain", "final"), pathRef("outcome-failed", "final")],
    nodes: ["decision", "adopt", "retain", "failed"],
    gates: false,
    rejections: false,
    particlePaths: [pathRef("outcome-adopt", "final"), pathRef("outcome-retain", "final"), pathRef("outcome-failed", "final")],
  },
]);

for (const candidate of CANDIDATE_PATHS) {
  if (candidate.points.some((value) => !Number.isFinite(value.x) || !Number.isFinite(value.y))) {
    throw new Error(`Invalid geometry for ${candidate.id}`);
  }
  if (candidate.points.some((value, index) => index > 0 && value.x <= candidate.points[index - 1].x)) {
    throw new Error(`Non-monotonic geometry for ${candidate.id}`);
  }
}

type StructureVariant = "primary" | "rail" | "final";

const STRUCTURE_STYLE: Record<StructureVariant, Readonly<{
  farWidth: number;
  farOpacity: number;
  nearWidth: number;
  nearOpacity: number;
  coreWidth: number;
  coreOpacity: number;
}>> = {
  primary: { farWidth: 9, farOpacity: 0.12, nearWidth: 4.2, nearOpacity: 0.28, coreWidth: 1.9, coreOpacity: 0.96 },
  rail: { farWidth: 6.4, farOpacity: 0.065, nearWidth: 3, nearOpacity: 0.15, coreWidth: 1.45, coreOpacity: 0.76 },
  final: { farWidth: 6, farOpacity: 0.06, nearWidth: 2.8, nearOpacity: 0.14, coreWidth: 1.4, coreOpacity: 0.74 },
};

function LayeredStructurePath({
  href,
  farGlowId,
  nearGlowId,
  emphasis = 1,
  variant = "primary",
}: {
  href: string;
  farGlowId: string;
  nearGlowId: string;
  emphasis?: number;
  variant?: StructureVariant;
}) {
  const style = STRUCTURE_STYLE[variant];
  return (
    <g>
      <use href={href} className="structure-halo" strokeWidth={style.farWidth} opacity={style.farOpacity * emphasis} filter={`url(#${farGlowId})`} />
      <use href={href} className="structure-glow" strokeWidth={style.nearWidth} opacity={style.nearOpacity * emphasis} filter={`url(#${nearGlowId})`} />
      <use href={href} className="structure-core" strokeWidth={style.coreWidth} opacity={Math.min(1, style.coreOpacity * emphasis)} />
    </g>
  );
}

const ACTIVE_TRACK_STYLE: Record<Emphasis, Readonly<{
  width: number;
  opacity: number;
  haloWidth: number;
  haloOpacity: number;
}>> = {
  background: { width: 0.82, opacity: 0.075, haloWidth: 3.1, haloOpacity: 0.045 },
  middle: { width: 0.94, opacity: 0.145, haloWidth: 3.5, haloOpacity: 0.065 },
  foreground: { width: 1.08, opacity: 0.215, haloWidth: 4, haloOpacity: 0.1 },
  hero: { width: 2.25, opacity: 0.92, haloWidth: 5.4, haloOpacity: 0.28 },
};

function ActiveOverlayPath({
  path,
  hero,
  prefix,
  farGlowId,
  nearGlowId,
  softGlowId,
}: {
  path: StagePathRef;
  hero: boolean;
  prefix: string;
  farGlowId: string;
  nearGlowId: string;
  softGlowId: string;
}) {
  const href = `#${prefix}-${path.id}`;
  const candidate = path.kind === "candidate" ? CANDIDATE_BY_ID.get(path.id) : undefined;

  if (candidate) {
    const emphasis = hero ? "hero" : candidate.emphasis;
    const style = ACTIVE_TRACK_STYLE[emphasis];
    return (
      <g data-active-path={path.id} data-active-kind={path.kind}>
        {emphasis === "hero" && (
          <use href={href} className="active-path-far" strokeWidth="8.5" opacity="0.08" filter={`url(#${farGlowId})`} />
        )}
        <use href={href} className="active-path-halo" strokeWidth={style.haloWidth} opacity={style.haloOpacity} filter={`url(#${softGlowId})`} />
        <use href={href} className="active-path-core" strokeWidth={style.width} opacity={style.opacity} />
      </g>
    );
  }

  const isFeeder = path.id.endsWith("feeder");
  const rail = path.kind === "rail";
  const final = path.kind === "final";
  const coreWidth = hero ? (rail ? 1.72 : 2.35) : isFeeder ? 1.1 : final ? 1.5 : rail ? 1.25 : 1.35;
  const coreOpacity = hero ? (rail ? 0.88 : 0.98) : isFeeder ? 0.54 : final ? 0.82 : rail ? 0.7 : 0.76;
  const haloWidth = hero ? (rail ? 4.5 : 5.4) : isFeeder ? 3.5 : 4.1;
  const haloOpacity = hero ? (rail ? 0.19 : 0.3) : isFeeder ? 0.09 : 0.14;
  const dash = path.kind === "direct" ? "5 5" : undefined;

  return (
    <g data-active-path={path.id} data-active-kind={path.kind}>
      {hero && !rail && (
        <use href={href} className="active-path-far" strokeWidth="9" opacity="0.075" filter={`url(#${farGlowId})`} strokeDasharray={dash} />
      )}
      <use href={href} className="active-path-halo" strokeWidth={haloWidth} opacity={haloOpacity} filter={`url(#${nearGlowId})`} strokeDasharray={dash} />
      <use href={href} className="active-path-core" strokeWidth={coreWidth} opacity={coreOpacity} strokeDasharray={dash} />
    </g>
  );
}

const NODE_RADIUS: Readonly<Record<NodeId, number>> = Object.freeze({
  input: 5.5,
  confirm: 7,
  b0: 6.5,
  s0: 6.5,
  public: 7,
  directStart: 4.5,
  directEnd: 4.5,
  decision: 7,
  adopt: 5.5,
  retain: 5.5,
  failed: 5.5,
});

function particleDuration(path: StagePathRef): number {
  if (path.kind === "direct") return 8;
  if (path.kind === "candidate") return 5.8;
  if (path.kind === "rail") return 5.2;
  if (path.kind === "final") return 4.2;
  return 4.5;
}

const FIXED_PATH_X_RANGES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  "input-spine": [31, 395],
  "branch-b0": [395, 516],
  "branch-s0": [395, 516],
  "b0-anchor-feeder": [516, 570],
  "b0-elite-feeder": [516, 610],
  "s0-elite-feeder": [516, 610],
  "s0-diversity-feeder": [516, 570],
  "direct-baseline": [516, 1425],
  "comparison-upper": [1246, 1764],
  "comparison-lower": [1246, 1764],
  "outcome-adopt": [1764, 1826],
  "outcome-retain": [1764, 1826],
  "outcome-failed": [1764, 1826],
});

function pathXRange(path: StagePathRef): readonly [number, number] {
  if (path.kind === "candidate") {
    const points = CANDIDATE_BY_ID.get(path.id)?.points;
    if (points?.length) return [points[0].x, points[points.length - 1].x];
  }
  return FIXED_PATH_X_RANGES[path.id] ?? [0, VIEWBOX.width];
}

function particleKeyPoints(path: StagePathRef, maskRange: readonly [number, number]): string {
  const [pathStart, pathEnd] = pathXRange(path);
  const span = Math.max(1, pathEnd - pathStart);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const start = clamp((maskRange[0] - pathStart) / span);
  const end = clamp((maskRange[1] - pathStart) / span);
  return `${start.toFixed(4)};${Math.max(start + 0.0001, end).toFixed(4)}`;
}

export function GenomeFlow({
  activeStage,
  reduced,
  onStageChange,
}: {
  activeStage: number;
  reduced: boolean;
  onStageChange: (stage: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const prefix = `skillfoo-flow-${reactId}`;
  const farGlowId = `${prefix}-far-halo`;
  const nearGlowId = `${prefix}-near-glow`;
  const softGlowId = `${prefix}-soft-glow`;
  const stageMaskIds = STAGE_VISUAL_SPEC.map((stage) => `${prefix}-stage-mask-${stage.id}`);
  const stageGradientIds = STAGE_VISUAL_SPEC.map((stage) => `${prefix}-stage-gradient-${stage.id}`);
  const activeSpec = STAGE_VISUAL_SPEC[activeStage] ?? STAGE_VISUAL_SPEC[0];
  const flowParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : undefined;
  const staticFlow = flowParams?.get("flowStatic") === "1";
  const forcedReduced = flowParams?.get("flowReduced") === "1";
  const effectiveReduced = reduced || forcedReduced;
  const motionEnabled = !effectiveReduced && !staticFlow;
  const propagationPaths = activeSpec.heroPaths.length > 0
    ? activeSpec.heroPaths.slice(0, 3)
    : activeSpec.secondaryPaths.slice(0, 1);
  const activeParticlePaths = activeSpec.particlePaths.slice(0, 7);
  const heroParticleKeys = new Set(activeSpec.heroPaths.map((path) => `${path.kind}:${path.id}`));

  useEffect(() => {
    const container = containerRef.current;
    const scroller = container?.parentElement;
    if (!container || !scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    const stage = GEOMETRY.stages[activeStage];
    const target = (stage.x / VIEWBOX.width) * container.clientWidth - scroller.clientWidth / 2;
    scroller.scrollTo({
      left: Math.max(0, Math.min(target, scroller.scrollWidth - scroller.clientWidth)),
      behavior: effectiveReduced || staticFlow ? "auto" : "smooth",
    });
  }, [activeStage, effectiveReduced, staticFlow]);

  return (
    <div
      className={[
        "genome-canvas",
        effectiveReduced ? "is-motion-reduced" : "",
        staticFlow ? "is-flow-static" : "",
      ].filter(Boolean).join(" ")}
      data-motion-state={effectiveReduced ? "reduced" : staticFlow ? "static" : "active"}
      ref={containerRef}
    >
      <svg
        className="genome-svg"
        viewBox="0 0 1925 817"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-labelledby={`${prefix}-title ${prefix}-desc`}
        focusable="false"
        shapeRendering="geometricPrecision"
      >
        <title id={`${prefix}-title`}>SkillFoo U1 八阶段受控演化轨迹</title>
        <desc id={`${prefix}-desc`}>
          输入经过双重确认后分为 B0 与 S0；Anchor、Elite 与 Diversity 的三十三条确定性候选轨迹经过 Gen 1、Gen 2 与 Gen N 的选择和淘汰，在公共选择汇聚。Direct 使用独立基线，公共结果经上下双轨进入 Sealed Holdout，最终形成采用、保留或失败。
        </desc>
        <defs>
          <filter id={farGlowId} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="-40" y="-40" width="2005" height="897" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <filter id={nearGlowId} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="-30" y="-30" width="1985" height="877" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="2" />
          </filter>
          <filter id={softGlowId} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="-24" y="-24" width="1973" height="865" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="1.25" />
          </filter>

          {STAGE_VISUAL_SPEC.map((stage, index) => {
            const [start, end] = stage.maskRange;
            const feather = 32;
            const leftOuter = Math.max(0, start - feather);
            const rightOuter = Math.min(VIEWBOX.width, end + feather);
            const toPercent = (value: number) => `${(value / VIEWBOX.width) * 100}%`;
            return (
              <g key={stage.id}>
                <linearGradient id={stageGradientIds[index]} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={VIEWBOX.width} y2="0">
                  <stop offset={toPercent(leftOuter)} stopColor="#000" />
                  <stop offset={toPercent(start)} stopColor="#fff" />
                  <stop offset={toPercent(end)} stopColor="#fff" />
                  <stop offset={toPercent(rightOuter)} stopColor="#000" />
                </linearGradient>
                <mask id={stageMaskIds[index]} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width={VIEWBOX.width} height={VIEWBOX.height}>
                  <rect x="0" y="0" width={VIEWBOX.width} height={VIEWBOX.height} fill={`url(#${stageGradientIds[index]})`} />
                </mask>
              </g>
            );
          })}

          {GEOMETRY.primaryStructurePaths.map((path) => (
            <path key={path.id} id={`${prefix}-${path.id}`} d={path.d} />
          ))}
          <path id={`${prefix}-direct-baseline`} d={GEOMETRY.directBaseline.d} />
          {GEOMETRY.comparisonRails.map((path) => (
            <path key={path.id} id={`${prefix}-${path.id}`} d={path.d} />
          ))}
          {GEOMETRY.finalBranches.map((path) => (
            <path key={path.id} id={`${prefix}-${path.id}`} d={path.d} />
          ))}
          {CANDIDATE_PATHS.map((candidate) => (
            <path
              key={candidate.id}
              id={`${prefix}-${candidate.id}`}
              d={candidate.d}
              data-role="candidate"
              data-track-id={candidate.id}
              data-band={candidate.band}
              data-status={candidate.status}
              data-survives-to={candidate.survivesTo}
            />
          ))}
        </defs>

        <rect className="genome-background" x="0" y="0" width={VIEWBOX.width} height={VIEWBOX.height} />

        <g className="stage-axis-layer" aria-hidden="true">
          {GEOMETRY.stageAxes.map((axis) => {
            const active = axis.stage === activeStage;
            return (
              <g key={axis.x} className={active ? "is-active" : undefined}>
                <line className="stage-axis" x1={axis.x} y1="108" x2={axis.x} y2="758" />
                {active && <circle className="stage-marker-halo" cx={axis.x} cy="102" r="10" filter={`url(#${nearGlowId})`} />}
                <circle className="stage-marker" cx={axis.x} cy="102" r="5.5" />
              </g>
            );
          })}
        </g>

        <g className="direct-layer base-path-layer" aria-hidden="true">
          <use
            href={`#${prefix}-direct-baseline`}
            className="direct-baseline"
            strokeWidth="1.1"
            opacity="0.52"
          />
          <circle className="minor-node" cx={GEOMETRY.nodes.directStart.x} cy={GEOMETRY.nodes.directStart.y} r="4.5" />
          <circle className="minor-node" cx={GEOMETRY.nodes.directEnd.x} cy={GEOMETRY.nodes.directEnd.y} r="4.5" />
        </g>

        <g className="candidate-layer base-path-layer" aria-hidden="true">
          <g className="candidate-halo-layer">
            {CANDIDATE_PATHS.map((candidate) => {
              const style = TRACK_STYLE[candidate.id === "elite-07" ? "middle" : candidate.emphasis];
              return (
                <use
                  key={candidate.id}
                  href={`#${prefix}-${candidate.id}`}
                  className={`candidate-halo candidate-${candidate.emphasis}`}
                  strokeWidth={style.haloWidth}
                  opacity={style.haloOpacity}
                  filter={`url(#${softGlowId})`}
                />
              );
            })}
          </g>
          <g className="candidate-core-layer">
            {CANDIDATE_PATHS.map((candidate) => {
              const style = TRACK_STYLE[candidate.id === "elite-07" ? "middle" : candidate.emphasis];
              return (
                <use
                  key={candidate.id}
                  href={`#${prefix}-${candidate.id}`}
                  className={`candidate-core candidate-${candidate.emphasis}`}
                  strokeWidth={style.width}
                  opacity={style.opacity}
                  data-track-id={candidate.id}
                  data-status={candidate.status}
                />
              );
            })}
          </g>
        </g>

        <g className="primary-structure-layer base-path-layer" aria-hidden="true">
          {GEOMETRY.primaryStructurePaths.map((path) => {
            const feeder = path.id.endsWith("feeder");
            return (
              <LayeredStructurePath
                key={path.id}
                href={`#${prefix}-${path.id}`}
                farGlowId={farGlowId}
                nearGlowId={nearGlowId}
                emphasis={feeder ? 0.92 : 0.96}
              />
            );
          })}
        </g>

        <g className="comparison-rail-layer base-path-layer" aria-hidden="true">
          {GEOMETRY.comparisonRails.map((path) => (
            <LayeredStructurePath
              key={path.id}
              href={`#${prefix}-${path.id}`}
              farGlowId={farGlowId}
              nearGlowId={nearGlowId}
              emphasis={0.84}
              variant="rail"
            />
          ))}
        </g>

        <g className="final-branch-layer base-path-layer" aria-hidden="true">
          {GEOMETRY.finalBranches.map((path) => (
            <LayeredStructurePath
              key={path.id}
              href={`#${prefix}-${path.id}`}
              farGlowId={farGlowId}
              nearGlowId={nearGlowId}
              emphasis={0.84}
              variant="final"
            />
          ))}
        </g>

        <g className="generation-gate-layer base-path-layer" aria-hidden="true">
          {GEOMETRY.generationGates.map((gate) => (
            <g key={gate.id} data-generation={gate.id}>
              <line className="generation-axis" x1={gate.x} y1="151" x2={gate.x} y2="580" />
              <circle className="generation-marker" cx={gate.x} cy="144" r="5.5" />
              {gate.segments.map(([start, end], index) => (
                <g key={index}>
                  <line className="gate-segment-halo" x1={gate.x} y1={start} x2={gate.x} y2={end} strokeWidth="6" opacity="0.075" filter={`url(#${farGlowId})`} />
                  <line className="gate-segment-glow" x1={gate.x} y1={start} x2={gate.x} y2={end} strokeWidth="3.2" opacity="0.18" filter={`url(#${nearGlowId})`} />
                  <line className="gate-segment-core" x1={gate.x} y1={start} x2={gate.x} y2={end} strokeWidth="1.35" opacity="0.62" />
                </g>
              ))}
            </g>
          ))}
        </g>

        <g className="rejection-layer base-path-layer" aria-hidden="true">
          {CANDIDATE_PATHS.filter((candidate) => candidate.rejectedAt).map((candidate) => {
            const center = candidate.rejectedAt!.point;
            const half = 5;
            return (
              <g key={candidate.id} data-rejected-track={candidate.id}>
                <line x1={center.x - half} y1={center.y - half} x2={center.x + half} y2={center.y + half} />
                <line x1={center.x + half} y1={center.y - half} x2={center.x - half} y2={center.y + half} />
              </g>
            );
          })}
        </g>

        {STAGE_VISUAL_SPEC.map((stage, index) => (
          <g
            key={stage.id}
            className={activeStage === index ? "active-overlay-stage is-active" : "active-overlay-stage"}
            data-stage-overlay={stage.id}
            mask={`url(#${stageMaskIds[index]})`}
            aria-hidden="true"
          >
            {stage.secondaryPaths.map((path) => (
              <ActiveOverlayPath
                key={`secondary-${path.kind}-${path.id}`}
                path={path}
                hero={false}
                prefix={prefix}
                farGlowId={farGlowId}
                nearGlowId={nearGlowId}
                softGlowId={softGlowId}
              />
            ))}
            {stage.heroPaths.map((path) => (
              <ActiveOverlayPath
                key={`hero-${path.kind}-${path.id}`}
                path={path}
                hero
                prefix={prefix}
                farGlowId={farGlowId}
                nearGlowId={nearGlowId}
                softGlowId={softGlowId}
              />
            ))}
            {stage.gates && GEOMETRY.generationGates.map((gate) => (
              <g key={`active-${gate.id}`} className="active-gate-segments">
                {gate.segments.map(([start, end], segmentIndex) => (
                  <g key={segmentIndex}>
                    <line x1={gate.x} y1={start} x2={gate.x} y2={end} className="active-gate-halo" strokeWidth="4.2" opacity="0.14" filter={`url(#${nearGlowId})`} />
                    <line x1={gate.x} y1={start} x2={gate.x} y2={end} className="active-gate-core" strokeWidth="1.55" opacity="0.78" />
                  </g>
                ))}
              </g>
            ))}
            {stage.rejections && CANDIDATE_PATHS.filter((candidate) => candidate.rejectedAt).map((candidate) => {
              const center = candidate.rejectedAt!.point;
              const half = 5;
              return (
                <g key={`active-rejection-${candidate.id}`} className="active-rejection">
                  <line x1={center.x - half} y1={center.y - half} x2={center.x + half} y2={center.y + half} />
                  <line x1={center.x + half} y1={center.y - half} x2={center.x - half} y2={center.y + half} />
                </g>
              );
            })}
          </g>
        ))}

        {motionEnabled && propagationPaths.length > 0 && (
          <g
            key={`particles-${activeStage}`}
            className="flow-particle-layer"
            mask={`url(#${stageMaskIds[activeStage]})`}
            aria-hidden="true"
            pointerEvents="none"
          >
            {propagationPaths.map((path) => (
              <circle key={`propagation-${path.kind}-${path.id}`} className="flow-particle flow-particle-propagation" r="2" opacity="0">
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.14;0.78;1" dur="0.82s" begin="0s" fill="freeze" />
                <animateMotion
                  dur="0.82s"
                  begin="0s"
                  fill="freeze"
                  calcMode="linear"
                  keyPoints={particleKeyPoints(path, activeSpec.maskRange)}
                  keyTimes="0;1"
                >
                  <mpath href={`#${prefix}-${path.id}`} />
                </animateMotion>
              </circle>
            ))}
            {activeParticlePaths.map((path, index) => {
              const heroPeer = heroParticleKeys.has(`${path.kind}:${path.id}`);
              const singleHero = activeSpec.heroPaths.length === 1 && heroPeer;
              const duration = particleDuration(path);
              const begin = Number((1.05 + index * 0.55).toFixed(2));
              const radius = singleHero ? 1.9 : heroPeer ? 1.55 : 1.15;
              const targetOpacity = singleHero ? 0.9 : heroPeer ? 0.7 : 0.46;
              return (
                <circle
                  key={`${path.kind}-${path.id}`}
                  className={singleHero ? "flow-particle flow-particle-primary" : heroPeer ? "flow-particle flow-particle-peer" : "flow-particle flow-particle-secondary"}
                  r={radius}
                  opacity="0"
                  filter={singleHero || heroPeer ? `url(#${softGlowId})` : undefined}
                >
                  <animate attributeName="opacity" values={`0;${targetOpacity}`} dur="0.28s" begin={`${begin}s`} fill="freeze" />
                  <animateMotion
                    dur={`${duration}s`}
                    begin={`${begin}s`}
                    repeatCount="indefinite"
                    calcMode="linear"
                    keyPoints={particleKeyPoints(path, activeSpec.maskRange)}
                    keyTimes="0;1"
                  >
                    <mpath href={`#${prefix}-${path.id}`} />
                  </animateMotion>
                </circle>
              );
            })}
          </g>
        )}

        <g className="node-layer" aria-hidden="true">
          <circle className="minor-node" cx={GEOMETRY.nodes.input.x} cy={GEOMETRY.nodes.input.y} r="5.5" />
          <circle className="key-node" cx={GEOMETRY.nodes.confirm.x} cy={GEOMETRY.nodes.confirm.y} r="7" />
          <circle className="root-node" cx={GEOMETRY.nodes.b0.x} cy={GEOMETRY.nodes.b0.y} r="6.5" />
          <circle className="root-node" cx={GEOMETRY.nodes.s0.x} cy={GEOMETRY.nodes.s0.y} r="6.5" />
          <circle className="key-node" cx={GEOMETRY.nodes.public.x} cy={GEOMETRY.nodes.public.y} r="7" />
          <circle className="key-node" cx={GEOMETRY.nodes.decision.x} cy={GEOMETRY.nodes.decision.y} r="7" />
          {[GEOMETRY.nodes.adopt, GEOMETRY.nodes.retain, GEOMETRY.nodes.failed].map((outcome) => (
            <circle key={outcome.y} className="outcome-node" cx={outcome.x} cy={outcome.y} r="5.5" />
          ))}
        </g>

        <g className="active-node-layer" aria-hidden="true">
          {activeSpec.nodes.map((nodeId) => {
            const node = GEOMETRY.nodes[nodeId];
            const radius = NODE_RADIUS[nodeId];
            return (
              <g key={nodeId} data-active-node={nodeId}>
                <circle className="active-node-halo" cx={node.x} cy={node.y} r={radius + 5} filter={`url(#${nearGlowId})`} />
                <circle className="active-node-core" cx={node.x} cy={node.y} r={radius + 0.6} />
              </g>
            );
          })}
        </g>

        <g className={activeStage === 6 ? "holdout-gate is-active" : "holdout-gate"} aria-hidden="true">
          <rect
            className="holdout-body"
            x={GEOMETRY.lock.x}
            y={GEOMETRY.lock.y}
            width={GEOMETRY.lock.width}
            height={GEOMETRY.lock.height}
            rx={GEOMETRY.lock.radius}
          />
          <LockKeyhole
            className="holdout-lock-icon"
            x={1622}
            y={389}
            width={26}
            height={28}
            color="#f4f4f4"
            strokeWidth={1.55}
            aria-hidden="true"
          />
        </g>

        <g className="label-layer" aria-hidden="true">
          {GEOMETRY.stages.map((stage, index) => (
            <text
              key={stage.id}
              className={activeStage === index ? "stage-label is-active" : "stage-label"}
              x={stage.x}
              y="57"
              textAnchor="middle"
            >
              {stage.label}
            </text>
          ))}
          {GEOMETRY.generationGates.map((gate) => (
            <text key={gate.id} className="generation-label" x={gate.x} y="119" textAnchor="middle">{gate.label}</text>
          ))}
          <text className="root-label" x="496" y="296" textAnchor="end">B0（基线）</text>
          <text className="root-label" x="496" y="491" textAnchor="end">S0（候选）</text>
          <text className="band-label" x="570" y="202">ANCHOR</text>
          <text className="band-label" x="570" y="348">ELITE</text>
          <text className="band-label" x="570" y="494">DIVERSITY</text>
          <text className="direct-label" x="887" y="719" textAnchor="middle">Direct 基线</text>
          <text className={activeStage === 7 ? "outcome-label is-active" : "outcome-label"} x="1845" y="359">ADOPT</text>
          <text className={activeStage === 7 ? "outcome-label is-active" : "outcome-label"} x="1845" y="413">RETAIN</text>
          <text className={activeStage === 7 ? "outcome-label is-active" : "outcome-label"} x="1845" y="469">FAILED</text>
        </g>
      </svg>

      <div className="flow-hotspots" role="tablist" aria-label="选择演化阶段">
        {GEOMETRY.stages.map((stage, index) => {
          const [left, right] = stage.hit;
          return (
            <button
              key={stage.id}
              type="button"
              role="tab"
              aria-selected={activeStage === index}
              aria-controls="stage-panel"
              tabIndex={activeStage === index ? 0 : -1}
              aria-label={`查看阶段 ${stage.label}`}
              className={activeStage === index ? "is-active" : ""}
              style={{ left: `${(left / VIEWBOX.width) * 100}%`, width: `${((right - left) / VIEWBOX.width) * 100}%` }}
              onClick={() => onStageChange(index)}
              onKeyDown={(event) => {
                let next = activeStage;
                if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % GEOMETRY.stages.length;
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + GEOMETRY.stages.length) % GEOMETRY.stages.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = GEOMETRY.stages.length - 1;
                else return;
                event.preventDefault();
                onStageChange(next);
                window.requestAnimationFrame(() => containerRef.current?.querySelectorAll<HTMLButtonElement>(".flow-hotspots button")[next]?.focus());
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
