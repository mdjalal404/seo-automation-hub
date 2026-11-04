"use client";

import { BarChart3, Building2, FileText, Globe, History, LayoutDashboard, ListChecks, ListOrdered, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Building2 },
  { href: "/websites", label: "Websites", icon: Globe },
  { href: "/content", label: "Content", icon: FileText },
  { href: "/content-queue", label: "Content queue", icon: ListOrdered },
  { href: "/job-history", label: "Job history", icon: History },
  { href: "/automation-rules", label: "Automation rules", icon: ListChecks },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function SideNav({ className, horizontal }: { className?: string; horizontal?: boolean }) {
  const path = usePathname();
  return (
    <nav className={cn(horizontal ? "flex gap-1 overflow-x-auto" : "grid gap-0.5", className)} aria-label="Main">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={href}
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
        );
      })}
    </nav>
  );
}
