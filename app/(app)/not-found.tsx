import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg rounded-xl border bg-card p-6">
      <h2 className="font-semibold">Not found</h2>
      <p className="mt-1 text-sm text-muted-foreground">This record does not exist in your current workspace.</p>
      <Link className="mt-4 inline-block text-sm font-medium underline" href="/dashboard">Back to dashboard</Link>
    </div>
  );
}
