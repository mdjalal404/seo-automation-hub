"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { connectCmsAction } from "@/app/actions/websites";
import { Field, FormError } from "@/components/common/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CmsType } from "@/lib/cms/platforms";
import {
  customConnectionSchema, shopifyConnectionSchema, webflowConnectionSchema, wordpressConnectionSchema,
} from "@/lib/validation/schemas";

type Props = { websiteId: string; baseUrl: string; reconnect?: boolean };

export function ConnectForm({ cmsType, ...props }: Props & { cmsType: CmsType }) {
  switch (cmsType) {
    case "webflow": return <WebflowForm {...props} />;
    case "shopify": return <ShopifyForm {...props} />;
    case "custom": return <CustomForm {...props} />;
    default: return <WordPressForm {...props} />;
  }
}

/** Shared submit flow: test first, store only on success, never keep secrets in client state. */
function useConnect<S extends z.ZodType<FieldValues, FieldValues>>(schema: S, defaults: z.input<S>) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const form = useForm<z.input<S>, unknown, z.output<S>>({ resolver: zodResolver(schema as never), defaultValues: defaults as never });
  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const res = await connectCmsAction(values);
      if (!res.ok) return setError(res.error);
      form.reset(defaults as never);
      toast.success(res.message ?? "Connected");
      router.refresh();
    }),
  );
  return { form, onSubmit, error, pending };
}

function TextField<T extends FieldValues>({ form, name, label, hint, type = "text", placeholder }: {
  form: UseFormReturn<T, unknown, unknown>; name: Path<T>; label: string; hint?: string; type?: string; placeholder?: string;
}) {
  const id = `cf-${name}`;
  const err = form.formState.errors[name]?.message;
  return (
    <Field label={label} htmlFor={id} error={typeof err === "string" ? err : undefined} hint={hint}>
      <Input id={id} type={type} autoComplete={type === "password" ? "new-password" : "off"} placeholder={placeholder} {...form.register(name)} />
    </Field>
  );
}

function Layout({ children, help, pending, reconnect, note, error, onSubmit }: {
  children: React.ReactNode; help: React.ReactNode; pending: boolean; reconnect?: boolean; note: string; error: string | null; onSubmit: () => void;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="grid content-start gap-4" noValidate autoComplete="off">
        <FormError message={error} />
        {children}
        <div><Button type="submit" disabled={pending}>{pending ? "Testing connection…" : reconnect ? "Test and replace credentials" : "Test and connect"}</Button></div>
        <p className="text-xs text-muted-foreground">{note}</p>
      </form>
      <div className="rounded-lg border bg-muted/40 p-4 text-sm">{help}</div>
    </div>
  );
}

function Steps({ title, steps, footer }: { title: string; steps: React.ReactNode[]; footer?: React.ReactNode }) {
  return (
    <>
      <p className="font-medium">{title}</p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted-foreground">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {footer ? <p className="mt-3 text-xs text-muted-foreground">{footer}</p> : null}
    </>
  );
}

function WordPressForm({ websiteId, baseUrl, reconnect }: Props) {
  const defaults = { cmsType: "wordpress" as const, websiteId, username: "", applicationPassword: "" };
  const { form, onSubmit, error, pending } = useConnect(wordpressConnectionSchema, defaults);
  return (
    <Layout onSubmit={onSubmit} error={error} pending={pending} reconnect={reconnect} note={`We verify the credentials against ${baseUrl}/wp-json before saving anything.`}
      help={<Steps title="How to create an application password" steps={[
        <>Sign in to WordPress as a user with the <strong>Author</strong>, <strong>Editor</strong> or <strong>Administrator</strong> role.</>,
        <>Go to <strong>Users → Profile</strong> (or edit the user you want to publish as).</>,
        <>Scroll to <strong>Application Passwords</strong>, enter a name such as “SEO Automation Hub”, and click <strong>Add New Application Password</strong>.</>,
        <>Copy the 24-character password shown (spaces are fine) and paste it here. WordPress shows it only once.</>,
      ]} footer="Requires WordPress 5.6+ over HTTPS. If the section is missing, a security plugin or host may have disabled application passwords. You can revoke access at any time from the same screen." />}>
      <TextField form={form} name="username" label="WordPress username" />
      <TextField form={form} name="applicationPassword" label="Application password" type="password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
        hint="Not your WordPress login password. Stored encrypted; never shown again." />
    </Layout>
  );
}

