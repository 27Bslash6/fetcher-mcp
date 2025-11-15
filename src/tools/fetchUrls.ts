import { Browser, BrowserContext, Page } from "playwright";
import pLimit from "p-limit";
import { WebContentProcessor } from "../services/webContentProcessor.js";
import { BrowserService } from "../services/browserService.js";
import { BrowserPoolService } from "../services/browserPoolService.js";
import { FetchOptions, FetchResult } from "../types/index.js";
import { logger } from "../utils/logger.js";

/**
 * Tool definition for fetch_urls
 */
export const fetchUrlsTool = {
  name: "fetch_urls",
  description: "Retrieve web page content from multiple specified URLs",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Array of URLs to fetch",
      },
      timeout: {
        type: "number",
        description:
          "Page loading timeout in milliseconds, default is 30000 (30 seconds)",
      },
      waitUntil: {
        type: "string",
        description:
          "Specifies when navigation is considered complete, options: 'load', 'domcontentloaded', 'networkidle', 'commit', default is 'load'",
      },
      extractContent: {
        type: "boolean",
        description:
          "Whether to intelligently extract the main content, default is true",
      },
      maxLength: {
        type: "number",
        description:
          "Maximum length of returned content (in characters), default is no limit",
      },
      returnHtml: {
        type: "boolean",
        description:
          "Whether to return HTML content instead of Markdown, default is false",
      },
      waitForNavigation: {
        type: "boolean",
        description:
          "Whether to wait for additional navigation after initial page load (useful for sites with anti-bot verification), default is false",
      },
      navigationTimeout: {
        type: "number",
        description:
          "Maximum time to wait for additional navigation in milliseconds, default is 10000 (10 seconds)",
      },
      disableMedia: {
        type: "boolean",
        description:
          "Whether to disable media resources (images, stylesheets, fonts, media), default is true",
      },
      debug: {
        type: "boolean",
        description:
          "Whether to enable debug mode (showing browser window), overrides the --debug command line flag if specified",
      },
    },
    required: ["urls"],
  },
};

/**
 * Implementation of the fetch_urls tool
 */
export async function fetchUrls(args: any) {
  const urls = (args?.urls as string[]) || [];
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    throw new Error("URLs parameter is required and must be a non-empty array");
  }

  const options: FetchOptions = {
    timeout: Number(args?.timeout) || 30000,
    waitUntil: String(args?.waitUntil || "load") as
      | "load"
      | "domcontentloaded"
      | "networkidle"
      | "commit",
    extractContent: args?.extractContent !== false,
    maxLength: Number(args?.maxLength) || 0,
    returnHtml: args?.returnHtml === true,
    waitForNavigation: args?.waitForNavigation === true,
    navigationTimeout: Number(args?.navigationTimeout) || 10000,
    disableMedia: args?.disableMedia !== false,
    debug: args?.debug,
  };

  // Configure concurrency limit for page creation
  let maxConcurrentPages = parseInt(
    process.env.MAX_CONCURRENT_PAGES || "5",
    10
  );
  if (isNaN(maxConcurrentPages) || maxConcurrentPages <= 0) {
    logger.warn(
      `Invalid MAX_CONCURRENT_PAGES value, using default of 5. Got: ${process.env.MAX_CONCURRENT_PAGES}`
    );
    maxConcurrentPages = 5;
  }
  const limit = pLimit(maxConcurrentPages);

  // Create browser service
  const browserService = new BrowserService(options);

  if (browserService.isInDebugMode()) {
    logger.debug(`Debug mode enabled for URLs: ${urls.join(", ")}`);
  }

  const pool = BrowserPoolService.getInstance();
  const processor = new WebContentProcessor(options, "[FetchURLs]");

  try {
    const results = await Promise.all(
      urls.map((url, index) =>
        limit(async () => {
          const handle = await pool.acquireBrowser(browserService, options);

          // Create a new page with human-like behavior
          const page = await browserService.createPage(
            handle.context,
            handle.viewport
          );

          try {
            const result = await processor.processPageContent(page, url);
            return { index, ...result } as FetchResult;
          } finally {
            if (!browserService.isInDebugMode()) {
              await page
                .close()
                .catch((e) =>
                  logger.error(`Failed to close page: ${e.message}`)
                );
            } else {
              logger.debug(`Page kept open for debugging. URL: ${url}`);
            }

            // Release browser back to pool
            await handle.releaseContext();
          }
        })
      )
    );

    results.sort((a, b) => (a.index || 0) - (b.index || 0));
    const combinedResults = results
      .map(
        (result, i) =>
          `[webpage ${i + 1} begin]\n${result.content}\n[webpage ${i + 1} end]`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: combinedResults }],
    };
  } catch (error) {
    logger.error(`[FetchURLs] Error processing URLs: ${(error as Error).message}`);
    throw error;
  }
}
