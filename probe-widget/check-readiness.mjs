import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".toml": "text/plain",
  ".json": "application/json",
};

function start() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const path = normalize(join(root, rel));
    if (!path.startsWith(root)) {
      res.writeHead(400);
      res.end();
      return;
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      const body = await readFile(path);
      res.writeHead(200, {
        "content-type": types[extname(path)] || "application/octet-stream",
        "x-robots-tag": "noindex, nofollow",
      });
      res.end(body);
    } catch {
      const body = await readFile(join(root, "404.html"));
      res.writeHead(404, {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      });
      res.end(body);
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const failures = [];
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  else console.log(`ok ${name}`);
}

const server = await start();
const base = `http://127.0.0.1:${server.address().port}`;

async function get(path) {
  const res = await fetch(base + path);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, text: buf.toString("utf8"), buf };
}

const home = await get("/");
check("home 200", home.status === 200, String(home.status));
check("home title", home.text.includes("<title>Acre Insights • Probe Assistant</title>"));
check("home description", home.text.includes('name="description"') && home.text.includes("soil sensor readings"));
check("home noindex", home.text.includes('name="robots" content="noindex, nofollow"'));
check("home no og image", !/og:image|twitter:image/i.test(home.text));
check("home no analytics", !/gtag|googletagmanager|google-analytics|plausible|posthog|segment\.com|mixpanel|hotjar/i.test(home.text));
check("home no privacy claims", !/privacy policy/i.test(home.text));
check("home favicon set", ["/favicon.ico", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"].every((p) => home.text.includes(p)));
check("home primary action", home.text.includes('id="send"') && home.text.includes("Ask me about sensor data"));
check("home label", home.text.includes('for="msg"') && home.text.includes("Ask about sensor data"));
check("home loader text", home.text.includes("Working on a reply."));
check("home error copy", home.text.includes("could not answer that just now") && home.text.includes("could not be reached"));
check("home no raw error dump", !home.text.includes("JSON.stringify(data"));
check("home robots header", home.headers.get("x-robots-tag") === "noindex, nofollow");

const missing = await get("/this-page-does-not-exist");
check("missing 404", missing.status === 404, String(missing.status));
check("custom 404 title", missing.text.includes("<title>Page not found • Acre Insights Probe Assistant</title>"));
check("custom 404 body", missing.text.includes("That address is not part of the probe assistant."));
check("custom 404 not platform default", !missing.text.includes("colorRgbFacetsTeal600"));
check("404 description", missing.text.includes('name="description"') && missing.text.includes("not part of the Acre Insights probe assistant"));
check("404 noindex", missing.text.includes('name="robots" content="noindex, nofollow"'));
check("404 home link", missing.text.includes('href="/"'));

const direct = await get("/index.html");
check("direct index", direct.status === 200 && direct.text.includes("Probe Assistant"));

const robots = await get("/robots.txt");
check("robots 200", robots.status === 200, String(robots.status));
check("robots disallow all", /User-agent:\s*\*\s*Disallow:\s*\//.test(robots.text));
check("robots no route list", !/logger|field|token|function|weather|chat/i.test(robots.text));
check("robots no sitemap line", !/sitemap/i.test(robots.text));

const sitemap = await get("/sitemap.xml");
check("sitemap absent", sitemap.status === 404, String(sitemap.status));

const privacy = await get("/privacy");
check("no invented privacy page", privacy.status === 404, String(privacy.status));

for (const asset of ["/favicon.ico", "/favicon.svg", "/favicon-32.png", "/apple-touch-icon.png"]) {
  const res = await get(asset);
  check(`${asset} 200`, res.status === 200, String(res.status));
  check(`${asset} bytes`, res.buf.length > 50, String(res.buf.length));
}
const png = await get("/favicon-32.png");
check("png signature", png.buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
const ico = await get("/favicon.ico");
check("ico signature", ico.buf.readUInt16LE(0) === 0 && ico.buf.readUInt16LE(2) === 1);

const toml = await readFile(join(root, "netlify.toml"), "utf8");
check("toml robots header", toml.includes('X-Robots-Tag = "noindex, nofollow"'));
check("toml keeps frame ancestors", toml.includes("frame-ancestors https://acreinsights.com"));
check("no sitemap file", sitemap.text.includes("Page not found"));

const chat = await readFile(join(root, "netlify/functions/chat.js"), "utf8");
const weather = await readFile(join(root, "netlify/functions/weather.js"), "utf8");
check("chat still rolls up readings", chat.includes("dailyRollupWithExtrema") && chat.includes("toIrrimax"));
check("weather still converts units", weather.includes("temperature_F") && weather.includes("wind_mph"));
check("functions have no analytics", !/gtag|plausible|posthog/i.test(chat + weather));

server.close();
if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f}`).join("\n"));
  process.exit(1);
}
console.log("readiness checks passed");
