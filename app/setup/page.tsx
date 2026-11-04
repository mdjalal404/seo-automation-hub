import { AuthCard } from "@/components/layout/auth-card";
import { configurationProblems } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup required" };

export default function SetupPage() {
  const problems = configurationProblems();
  return (
    <AuthCard title={problems.length ? "Setup required" : "Configuration looks good"} subtitle="The server checks its configuration at startup. Values are never displayed.">
      {problems.length ? (
        <div className="grid gap-3 text-sm">
          <p>These environment variables are missing or invalid:</p>
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          <p className="text-muted-foreground">Copy <code>.env.example</code> to <code>.env.local</code>, fill in the values (see README → Configuration), and restart the server. For local development, <code>npm run setup:local</code> generates them from your local Supabase.</p>
        </div>
      ) : (
        <a className="text-sm font-medium underline" href="/login">Continue to sign in</a>
      )}
    </AuthCard>
  );
}
