const fs = require("fs");
const path = require("path");
const axios = require("axios");
const autocannon = require("autocannon");

const RESULTS_DIR = path.join(__dirname, "..", "loadtest-results");
const DEFAULT_CONNECTIONS = 100;
const DEFAULT_DURATION_SECONDS = 15;
const DEFAULT_PRESET = "browse";

const PRESETS = {
  browse: ["homepage", "health", "products", "product-detail"],
  api: ["health", "products", "product-detail"],
};

const ENDPOINTS = {
  homepage: {
    label: "Homepage",
    resolvePath: async () => "/",
  },
  health: {
    label: "Health API",
    resolvePath: async () => "/api/health",
  },
  products: {
    label: "Products API",
    resolvePath: async () => "/api/products",
  },
  "product-detail": {
    label: "Product Detail API",
    resolvePath: async ({ baseUrl, explicitProductId }) => {
      const productId = explicitProductId || (await fetchFirstProductId(baseUrl));
      return productId ? `/api/products/${encodeURIComponent(productId)}` : null;
    },
  },
};

function getArgValue(flagName) {
  const argumentIndex = process.argv.indexOf(`--${flagName}`);
  if (argumentIndex === -1) {
    return "";
  }

  return String(process.argv[argumentIndex + 1] || "").trim();
}

function parseNumber(value, fallbackValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  return raw || "http://localhost:1000";
}

async function fetchFirstProductId(baseUrl) {
  try {
    const response = await axios.get(`${baseUrl}/api/products`, {
      timeout: 15000,
      validateStatus: (statusCode) => statusCode >= 200 && statusCode < 300,
    });

    const firstProduct = Array.isArray(response.data) ? response.data[0] : null;
    return String(firstProduct?._id || firstProduct?.id || "").trim();
  } catch (error) {
    console.warn(`[loadtest] Failed to discover a product detail target: ${error.message}`);
    return "";
  }
}

function ensureResultsDirectory() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function getTimestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runAutocannon(url, { connections, duration }) {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url,
        connections,
        duration,
        pipelining: 1,
        headers: {
          Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        },
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );
  });
}

function summarizeResult(endpointName, endpointLabel, url, result) {
  return {
    endpoint: endpointName,
    label: endpointLabel,
    url,
    requestsPerSecond: Number(result?.requests?.average || 0),
    totalRequests: Number(result?.requests?.total || 0),
    averageLatencyMs: Number(result?.latency?.average || 0),
    p99LatencyMs: Number(result?.latency?.p99 || 0),
    maxLatencyMs: Number(result?.latency?.max || 0),
    errors: Number(result?.errors || 0),
    timeouts: Number(result?.timeouts || 0),
    non2xx: Number(result?.non2xx || 0),
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printSummary(summary) {
  console.log(`\n${summary.label}`);
  console.log(`  URL: ${summary.url}`);
  console.log(`  Requests/s: ${summary.requestsPerSecond.toFixed(2)}`);
  console.log(`  Avg latency: ${summary.averageLatencyMs.toFixed(2)} ms`);
  console.log(`  P99 latency: ${summary.p99LatencyMs.toFixed(2)} ms`);
  console.log(`  Max latency: ${summary.maxLatencyMs.toFixed(2)} ms`);
  console.log(`  Errors: ${summary.errors} | Timeouts: ${summary.timeouts} | Non-2xx: ${summary.non2xx}`);
}

async function main() {
  const baseUrl = normalizeBaseUrl(getArgValue("baseUrl") || process.env.LOADTEST_BASE_URL);
  const presetName = String(getArgValue("preset") || process.env.LOADTEST_PRESET || DEFAULT_PRESET).trim().toLowerCase();
  const endpointNames = String(getArgValue("endpoints") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const connections = parseNumber(getArgValue("connections") || process.env.LOADTEST_CONNECTIONS, DEFAULT_CONNECTIONS);
  const duration = parseNumber(getArgValue("duration") || process.env.LOADTEST_DURATION, DEFAULT_DURATION_SECONDS);
  const explicitProductId = String(getArgValue("productId") || process.env.LOADTEST_PRODUCT_ID || "").trim();
  const selectedEndpoints = endpointNames.length > 0
    ? endpointNames
    : (PRESETS[presetName] || PRESETS[DEFAULT_PRESET]);

  ensureResultsDirectory();

  const timestampLabel = getTimestampLabel();
  const summaryRows = [];

  console.log(`[loadtest] Base URL: ${baseUrl}`);
  console.log(`[loadtest] Connections: ${connections}`);
  console.log(`[loadtest] Duration: ${duration}s`);
  console.log(`[loadtest] Endpoints: ${selectedEndpoints.join(", ")}`);

  for (const endpointName of selectedEndpoints) {
    const endpoint = ENDPOINTS[endpointName];
    if (!endpoint) {
      console.warn(`[loadtest] Skipping unknown endpoint preset entry: ${endpointName}`);
      continue;
    }

    const resolvedPath = await endpoint.resolvePath({
      baseUrl,
      explicitProductId,
    });

    if (!resolvedPath) {
      console.warn(`[loadtest] Skipping ${endpoint.label}; no target path could be resolved.`);
      continue;
    }

    const url = `${baseUrl}${resolvedPath}`;
    console.log(`\n[loadtest] Running ${endpoint.label} -> ${url}`);
    const result = await runAutocannon(url, { connections, duration });
    const summary = summarizeResult(endpointName, endpoint.label, url, result);
    summaryRows.push(summary);

    writeJson(path.join(RESULTS_DIR, `${timestampLabel}-${endpointName}.json`), result);
    printSummary(summary);
  }

  const finalSummary = {
    baseUrl,
    preset: presetName,
    connections,
    duration,
    generatedAt: new Date().toISOString(),
    results: summaryRows,
  };

  const summaryPath = path.join(RESULTS_DIR, `${timestampLabel}-summary.json`);
  writeJson(summaryPath, finalSummary);
  console.log(`\n[loadtest] Summary written to ${summaryPath}`);
}

main().catch((error) => {
  console.error(`[loadtest] Failed: ${error.message}`);
  process.exitCode = 1;
});