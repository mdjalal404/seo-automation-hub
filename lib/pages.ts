import "server-only";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";

/** Maps service NOT_FOUND errors to the Next.js 404 page. */
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
}

export function param(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
