export function grade(score: number): string {
  if (score < 0) return "none";
  return score > 50 ? "high" : "low";
}

const neverUsed = 1;
