"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { createClientAction, updateClientAction } from "@/app/actions/clients";
import { Field, FormError } from "@/components/common/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { clientSchema } from "@/lib/validation/schemas";

export function ClientFormDialog({ client, trigger }: { client?: { id: string; name: string; notes: string | null }; trigger: React.ReactElement }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof clientSchema>>({ resolver: zodResolver(clientSchema), defaultValues: { name: client?.name ?? "", notes: client?.notes ?? "" } });

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const res = client ? await updateClientAction(client.id, values) : await createClientAction(values);
      if (!res.ok) return setError(res.error);
      toast.success(res.message ?? "Saved");
      setOpen(false);
      form.reset(values);
      router.refresh();
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{client ? "Edit client" : "Add client"}</DialogTitle>
          <DialogDescription>Clients group the websites you manage for them.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError message={error} />
          <Field label="Client name" htmlFor="client-name" error={form.formState.errors.name?.message}>
            <Input id="client-name" {...form.register("name")} />
          </Field>
          <Field label="Notes" htmlFor="client-notes" error={form.formState.errors.notes?.message}>
            <Textarea id="client-notes" rows={3} {...form.register("notes")} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save client"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
