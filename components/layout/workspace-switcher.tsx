"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { switchWorkspaceAction } from "@/app/actions/auth";
import type { WorkspaceSummary } from "@/lib/auth/session";

export function WorkspaceSwitcher({ workspaces, currentId }: { workspaces: WorkspaceSummary[]; currentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-1">
      <label htmlFor="workspace" className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Workspace</label>
      <select
        id="workspace"
        className="h-8 w-full rounded-md border bg-background px-2 text-sm"
        value={currentId}
        disabled={pending}
        onChange={(e) =>
          start(async () => {
            const res = await switchWorkspaceAction(e.target.value);
            if (!res.ok) toast.error(res.error);
            router.refresh();
          })
        }
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name} ({w.role})</option>
        ))}
      </select>
    </div>
  );
}
