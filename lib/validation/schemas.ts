import { z } from "zod";
import { CMS_TYPES } from "@/lib/cms/platforms";
import { isValidTimeZone } from "@/lib/scheduling/timezone";

/** Shared input schemas: used by forms (client-side) and re-applied in every server action. */
export const uuid = z.uuid();

export const slugSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens (e.g. my-article).");

const idList = z
  .union([z.array(z.coerce.number().int().positive()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean).map(Number)))
  .pipe(z.array(z.number().int().positive("Use numeric term IDs (WordPress only).")).max(50));

export const signUpSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(10, "Use at least 10 characters.").max(128),
  fullName: z.string().trim().min(1, "Enter your name.").max(120),
});

export const signInSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password.").max(128),
});

export const workspaceSchema = z.object({
  name: z.string().trim().min(2, "At least 2 characters.").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "Lowercase letters, numbers and hyphens only."),
});

export const workspaceSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  minutesSavedPerPublish: z.coerce.number().int().min(0).max(600),
  minutesSavedPerValidation: z.coerce.number().int().min(0).max(600),
});

export const clientSchema = z.object({
  name: z.string().trim().min(1, "Enter a client name.").max(200),
  notes: z.string().trim().max(5000).optional().default(""),
});

export const websiteSchema = z.object({
  clientId: uuid,
  name: z.string().trim().min(1, "Enter a website name.").max(200),
  baseUrl: z.string().trim().min(4, "Enter the website address.").max(2048),
  cmsType: z.enum(CMS_TYPES).default("wordpress"),
  timezone: z.string().trim().refine(isValidTimeZone, "Unknown timezone (use an IANA name like Europe/London)."),
  maxConcurrency: z.coerce.number().int().min(1).max(5).default(1),
});

const fieldSlug = z.union([z.literal(""), z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use the field's slug, e.g. post-body.")]).optional().default("");
const secretToken = (label: string, min = 16) =>
  z.string().transform((v) => v.trim()).pipe(z.string().min(min, `Paste the ${label}.`).max(500).regex(/^\S+$/, `The ${label} cannot contain spaces.`));

export const wordpressConnectionSchema = z.object({
  cmsType: z.literal("wordpress"),
  websiteId: uuid,
  username: z.string().trim().min(1, "Enter the WordPress username.").max(200),
  // WordPress application passwords are 24 chars, often shown in groups of four separated by spaces.
  applicationPassword: z
    .string()
    .transform((v) => v.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[A-Za-z0-9]{24}$/, "Paste the 24-character application password generated in WordPress (spaces are fine).")),
});

export const webflowConnectionSchema = z.object({
  cmsType: z.literal("webflow"),
  websiteId: uuid,
  apiToken: secretToken("Webflow API token", 32),
  collectionId: z.string().trim().toLowerCase().regex(/^[a-f0-9]{24}$/, "The collection ID is 24 hexadecimal characters (CMS → collection settings)."),
  bodyField: fieldSlug,
  summaryField: fieldSlug,
  metaTitleField: fieldSlug,
  metaDescriptionField: fieldSlug,
});

export const shopifyConnectionSchema = z.object({
  cmsType: z.literal("shopify"),
  websiteId: uuid,
  shopDomain: z.string().trim().toLowerCase().transform((v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, "Use the store's your-store.myshopify.com domain (not the custom domain).")),
  accessToken: secretToken("Admin API access token", 20).pipe(z.string().regex(/^shp[a-z]{2}_[A-Za-z0-9]+$/, "Admin API access tokens start with shpat_.")),
  blogHandle: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use the blog handle, e.g. news.").default("news"),
  authorName: z.string().trim().min(1, "Enter the author name shown on articles.").max(100).default("Editorial Team"),
});

export const customConnectionSchema = z.object({
  cmsType: z.literal("custom"),
  websiteId: uuid,
  apiBaseUrl: z.url({ protocol: /^https?$/, message: "Enter the API base URL, e.g. https://cms.example.com/api/sah/v1" }).max(2048),
  apiToken: secretToken("API token"),
});

export const connectionSchema = z.discriminatedUnion("cmsType", [wordpressConnectionSchema, webflowConnectionSchema, shopifyConnectionSchema, customConnectionSchema]);
export type ConnectionInput = z.infer<typeof connectionSchema>;

export const contentSchema = z.object({
  websiteId: uuid,
  title: z.string().trim().min(1, "Enter a title.").max(500),
  slug: slugSchema,
  body: z.string().max(500_000),
  bodyFormat: z.enum(["markdown", "html"]).default("markdown"),
  excerpt: z.string().trim().max(2000).default(""),
  metaTitle: z.string().trim().max(300).default(""),
  metaDescription: z.string().trim().max(1000).default(""),
  canonicalUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/, message: "Use an absolute http(s) URL." })]).default(""),
  targetKeyword: z.string().trim().max(200).default(""),
  categories: idList.default([]),
  tags: idList.default([]),
  featuredMediaId: z.union([z.literal("").transform(() => null), z.coerce.number().int().positive()]).nullable().default(null),
  assignedTo: z.union([z.literal("").transform(() => null), uuid]).nullable().default(null),
});
export type ContentInput = z.infer<typeof contentSchema>;

export const scheduleSchema = z.object({
  contentId: uuid,
  /** Wall-clock time in the website's timezone, "YYYY-MM-DDTHH:mm"; empty = publish immediately. */
  localDateTime: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]),
  requestKey: z.string().min(8).max(100),
});

export const memberSchema = z.object({
  email: z.email(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

export const csvRowSchema = z.object({
  website: z.string().trim().min(1, "website is required (website name or base URL)."),
  title: z.string().trim().min(1, "title is required.").max(500),
  slug: slugSchema.default(""),
  body: z.string().max(500_000).default(""),
  body_format: z.enum(["markdown", "html"]).default("markdown"),
  excerpt: z.string().trim().max(2000).default(""),
  meta_title: z.string().trim().max(300).default(""),
  meta_description: z.string().trim().max(1000).default(""),
  canonical_url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""),
  target_keyword: z.string().trim().max(200).default(""),
  categories: idList.default([]),
  tags: idList.default([]),
  scheduled_at: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/, "Use YYYY-MM-DD HH:mm (website-local time).")])
    .default(""),
});
export type CsvRow = z.infer<typeof csvRowSchema>;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/g, "");
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    out[key] ??= issue.message;
  }
  return out;
}
