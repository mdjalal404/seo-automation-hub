"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/actions/result";

type Props = Omit<React.ComponentProps<typeof Button>, "onClick" | "action"> & {
  action: () => Promise<ActionResult<unknown>>;
  confirm?: { title: string; description: React.ReactNode; confirmLabel?: string; destructive?: boolean };
  successMessage?: string;
  onDone?: () => void;
  /** Navigate here after success (usable from server components). */
  redirectTo?: string;
};

/** Calls a server action, shows the real outcome, and refreshes server data. */
export function ActionButton({ action, confirm, successMessage, onDone, redirectTo, children, disabled, ...props }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);

  const run = () =>
    start(async () => {
      const res = await action();
      if (res.ok) {
        toast.success(res.message ?? successMessage ?? "Done");
        onDone?.();
        if (redirectTo) router.push(redirectTo);
        else router.refresh();
      } else {
        toast.error(res.error);
      }
      setOpen(false);
    });

  return (
    <>
      <Button {...props} disabled={disabled || pending} onClick={() => (confirm ? setOpen(true) : run())}>
        {pending ? "Working…" : children}
      </Button>
      {confirm ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction variant={confirm.destructive ? "destructive" : "default"} disabled={pending} onClick={run}>
                {pending ? "Working…" : confirm.confirmLabel ?? "Confirm"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
