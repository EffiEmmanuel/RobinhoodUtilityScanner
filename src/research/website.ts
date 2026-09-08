import * as cheerio from "cheerio";
import { config } from "../config";
import { logger } from "../logger";

export type ResearchStatus = "SUCCESS" | "FAILED" | "UNAVAILABLE" | "PARTIAL";

export interface WebsiteResearchResult {
  status: ResearchStatus;
  url?: string;
  title?: string;
  metaDescription?: string;
  textExcerpt?: string;
  githubLinks: string[];
  docsLinks: string[];
  socialLinks: string[];
  appLinks: string[];
  flags: string[]; // e.g. "possible parked domain", "error page detected", "redirected off-domain"
}

const PARKED_DOMAIN_MARKERS = [
  "domain is for sale",
  "buy this domain",
  "this domain may be for sale",
  "sedo domain parking",
  "godaddy.com/domainfound",
  "the domain has expired",
];

const DOC_HOST_MARKERS = ["gitbook.io", "notion.site", "docs.", "/docs", "readme.io", "whitepaper"];

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/**
 * SSR/static fetch-based website research (no headless browser — see README
 * for why Playwright was deliberately left out of v1). This function is the
 * single seam to swap in Playwright later without touching callers.
 */
export async function researchWebsite(rawUrl: string | undefined): Promise<WebsiteResearchResult> {
  const empty: WebsiteResearchResult = {
    status: "UNAVAILABLE",
    githubLinks: [],
    docsLinks: [],
    socialLinks: [],
    appLinks: [],
    flags: [],
  };
  if (!rawUrl) return empty;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ...empty, flags: ["invalid URL"] };
  }
  if (!["http:", "https:"].includes(parsed.protocol) || isPrivateOrLocalHost(parsed.hostname)) {
    return { ...empty, flags: ["blocked: only public http(s) URLs are allowed"] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.websiteTimeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; UtilityScoutBot/1.0; +research)" },
    });
    clearTimeout(timer);

    const flags: string[] = [];
    if (res.redirected && new URL(res.url).hostname !== parsed.hostname) {
      flags.push(`redirected off-domain to ${new URL(res.url).hostname}`);
    }
    if (!res.ok) {
      return { status: "FAILED", url: res.url, flags: [...flags, `HTTP ${res.status}`], githubLinks: [], docsLinks: [], socialLinks: [], appLinks: [] };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return { status: "PARTIAL", url: res.url, flags: [...flags, `non-HTML content-type: ${contentType}`], githubLinks: [], docsLinks: [], socialLinks: [], appLinks: [] };
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();

    const title = $("title").first().text().trim() || undefined;
    const metaDescription = $('meta[name="description"]').attr("content")?.trim() || undefined;
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const textExcerpt = bodyText.slice(0, 4000);

    const lowerHtml = html.toLowerCase();
    if (PARKED_DOMAIN_MARKERS.some((m) => lowerHtml.includes(m))) flags.push("possible parked domain");
    if (/404|not found|page doesn.?t exist/i.test(title ?? "") && bodyText.length < 300) {
      flags.push("possible error page");
    }
    if (bodyText.length < 80) flags.push("very little visible text extracted");

    const hrefs = new Set<string>();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        hrefs.add(new URL(href, res.url).toString());
      } catch {
        /* ignore malformed href */
      }
    });

    const githubLinks: string[] = [];
    const docsLinks: string[] = [];
    const socialLinks: string[] = [];
    const appLinks: string[] = [];

    for (const href of hrefs) {
      const h = href.toLowerCase();
      if (h.includes("github.com")) githubLinks.push(href);
      else if (h.includes("twitter.com") || h.includes("x.com") || h.includes("t.me") || h.includes("discord.")) socialLinks.push(href);
      else if (DOC_HOST_MARKERS.some((m) => h.includes(m))) docsLinks.push(href);
      else if (h.includes("app.") || h.includes("/app")) appLinks.push(href);
    }

    return {
      status: flags.includes("possible parked domain") || flags.includes("possible error page") ? "PARTIAL" : "SUCCESS",
      url: res.url,
      title,
      metaDescription,
      textExcerpt,
      githubLinks: [...new Set(githubLinks)].slice(0, 5),
      docsLinks: [...new Set(docsLinks)].slice(0, 5),
      socialLinks: [...new Set(socialLinks)].slice(0, 8),
      appLinks: [...new Set(appLinks)].slice(0, 5),
      flags,
    };
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ url: rawUrl, err: String(err) }, "website research failed");
    return { ...empty, status: "FAILED", flags: [`fetch error: ${String(err)}`] };
  }
}

export function formatWebsiteResultForPrompt(r: WebsiteResearchResult): string {
  if (r.status === "UNAVAILABLE") return "No website URL was available.";
  const lines = [
    `Status: ${r.status}`,
    r.url ? `Final URL: ${r.url}` : undefined,
    r.title ? `Title: ${r.title}` : undefined,
    r.metaDescription ? `Meta description: ${r.metaDescription}` : undefined,
    r.flags.length ? `Flags: ${r.flags.join("; ")}` : undefined,
    r.githubLinks.length ? `GitHub links: ${r.githubLinks.join(", ")}` : undefined,
    r.docsLinks.length ? `Docs links: ${r.docsLinks.join(", ")}` : undefined,
    r.socialLinks.length ? `Social links: ${r.socialLinks.join(", ")}` : undefined,
    r.appLinks.length ? `App links: ${r.appLinks.join(", ")}` : undefined,
    r.textExcerpt ? `Visible text excerpt:\n${r.textExcerpt}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}
