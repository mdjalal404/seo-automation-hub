"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { NativeSelect } from "@/components/common/native-select";

/** Switches the page's website via the ?website= query parameter. */
export function WebsitePicker({ websites, value }: { websites: { id: string; name: string }[]; value: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <NativeSelect
      aria-label="Website"
      className="w-56"
      value={value}
      onChange={(e) => {
        const next = new URLSearchParams(params);
        next.set("website", e.target.value);
        router.push(`${path}?${next}`);
      }}
    >
      {websites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
    </NativeSelect>
  );
}
