"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border bg-card p-6">
      <h2 className="font-semibold">This page could not be loaded</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The error has been logged{error.digest ? ` (reference ${error.digest})` : ""}. If it persists, check the server logs.
      </p>
      <Button className="mt-4" size="sm" onClick={reset}>Try again</Button>
    </div>
  );
}
