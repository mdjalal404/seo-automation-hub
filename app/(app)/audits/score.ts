export function scoreTone(score: number | null | undefined) {
  if (score == null) return "text-muted-foreground";
  return score >= 85 ? "text-emerald-600" : score >= 60 ? "text-amber-600" : "text-red-600";
}
