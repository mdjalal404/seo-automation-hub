"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { createWorkspaceAction } from "@/app/actions/auth";
import { Field, FormError } from "@/components/common/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { slugify, workspaceSchema } from "@/lib/validation/schemas";

export function WorkspaceForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof workspaceSchema>>({ resolver: zodResolver(workspaceSchema), defaultValues: { name: "", slug: "" } });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const res = await createWorkspaceAction(values);
      if (res && !res.ok) {
        setError(res.error);
        if (res.fieldErrors?.slug) form.setError("slug", { message: res.fieldErrors.slug });
      }
    }),
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormError message={error} />
      <Field label="Agency name" htmlFor="name" error={errors.name?.message}>
        <Input id="name" {...form.register("name", { onChange: (e) => !form.formState.dirtyFields.slug && form.setValue("slug", slugify(e.target.value).slice(0, 64)) })} />
      </Field>
      <Field label="Workspace URL name" htmlFor="slug" error={errors.slug?.message} hint="Lowercase letters, numbers and hyphens.">
        <Input id="slug" {...form.register("slug")} />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create workspace"}</Button>
    </form>
  );
}
