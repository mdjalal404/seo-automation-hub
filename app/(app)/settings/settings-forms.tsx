"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addMemberAction, removeMemberAction, setMemberRoleAction, updateProfileAction, updateWorkspaceAction } from "@/app/actions/settings";
import { ActionButton } from "@/components/common/action-button";
import { Field } from "@/components/common/field";
import { NativeSelect } from "@/components/common/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROLES, type Role } from "@/lib/auth/permissions";

function useSubmit() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message ?? "Saved");
      else toast.error(res.error ?? "Failed");
      router.refresh();
    });
  return { pending, submit };
}

export function WorkspaceForm({ initial, readOnly }: { initial: { name: string; minutesSavedPerPublish: number; minutesSavedPerValidation: number }; readOnly: boolean }) {
  const [v, setV] = useState(initial);
  const { pending, submit } = useSubmit();
  return (
    <form className="grid gap-4 sm:max-w-md" onSubmit={(e) => { e.preventDefault(); submit(() => updateWorkspaceAction(v)); }}>
      <fieldset disabled={readOnly || pending} className="grid gap-4">
        <Field label="Workspace name" htmlFor="ws-name"><Input id="ws-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Estimated minutes saved per publish" htmlFor="ws-mpp" hint="Used only for the labelled estimate on Reports.">
          <Input id="ws-mpp" type="number" min={0} max={600} value={v.minutesSavedPerPublish} onChange={(e) => setV({ ...v, minutesSavedPerPublish: Number(e.target.value) })} />
        </Field>
        <Field label="Estimated minutes saved per validation" htmlFor="ws-mpv">
          <Input id="ws-mpv" type="number" min={0} max={600} value={v.minutesSavedPerValidation} onChange={(e) => setV({ ...v, minutesSavedPerValidation: Number(e.target.value) })} />
        </Field>
      </fieldset>
      {!readOnly ? <div><Button type="submit" disabled={pending}>Save workspace</Button></div> : <p className="text-xs text-muted-foreground">Only owners can change workspace settings.</p>}
    </form>
  );
}

export function MembersManager({ members, canManage, currentUserId }: {
  members: { id: string; user_id: string; email: string; full_name: string | null; role: Role }[]; canManage: boolean; currentUserId: string;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const { pending, submit } = useSubmit();
  return (
    <div className="grid gap-4">
      <ul className="divide-y rounded-lg border text-sm">
        {members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div><p className="font-medium">{m.full_name || m.email}{m.user_id === currentUserId ? " (you)" : ""}</p><p className="text-xs text-muted-foreground">{m.email}</p></div>
            {canManage ? (
              <div className="flex items-center gap-2">
                <NativeSelect aria-label={`Role for ${m.email}`} className="w-28" value={m.role} disabled={pending} onChange={(e) => submit(() => setMemberRoleAction(m.id, e.target.value as Role))}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </NativeSelect>
                <ActionButton size="sm" variant="ghost" action={() => removeMemberAction(m.id)} confirm={{ title: "Remove member?", description: `${m.email} will lose access to this workspace.`, destructive: true, confirmLabel: "Remove" }}>Remove</ActionButton>
              </div>
            ) : <span className="capitalize text-muted-foreground">{m.role}</span>}
          </li>
        ))}
      </ul>
      {canManage ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(() => addMemberAction({ email, role })); setEmail(""); }}>
          <Field label="Add an existing user by email" htmlFor="m-email" className="min-w-64 flex-1"><Input id="m-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <NativeSelect aria-label="Role" className="w-28" value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</NativeSelect>
          <Button type="submit" disabled={pending || !email}>Add member</Button>
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground">The person must have signed up first. Email invitations are not implemented yet.</p>
    </div>
  );
}

export function ProfileForm({ fullName, email }: { fullName: string; email: string }) {
  const [name, setName] = useState(fullName);
  const { pending, submit } = useSubmit();
  return (
    <form className="grid gap-4 sm:max-w-md" onSubmit={(e) => { e.preventDefault(); submit(() => updateProfileAction({ fullName: name })); }}>
      <Field label="Email" htmlFor="p-email" hint="Email changes are not supported in this version."><Input id="p-email" value={email} disabled /></Field>
      <Field label="Full name" htmlFor="p-name"><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div><Button type="submit" disabled={pending}>Save profile</Button></div>
    </form>
  );
}
