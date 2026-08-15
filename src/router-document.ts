import { closeAsyncIterable, composeSingleOutlet, type SingleOutletSegments } from "./stream-segments.js";

export type RouteDocumentMetadata = {
  headHtml: string;
  resourceHints: string;
  stateScript: string;
};

export type RouteDocumentComposer = (
  metadata: RouteDocumentMetadata,
) => SingleOutletSegments | Promise<SingleOutletSegments>;

export type HtmlDocumentOptions = {
  lang?: string;
  head?: string;
  bodyBefore?: string;
  bodyAfter?: string;
};

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const validateSegments = (segments: SingleOutletSegments): SingleOutletSegments => {
  if (
    !segments ||
    typeof segments.before !== "string" ||
    typeof segments.after !== "string" ||
    (segments.outlet !== "once" && segments.outlet !== "omit")
  ) {
    throw new TypeError("A route document composer must return bounded before/after segments and one outlet mode.");
  }
  return segments;
};

export const fragmentDocument: RouteDocumentComposer = ({ headHtml, resourceHints, stateScript }) => ({
  before: `${headHtml}${resourceHints}`,
  after: stateScript,
  outlet: "once",
});

export const htmlDocument = (options: HtmlDocumentOptions = {}): RouteDocumentComposer => {
  const language = options.lang ? ` lang="${escapeAttribute(options.lang)}"` : "";
  return ({ headHtml, resourceHints, stateScript }) => ({
    before: `<!doctype html><html${language}><head>${options.head ?? ""}${headHtml}${resourceHints}</head><body>${options.bodyBefore ?? ""}`,
    after: `${options.bodyAfter ?? ""}${stateScript}</body></html>`,
    outlet: "once",
  });
};

export const composeBufferedDocument = async (
  body: string,
  metadata: RouteDocumentMetadata,
  composer: RouteDocumentComposer = fragmentDocument,
): Promise<string> => {
  const segments = validateSegments(await composer(metadata));
  return segments.outlet === "once"
    ? `${segments.before}${body}${segments.after}`
    : `${segments.before}${segments.after}`;
};

export const composeStreamingDocument = async (
  body: AsyncIterable<string>,
  metadata: RouteDocumentMetadata,
  composer: RouteDocumentComposer = fragmentDocument,
): Promise<AsyncIterable<string>> => {
  try {
    return await composeSingleOutlet(body, validateSegments(await composer(metadata)));
  } catch (error) {
    try {
      await closeAsyncIterable(body);
    } catch {
      // Preserve the composer or validation failure after best-effort source cleanup.
    }
    throw error;
  }
};