function WebflowForm({ websiteId, reconnect }: Props) {
  const defaults = { cmsType: "webflow" as const, websiteId, apiToken: "", collectionId: "", bodyField: "", summaryField: "", metaTitleField: "", metaDescriptionField: "" };
  const { form, onSubmit, error, pending } = useConnect(webflowConnectionSchema, defaults);
  return (
    <Layout onSubmit={onSubmit} error={error} pending={pending} reconnect={reconnect} note="We read the collection's schema with the token before saving anything."
      help={<Steps title="How to create a Webflow API token" steps={[
        <>In Webflow, open <strong>Site settings → Apps &amp; integrations → API access</strong>.</>,
        <>Generate an API token with <strong>CMS: read and write</strong> access, and paste it here.</>,
        <>Open the blog collection in the <strong>CMS</strong> panel; its settings show the <strong>Collection ID</strong>.</>,
        <>In the collection template, bind the page&apos;s SEO title and meta description to the fields you map below.</>,
      ]} footer="The site must have been published at least once before items can be published through the API. Fields are detected automatically (a Rich Text body field, and fields with slugs like seo-title / seo-description); set them below to override." />}>
      <TextField form={form} name="apiToken" label="Webflow API token" type="password" hint="Stored encrypted; never shown again." />
      <TextField form={form} name="collectionId" label="Collection ID" placeholder="24 hexadecimal characters" />
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">Field mapping (optional)</summary>
        <div className="mt-3 grid gap-3">
          <TextField form={form} name="bodyField" label="Body field slug" placeholder="post-body" />
          <TextField form={form} name="summaryField" label="Summary field slug" placeholder="post-summary" />
          <TextField form={form} name="metaTitleField" label="Meta title field slug" placeholder="seo-title" />
          <TextField form={form} name="metaDescriptionField" label="Meta description field slug" placeholder="seo-description" />
        </div>
      </details>
    </Layout>
  );
}

function ShopifyForm({ websiteId, reconnect }: Props) {
  const defaults = { cmsType: "shopify" as const, websiteId, shopDomain: "", accessToken: "", blogHandle: "news", authorName: "Editorial Team" };
  const { form, onSubmit, error, pending } = useConnect(shopifyConnectionSchema, defaults);
  return (
    <Layout onSubmit={onSubmit} error={error} pending={pending} reconnect={reconnect} note="We query the store and its blogs with the token before saving anything."
      help={<Steps title="How to create a Shopify Admin API token" steps={[
        <>In Shopify admin, go to <strong>Settings → Apps and sales channels → Develop apps</strong> and create an app.</>,
        <>Under <strong>Admin API integration</strong>, grant the <strong>read_content</strong> and <strong>write_content</strong> scopes.</>,
        <>Install the app and copy the <strong>Admin API access token</strong> (starts with shpat_). Shopify shows it only once.</>,
        <>Enter the store&apos;s <strong>myshopify.com</strong> domain and the handle of the blog to publish to (the default blog is “news”).</>,
      ]} footer="Articles are created unpublished, then published after approval. Meta title and description use Shopify's built-in SEO fields." />}>
      <TextField form={form} name="shopDomain" label="Shop domain" placeholder="your-store.myshopify.com" />
      <TextField form={form} name="accessToken" label="Admin API access token" type="password" placeholder="shpat_…" hint="Stored encrypted; never shown again." />
      <TextField form={form} name="blogHandle" label="Blog handle" />
      <TextField form={form} name="authorName" label="Author name" hint="Shown as the article author in Shopify." />
    </Layout>
  );
}

function CustomForm({ websiteId, reconnect }: Props) {
  const defaults = { cmsType: "custom" as const, websiteId, apiBaseUrl: "", apiToken: "" };
  const { form, onSubmit, error, pending } = useConnect(customConnectionSchema, defaults);
  return (
    <Layout onSubmit={onSubmit} error={error} pending={pending} reconnect={reconnect} note="We call GET /site and GET /posts with the token before saving anything."
      help={<Steps title="Connecting a custom CMS" steps={[
        <>Implement the six JSON endpoints of the <strong>Custom CMS API v1</strong> contract (see docs/CUSTOM_CMS.md in this repository).</>,
        <>Issue a bearer token for this app that can create, update and publish posts.</>,
        <>Enter the API base URL (HTTPS) — requests go to <code>&lt;base&gt;/site</code>, <code>&lt;base&gt;/posts</code>, …</>,
      ]} footer="SEO fields are only sent when GET /site lists them in capabilities.seo_fields, and are only reported as saved when the API echoes them back." />}>
      <TextField form={form} name="apiBaseUrl" label="API base URL" placeholder="https://cms.example.com/api/sah/v1" />
      <TextField form={form} name="apiToken" label="API token" type="password" hint="Sent as a Bearer token. Stored encrypted; never shown again." />
    </Layout>
  );
}
