/** Minimal robots.txt parser (RFC 9309 matching: longest rule wins, Allow wins ties, * and $ wildcards). */
export type RobotsRules = { groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[]; sitemaps: string[] };

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  const sitemaps: string[] = [];
  let current: RobotsRules["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap" && value) sitemaps.push(value);
    else if ((key === "allow" || key === "disallow") && current) {
      if (value || key === "allow") current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups, sitemaps };
}

function matches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const re = new RegExp("^" + pattern.replace(/\$$/, "").split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/** Rules for the most specific matching user-agent group (falls back to "*"). */
function groupFor(robots: RobotsRules, agent: string) {
  const a = agent.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((x) => x !== "*" && a.includes(x)));
  if (specific.length) return specific.flatMap((g) => g.rules);
  return robots.groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules);
}

export function isAllowed(robots: RobotsRules, agent: string, path: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of groupFor(robots, agent)) {
    if (!r.path && r.allow) continue;
    if (matches(r.path, path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

/** Whether the agent is blocked from the whole site ("Disallow: /" in its group). */
export function blocksSite(robots: RobotsRules, agent: string): boolean {
  return !isAllowed(robots, agent, "/");
}
