"use client";

import {
  BarChart3, BellRing, Bot, Building2, Code2, FileStack, ScrollText, ShieldCheck, FileText, Globe, History, KeyRound, LayoutDashboard, LineChart, ListChecks, ListOrdered, Plug, Radar, Settings, Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, section: "Workspace" },
  { href: "/clients", label: "Clients", icon: Building2, section: "Workspace" },
  { href: "/websites", label: "Websites", icon: Globe, section: "Workspace" },
  { href: "/content", label: "Content", icon: FileText, section: "Content" },
  { href: "/ai-studio", label: "AI studio", icon: Sparkles, section: "Content" },
  { href: "/templates", label: "Page templates", icon: FileStack, section: "Content" },
  { href: "/content-qa", label: "Content QA", icon: ShieldCheck, section: "Content" },
  { href: "/content-queue", label: "Content queue", icon: ListOrdered, section: "Content" },
  { href: "/job-history", label: "Job history", icon: History, section: "Content" },
  { href: "/agent", label: "SEO agent", icon: Bot, section: "SEO" },
  { href: "/keywords", label: "Keywords", icon: KeyRound, section: "SEO" },
  { href: "/audits", label: "Site audits", icon: Radar, section: "SEO" },
  { href: "/crawl-budget", label: "Crawl budget & logs", icon: ScrollText, section: "SEO" },
  { href: "/analytics", label: "Analytics", icon: LineChart, section: "SEO" },
  { href: "/monitoring", label: "Monitoring & alerts", icon: BellRing, section: "SEO" },
  { href: "/integrations", label: "Integrations & autopilot", icon: Plug, section: "SEO" },
  { href: "/automation-rules", label: "Automation rules", icon: ListChecks, section: "Settings" },
  { href: "/reports", label: "Reports", icon: BarChart3, section: "Settings" },
  { href: "/developer", label: "API & CI/CD", icon: Code2, section: "Settings" },
  { href: "/settings", label: "Settings", icon: Settings, section: "Settings" },
];

export function SideNav({ className, horizontal }: { className?: string; horizontal?: boolean }) {
  const path = usePathname();
  return (
    <nav className={cn(horizontal ? "flex gap-1 overflow-x-auto" : "-mt-3 grid min-h-0 gap-0.5 overflow-y-auto", className)} aria-label="Main">
      {NAV.map(({ href, label, icon: Icon, section }, i) => {
        const active = path === href || path.startsWith(`${href}/`);
        const heading = !horizontal && section !== NAV[i - 1]?.section;
        return (
          <div key={href} className={horizontal ? "contents" : undefined}>
            {heading ? <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{section}</p> : null}
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                active && "bg-muted font-medium text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
