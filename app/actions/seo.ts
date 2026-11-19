"use server";

import { runAction } from "@/lib/actions/result";
import { PROVIDER_INFO, isProvider } from "@/lib/analytics/providers";
import { requireActionContext } from "@/lib/auth/session";
import * as automation from "@/lib/services/automation";
import * as monitoring from "@/lib/services/monitoring";
import * as seo from "@/lib/services/seo";
import type { TaskType } from "@/lib/tasks/runner";

const TASK_LABEL: Record<TaskType, string> = {
  SITE_AUDIT: "Site audit", ANALYTICS_SYNC: "Analytics sync", RANK_CHECK: "Rank check", AI_VISIBILITY_CHECK: "AI visibility check", GENERATE_CONTENT: "AI article",
  AGENT_RUN: "SEO agent run", CONTENT_QA: "Content QA", WAREHOUSE_EXPORT: "Databricks export", INDEXNOW_SUBMIT: "IndexNow submission", SEO_GATE: "SEO deploy gate",
};

export async function startTaskAction(websiteId: string, type: "SITE_AUDIT" | "ANALYTICS_SYNC" | "RANK_CHECK" | "WAREHOUSE_EXPORT", params: Record<string, unknown> = {}) {
  return runAction("task.start", async () => ({ ok: true as const, data: await seo.enqueueTask(await requireActionContext(), websiteId, type, params), message: `${TASK_LABEL[type]} queued — results appear when the worker finishes.` }));
}
export async function cancelTaskAction(id: string) {
  return runAction("task.cancel", async () => (await seo.cancelTask(await requireActionContext(), id), { ok: true as const, message: "Task cancelled" }));
}
export async function generateArticleAction(input: unknown, requestKey: string) {
  return runAction("ai.generate", async () => ({ ok: true as const, data: await seo.queueGeneration(await requireActionContext(), input, requestKey), message: "Article generation queued. The draft appears in Content when it is ready." }));
}
export async function visibilityCheckAction(websiteId: string, queries: string[]) {
  return runAction("ai.visibility", async () => ({ ok: true as const, data: await seo.queueVisibilityCheck(await requireActionContext(), websiteId, queries), message: "AI visibility check queued" }));
}
export async function addKeywordsAction(websiteId: string, text: string) {
  return runAction("keywords.add", async () => {
    const n = await seo.addKeywords(await requireActionContext(), websiteId, text);
    return { ok: true as const, message: `${n} keyword${n === 1 ? "" : "s"} processed (existing ones were kept)` };
  });
}
export async function updateKeywordsAction(websiteId: string, ids: string[], change: { tracked?: boolean; delete?: boolean }) {
  return runAction("keywords.update", async () => (await seo.updateKeywords(await requireActionContext(), websiteId, ids, change), { ok: true as const, message: change.delete ? "Keywords deleted" : change.tracked ? "Keywords tracked" : "Tracking stopped" }));
}
export async function clusterKeywordsAction(websiteId: string, similarity: number) {
  return runAction("keywords.cluster", async () => {
    const n = await seo.runClustering(await requireActionContext(), websiteId, similarity);
    return { ok: true as const, message: `Grouped into ${n} cluster${n === 1 ? "" : "s"}` };
  });
}
export async function connectIntegrationAction(input: unknown) {
  return runAction("integration.connect", async () => ({ ok: true as const, message: `${await seo.connectIntegration(await requireActionContext(), input)} connected and verified` }));
}
export async function removeIntegrationAction(websiteId: string, provider: string) {
  return runAction("integration.remove", async () => {
    await seo.removeIntegration(await requireActionContext(), websiteId, provider);
    return { ok: true as const, message: `Disconnected. Also revoke the key in ${isProvider(provider) ? PROVIDER_INFO[provider].label : "the provider"}.` };
  });
}
export async function saveScheduleAction(input: unknown) {
  return runAction("schedule.save", async () => (await seo.saveSchedule(await requireActionContext(), input), { ok: true as const, message: "Schedule saved" }));
}
export async function deleteScheduleAction(id: string) {
  return runAction("schedule.delete", async () => (await seo.deleteSchedule(await requireActionContext(), id), { ok: true as const, message: "Schedule removed" }));
}
export async function saveTemplateAction(id: string | null, input: unknown) {
  return runAction("template.save", async () => ({ ok: true as const, data: await seo.saveTemplate(await requireActionContext(), id, input), message: "Template saved" }));
}
export async function deleteTemplateAction(id: string) {
  return runAction("template.delete", async () => (await seo.deleteTemplate(await requireActionContext(), id), { ok: true as const, message: "Template deleted" }));
}
export async function previewTemplateAction(id: string, feed: string) {
  return runAction("template.preview", async () => {
    const r = await seo.previewTemplate(await requireActionContext(), id, feed);
    return { ok: true as const, data: { columns: r.columns, pages: r.pages.slice(0, 500).map((p) => ({ ...p, body: p.body.slice(0, 1200) })) } };
  });
}
export async function generateFromTemplateAction(id: string, feed: string) {
  return runAction("template.generate", async () => {
    const r = await seo.generateFromTemplate(await requireActionContext(), id, feed);
    return { ok: true as const, data: r, message: `${r.created} draft${r.created === 1 ? "" : "s"} created${r.skipped ? `, ${r.skipped} row(s) skipped` : ""}` };
  });
}
export async function applyInternalLinkAction(contentId: string, anchor: string, url: string) {
  return runAction("content.link", async () => (await seo.applyInternalLink(await requireActionContext(), contentId, anchor, url), { ok: true as const, message: "Link added. Validate again before publishing." }));
}
export async function buildSchemaAction(contentId: string, input: unknown, save: boolean) {
  return runAction("content.schema", async () => ({ ok: true as const, data: await seo.buildSchema(await requireActionContext(), contentId, input, save), message: save ? "Structured data saved to the article" : undefined }));
}

