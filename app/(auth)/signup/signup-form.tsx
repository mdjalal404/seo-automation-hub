"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { signUpAction } from "@/app/actions/auth";
import { Field, FormError } from "@/components/common/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signUpSchema } from "@/lib/validation/schemas";

export function SignupForm() {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const form = useForm<z.input<typeof signUpSchema>>({ resolver: zodResolver(signUpSchema), defaultValues: { email: "", password: "", fullName: "" } });
  const { errors } = form.formState;

  if (sent) return <p className="text-sm">Check your inbox for a confirmation link, then sign in.</p>;

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const res = await signUpAction(values);
      if (!res) return;
      if (!res.ok) setError(res.error);
      else if (res.data?.needsConfirmation) setSent(true);
    }),
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormError message={error} />
      <Field label="Full name" htmlFor="fullName" error={errors.fullName?.message}>
        <Input id="fullName" autoComplete="name" {...form.register("fullName")} />
      </Field>
      <Field label="Work email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field label="Password" htmlFor="password" error={errors.password?.message} hint="At least 10 characters.">
        <Input id="password" type="password" autoComplete="new-password" {...form.register("password")} />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Creating account…" : "Create account"}</Button>
    </form>
  );
}
