import {
  ALLOWED_FIRE_DAYS,
  getFiresPayload,
  parseFireDays,
  type FireDays,
} from "@/lib/fires";

/**
 * GET /api/fires?days=1|2|7
 *
 * Proxies the public NASA FIRMS VIIRS active fire CSV feeds. The upstream
 * files are fetched server side because NASA does not send CORS headers.
 * Only the allowlisted FIRMS URLs are ever requested; the endpoint never
 * accepts a caller supplied URL.
 */
export const dynamic = "force-dynamic";

const DEFAULT_DAYS: FireDays = 1;

function errorResponse(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  let days: FireDays = DEFAULT_DAYS;

  try {
    const url = new URL(request.url);
    const rawDays = url.searchParams.getAll("days");
    if (rawDays.length > 1) {
      return errorResponse(400, "The 'days' parameter may only be provided once.");
    }
    if (rawDays.length === 1) {
      const parsed = parseFireDays(rawDays[0]);
      if (parsed === null) {
        return errorResponse(
          400,
          `Invalid 'days' parameter. Supported values are ${ALLOWED_FIRE_DAYS.join(", ")}.`,
        );
      }
      days = parsed;
    }
  } catch {
    return errorResponse(400, "The request URL could not be parsed.");
  }

  try {
    const result = await getFiresPayload(days);
    return new Response(result.body, {
      status: result.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": result.cacheControl,
        "X-Fires-Cache": result.cacheStatus,
        "X-Fires-Partial": result.partial ? "1" : "0",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unexpected error while collecting fire detections.";
    return errorResponse(500, message);
  }
}