export async function startAgentAction(websiteId: string, goal: string) {
  return runAction("agent.start", async () => ({ ok: true as const, data: await automation.startAgent(await requireActionContext(), websiteId, goal), message: "Agent run queued. Proposals appear here for review when it finishes." }));
}
export async function decideProposalAction(id: string, decision: "approve" | "reject" | "done") {
  return runAction("proposal.decide", async () => {
    const r = await automation.decideProposal(await requireActionContext(), id, decision);
    const msg = decision === "reject" ? "Proposal rejected" : decision === "done" ? "Marked as done" : r.status === "done" ? (r.result.taskId ? "Approved: AI draft queued" : "Approved and applied — validate the article again") : "Approved — added to the to-do list";
    return { ok: true as const, message: msg };
  });
}
export async function queueContentQaAction(websiteId: string) {
  return runAction("qa.queue", async () => ({ ok: true as const, data: await automation.queueContentQa(await requireActionContext(), websiteId), message: "Content QA queued" }));
}

// --- Monitoring, IndexNow, deploy gate, API keys ---
export async function updateAlertAction(id: string, action: "acknowledge" | "resolve" | "reopen") {
  return runAction("alert.update", async () => (await monitoring.updateAlert(await requireActionContext(), id, action), { ok: true as const, message: action === "acknowledge" ? "Alert acknowledged" : action === "resolve" ? "Alert resolved" : "Alert reopened" }));
}
export async function submitIndexNowAction(websiteId: string, text: string) {
  return runAction("indexnow.submit", async () => {
    const r = await monitoring.submitUrlsToIndexNow(await requireActionContext(), websiteId, text);
    return { ok: true as const, message: `${r.queued} URL${r.queued === 1 ? "" : "s"} queued for IndexNow${r.skipped ? ` (${r.skipped} skipped: other host or invalid)` : ""}` };
  });
}
export async function runGateAction(input: unknown) {
  return runAction("gate.run", async () => ({ ok: true as const, data: await monitoring.runGateFromApp(await requireActionContext(), input), message: "Deploy gate queued" }));
}
export async function createApiKeyAction(name: string) {
  return runAction("api_key.create", async () => ({ ok: true as const, data: await monitoring.createApiKey(await requireActionContext(), name), message: "API key created. Copy it now: it is not shown again." }));
}
export async function revokeApiKeyAction(id: string) {
  return runAction("api_key.revoke", async () => (await monitoring.revokeApiKey(await requireActionContext(), id), { ok: true as const, message: "API key revoked" }));
}
