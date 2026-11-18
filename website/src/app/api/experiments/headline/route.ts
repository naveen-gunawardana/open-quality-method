import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { sanitizeHeadlineAssignment } from "@/lib/conversion-analytics";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new NextResponse(null, { status: 403 });
  if (Number(request.headers.get("content-length")) > 1024) return new NextResponse(null, { status: 413 });
  let assignment;
  try {
    const body = await request.text();
    if (body.length > 1024) return new NextResponse(null, { status: 413 });
    assignment = sanitizeHeadlineAssignment(JSON.parse(body));
  } catch { return new NextResponse(null, { status: 400 }); }
  if (!assignment) return new NextResponse(null, { status: 400 });
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const network_hash = createHash("sha256").update(`${process.env.REVIEW_SALT ?? "oqm"}:${ip}`).digest("hex");
  try {
    const db = supabaseServer();
    const { count, error: limitError } = await db.from("headline_exposures").select("visitor", { count: "exact", head: true })
      .eq("network_hash", network_hash).gte("created_at", new Date(Date.now() - 86400000).toISOString());
    if (limitError) throw limitError;
    if ((count ?? 0) >= 1000) return new NextResponse(null, { status: 429 });
    const { error } = await db.from("headline_exposures").upsert({ ...assignment, network_hash },
      { onConflict: "experiment,visitor", ignoreDuplicates: true });
    if (error) throw error;
    return new NextResponse(null, { status: 204 });
  } catch {
    console.error("Headline exposure could not be saved");
    return new NextResponse(null, { status: 503 });
  }
}

// Rollout gate: variants stay off until the migration has actually been applied.
export async function GET() {
  try {
    const { error } = await supabaseServer().from("headline_exposures").select("visitor").limit(0);
    return new NextResponse(null, { status: error ? 503 : 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    return new NextResponse(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
