const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const SOURCE_URL =
  process.env.MYBIDMATCH_URL ||
  "https://mybidmatch.outreachsystems.com/go?sub=4C27AA86-1FA5-4B03-BD02-6FFE6148C080";
const MAX_DESCRIPTION_LENGTH = 300;
const profile = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "company-profile.json"), "utf8")
);
const MEMORY_FILE = path.join(__dirname, "data", "memory.json");

function sendJson(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(json);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*"
  });
  res.end(text);
}

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    return { analyses: {}, trackedBids: [] };
  }
}

function saveMemory(memory) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function stableId(parts) {
  return crypto
    .createHash("sha1")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 12);
}

function previousDateIso(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isoFromUsDate(mmddyyyy) {
  const match = String(mmddyyyy || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return undefined;
  const [, m, d, y] = match;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isoFromWrittenDate(text) {
  const months = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12"
  };
  const match = String(text || "").match(
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i
  );
  if (!match) return undefined;
  return `${match[3]}-${months[match[2].toLowerCase()]}-${String(match[1]).padStart(2, "0")}`;
}

function contactSummary(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const beforeBody = clean.split(/\b(?:This is|This announcement|Request for|Solicitation|Combined synopsis|NOTE:|Amendment|The Government)\b/i)[0];
  const emailMatches = clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const emails = [...new Map(emailMatches.map((email) => [email.toLowerCase(), email])).values()];
  const phones = [...new Set(clean.match(/\btel:\s*\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/gi) || [])];
  const summary = [beforeBody, emails.join(" "), phones.join(" ")]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(summary || clean, 320);
}

function dateLabels(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const full = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
  const short = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
  return [full, short, isoDate];
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|td|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
  ).trim();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const text = stripHtml(match[2]).replace(/\s+/g, " ").trim();
    if (text) links.push({ text, url: absoluteUrl(match[1], baseUrl) });
  }
  return links;
}

function findDayLink(html, targetDate, sourceUrl) {
  const labels = dateLabels(targetDate).map((x) => x.toLowerCase());
  const links = extractLinks(html, sourceUrl);
  return links.find((link) => {
    const text = link.text.toLowerCase();
    return labels.some((label) => text.includes(label));
  });
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; SASBidMatchAPI/1.0; +https://sa-solutions.com)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status}`);
  return response.text();
}

function extractTableRows(html, baseUrl) {
  const rows = [];
  const headers = [];
  const headerRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
  let headerMatch;
  while ((headerMatch = headerRe.exec(html))) {
    headers.push(stripHtml(headerMatch[1]).replace(/\s+/g, " ").trim().toLowerCase());
  }
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html))) {
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(stripHtml(cellMatch[1]).replace(/\s+/g, " ").trim());
    }
    const text = cells.filter(Boolean).join(" | ");
    if (text.length > 45) {
      const links = extractLinks(rowMatch[1], baseUrl);
      const fields = {};
      cells.forEach((cell, index) => {
        if (headers[index]) fields[headers[index]] = cell;
      });
      const title =
        fields.title ||
        cells.find((cell) => cell.length > 12 && !/^\d+$/.test(cell)) ||
        text.slice(0, 90);
      rows.push({ title, text, fields, url: links[0]?.url });
    }
  }
  return rows;
}

function extractOpportunities(html, pageUrl) {
  const rows = extractTableRows(html, pageUrl);
  if (rows.length > 0) return rows;
  const links = extractLinks(html, pageUrl)
    .filter((link) => link.text.length > 25)
    .filter((link) => !/Superior Access Solutions/i.test(link.text))
    .filter((link) => !/support\.outreachsystems\.com/i.test(link.url))
    .filter((link) => !/^\w+day,\s+\w+\s+\d{1,2},\s+\d{4}$/i.test(link.text))
    .map((link) => ({ title: link.text, text: link.text, url: link.url }));
  const textBlocks = stripHtml(html)
    .split(/\n{2,}|(?=Solicitation|Opportunity|Bid\s+#|Notice\s+#)/i)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 80)
    .map((text) => ({ title: text.slice(0, 90), text }));

  const seen = new Set();
  return [...rows, ...links, ...textBlocks].filter((opp) => {
    const key = `${opp.title}|${opp.url || ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichOpportunity(opp) {
  if (!opp.url) return opp;
  try {
    const html = await fetchHtml(opp.url);
    const articleText = stripHtml(html).replace(/\s+/g, " ").trim();
    const headingMatch = articleText.match(
      /([A-Z][A-Z\s,&.-]+,\s+[A-Z][A-Z\s,&.-]+,\s+[^]+?)\s+([A-Z]\s+--|[A-Z0-9]{1,4}\s+--)/
    );
    const dueMatch = articleText.match(/\bDUE\s+(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+at\s+([^A-Z]+?))?\s+POC\b/i);
    const writtenDue =
      articleText.match(/\b(?:no later than|on or before|not later than)\s+(?:\d{1,2}:\d{2}\s+\w+\s*,?\s*)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?[,]?\s*(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/i)?.[1] ||
      articleText.match(/\b(?:due|response date|quotes? due).*?(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/i)?.[1];
    const pocMatch = articleText.match(/\bPOC\s+(.+?)(?:\s+Set-Aside:|\s+URL:|$)/i);
    const setAsideMatch = articleText.match(/\bSet-Aside:\s+(.+?)\s+URL:/i);
    const samMatch = articleText.match(/https:\/\/sam\.gov\/[^\s<"]+/i);
    return {
      ...opp,
      text: `${opp.text} ${articleText}`.slice(0, 12000),
      agency: headingMatch ? headingMatch[1].slice(0, 220) : opp.fields?.agency,
      dueDate: dueMatch ? isoFromUsDate(dueMatch[1]) : isoFromWrittenDate(writtenDue),
      dueTime: dueMatch?.[2]?.trim(),
      pointOfContact: contactSummary(pocMatch?.[1]),
      setAside: setAsideMatch?.[1]?.trim(),
      samUrl: samMatch?.[0],
      articleText
    };
  } catch (error) {
    return { ...opp, articleError: error.message };
  }
}

function countMatches(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

function scoreOpportunity(opp) {
  const text = `${opp.title} ${opp.text}`;
  const capabilityMatches = countMatches(text, profile.bestFitCapabilities);
  const vendorCategoryMatches = countMatches(text, profile.vendorCategories);
  const vendorMatches = countMatches(text, profile.supportedBrandsAndVendors);
  const strongSignals = countMatches(text, profile.strongBuyerSignals);
  const poorSignals = countMatches(text, profile.poorFitSignals);
  const federalSignals = countMatches(text, [
    "dod",
    "department of defense",
    "army",
    "navy",
    "air force",
    "marine",
    "federal",
    "government",
    "security",
    "tactical",
    "mission"
  ]);

  let score = 0;
  score += capabilityMatches.length * 12;
  score += vendorCategoryMatches.length * 8;
  score += vendorMatches.length * 7;
  score += strongSignals.length * 5;
  score += federalSignals.length * 4;
  score -= poorSignals.length * 18;
  score = Math.max(0, Math.min(100, score));

  const reasons = [
    ...capabilityMatches.slice(0, 3),
    ...vendorCategoryMatches.slice(0, 2),
    ...vendorMatches.slice(0, 2),
    ...strongSignals.slice(0, 2)
  ];
  const why =
    poorSignals.length > 0 && score < 35
      ? `Low fit due to ${poorSignals.slice(0, 4).join(", ")}.`
      : reasons.length > 0
        ? `Matches SAS strengths: ${[...new Set(reasons)].slice(0, 5).join(", ")}.`
        : "Limited SAS capability overlap found; review only if strategic.";

  return {
    score,
    winChance:
      score >= 75 ? "high" : score >= 50 ? "medium-high" : score >= 30 ? "medium" : "low",
    reasons: [...new Set(reasons)].slice(0, 8),
    risks: poorSignals.slice(0, 5),
    description: truncate(`${opp.title}. ${why}`, MAX_DESCRIPTION_LENGTH)
  };
}

function revenuePotential(opp) {
  const text = `${opp.title} ${opp.text}`.toLowerCase();
  if (/boa|idiq|5-year|five year|program|services|installation|enterprise|recurring|2026.?2028/.test(text)) {
    return "High";
  }
  if (/system|cctv|network|fiber|av equipment|audio visual|security camera|server|radio|drone/.test(text)) {
    return "Mid-High";
  }
  return "Low-Mid";
}

function complexity(opp) {
  const text = `${opp.title} ${opp.text}`.toLowerCase();
  if (/construction|site visit|subcontractor|integration|installation|program|boa|idiq|counter.?uas|drone detection|fiber optic\/radio/.test(text)) {
    return "High";
  }
  if (/install|services|network|system|license|configuration|training/.test(text)) {
    return "Moderate";
  }
  return "Low";
}

function productLane(opp) {
  const text = `${opp.title} ${opp.text}`.toLowerCase();
  const lanes = [
    ["ptz", "PTZOptics, BirdDog, Panasonic, Sony, Lumens, controllers"],
    ["axis", "Axis cameras, mounts, licenses, accessories"],
    ["meraki", "Cisco Meraki cameras and licensing"],
    ["camera", "Axis, Hanwha, Bosch, Vivotek, Sony, Panasonic"],
    ["cctv", "CCTV/IP cameras, VMS, cabling, mounts, labor"],
    ["audio", "Shure, QSC, JBL, Yamaha, Samsung/LG displays, control systems"],
    ["visual", "Shure, QSC, JBL, Yamaha, Samsung/LG displays, control systems"],
    ["binocular", "Vortex, Steiner, Leupold, Zeiss, Nightforce"],
    ["thermal", "FLIR, Pulsar, ATN, Vortex, Steiner, Leupold"],
    ["fiber", "Fiber, SFPs, switches, racks, patch panels, cabling"],
    ["radio", "Motorola/Kenwood ecosystem, RoIP gateways, RF partners"],
    ["network", "Switches, racks, cabling, firewalls, SFPs, support"],
    ["surveillance", "Cameras, recording, mounts, networking, installation"]
  ];
  const found = lanes.find(([keyword]) => text.includes(keyword));
  return found ? found[1] : "Supplier lane needs spec review";
}

function recommendation(opp) {
  if (opp.winChance === "high" && complexity(opp) === "Low") return "Bid immediately";
  if (opp.winChance === "high") return "Strong bid";
  if (opp.winChance === "medium-high") return "Bid after reviewing specs";
  if (opp.winChance === "medium") return "Qualify first";
  return "Skip for now";
}

function carefulReason(opp) {
  if (opp.risks?.length) return `Risk flags: ${opp.risks.slice(0, 4).join(", ")}.`;
  if (complexity(opp) === "High") return "Good fit, but scope or partner requirements may drive capture effort.";
  return "Review specs, response window, and approved-source requirements before spending time.";
}

function buildAnalysis(targetDate, ranked) {
  const bidNow = ranked.filter((opp) => opp.score >= 65 && complexity(opp) !== "High");
  const review = ranked.filter((opp) => opp.score >= 45 && !bidNow.includes(opp));
  const strategic = ranked.filter((opp) => opp.score >= 55 && complexity(opp) === "High");
  const skip = ranked.filter((opp) => opp.score < 30 || (opp.risks || []).length >= 3);
  const careful = ranked
    .filter((opp) => complexity(opp) === "High" || (opp.risks || []).length > 0)
    .slice(0, 5);

  return {
    title: "Best Solicitations to Chase First",
    targetDate,
    priorityTable: ranked.slice(0, 15).map((opp, index) => ({
      priority: index + 1,
      bidId: opp.bidId,
      opportunity: opp.title,
      whyItFitsSAS: opp.description,
      productsSupplierLane: productLane(opp),
      revenuePotential: revenuePotential(opp),
      complexity: complexity(opp),
      recommendation: recommendation(opp)
    })),
    carefulWith: careful.map((opp) => ({
      bidId: opp.bidId,
      opportunity: opp.title,
      reason: carefulReason(opp),
      move: opp.score >= 45 ? "Pursue only after spec and partner review." : "Do not chase first."
    })),
    quickWins: bidNow.slice(0, 10).map((opp) => ({
      bidId: opp.bidId,
      opportunity: opp.title,
      move: "Push first if attachments/specs confirm the item list."
    })),
    strategicPursuits: strategic.slice(0, 10).map((opp) => ({
      bidId: opp.bidId,
      opportunity: opp.title,
      move: "Treat as capture work; check partner, site, and compliance requirements."
    })),
    doNotWasteTimeFirst: skip.slice(0, 15).map((opp) => ({
      bidId: opp.bidId,
      opportunity: opp.title,
      reason: opp.risks?.length
        ? `Weak SAS edge: ${opp.risks.slice(0, 4).join(", ")}.`
        : "Low capability/vendor overlap."
    })),
    finalBidPriorityList: {
      bidToday: bidNow.slice(0, 10).map((opp) => opp.bidId),
      bidAfterReview: review.slice(0, 10).map((opp) => opp.bidId),
      strategicCapturePartnerNeeded: strategic.slice(0, 10).map((opp) => opp.bidId),
      skipForNow: skip.slice(0, 15).map((opp) => opp.bidId)
    },
    nextMove:
      "Pull actual attachments/specs first for the highest-ranked quick wins, then like any bid you want tracked."
  };
}

function reminderDates(dueDate) {
  if (!dueDate) return [];
  const offsets = [
    { label: "1 week before due", days: 7 },
    { label: "3 days before due", days: 3 },
    { label: "1 day before due", days: 1 }
  ];
  const due = new Date(`${dueDate}T12:00:00Z`);
  return offsets.map((item) => {
    const d = new Date(due);
    d.setUTCDate(d.getUTCDate() - item.days);
    return { label: item.label, date: d.toISOString().slice(0, 10) };
  });
}

function truncate(value, max) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3).trimEnd()}...`;
}

async function analyzeBids({ date, top }) {
  const targetDate = date || previousDateIso();
  const homeHtml = await fetchHtml(SOURCE_URL);
  const dayLink = findDayLink(homeHtml, targetDate, SOURCE_URL);
  if (!dayLink) {
    return {
      sourceUrl: SOURCE_URL,
      targetDate,
      descriptionLengthMax: MAX_DESCRIPTION_LENGTH,
      opportunities: [],
      message: `No MyBidMatch link found for ${dateLabels(targetDate)[0]}.`
    };
  }

  const dayHtml = await fetchHtml(dayLink.url);
  const rawOpportunities = extractOpportunities(dayHtml, dayLink.url).slice(0, 75);
  const enrichedOpportunities = [];
  for (const opp of rawOpportunities) {
    enrichedOpportunities.push(await enrichOpportunity(opp));
  }

  const opportunities = enrichedOpportunities
    .map((opp) => ({ ...opp, ...scoreOpportunity(opp) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(Number(top || 5), 20)))
    .map((opp, index) => ({
      bidId: stableId([targetDate, opp.fields?.["#"] || String(index + 1), opp.title, opp.url]),
      number: opp.fields?.["#"] || String(index + 1),
      title: truncate(opp.title, 160),
      agency: opp.agency || opp.fields?.agency,
      source: opp.fields?.source,
      fsg: opp.fields?.fsg,
      url: opp.url || dayLink.url,
      samUrl: opp.samUrl,
      dueDate: opp.dueDate && opp.dueDate >= targetDate ? opp.dueDate : undefined,
      dueTime: opp.dueTime,
      pointOfContact: opp.pointOfContact,
      setAside: opp.setAside,
      score: opp.score,
      winChance: opp.winChance,
      reasons: opp.reasons,
      risks: opp.risks,
      description: opp.description
    }));

  const result = {
    sourceUrl: SOURCE_URL,
    dayUrl: dayLink.url,
    targetDate,
    targetDateLabel: dayLink.text,
    companyProfile: profile.company,
    descriptionLengthMax: MAX_DESCRIPTION_LENGTH,
    opportunities,
    analysis: buildAnalysis(targetDate, opportunities)
  };

  const memory = loadMemory();
  memory.analyses[targetDate] = {
    savedAt: new Date().toISOString(),
    targetDateLabel: dayLink.text,
    opportunities
  };
  saveMemory(memory);
  return result;
}

function likeBid({ bidId, date, notes }) {
  const memory = loadMemory();
  const analyses = date ? { [date]: memory.analyses[date] } : memory.analyses;
  const found = Object.entries(analyses)
    .filter(([, analysis]) => analysis?.opportunities)
    .flatMap(([analysisDate, analysis]) =>
      analysis.opportunities.map((opp) => ({ ...opp, analysisDate }))
    )
    .find((opp) => opp.bidId === bidId);

  if (!found) {
    return {
      ok: false,
      message: "Bid not found in memory. Run /analyze-bids for that date first, then like the bidId."
    };
  }

  const tracked = {
    ...found,
    likedAt: new Date().toISOString(),
    status: "liked",
    notes: notes || "",
    reminders: reminderDates(found.dueDate),
    endUserInfo: {
      agency: found.agency,
      pointOfContact: found.pointOfContact,
      dueDate: found.dueDate,
      dueTime: found.dueTime,
      setAside: found.setAside,
      samUrl: found.samUrl,
      source: found.source,
      fsg: found.fsg
    }
  };
  memory.trackedBids = [
    tracked,
    ...memory.trackedBids.filter((bid) => bid.bidId !== bidId)
  ];
  saveMemory(memory);
  return { ok: true, trackedBid: tracked };
}

function trackedBids() {
  return loadMemory().trackedBids || [];
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") return sendText(res, 204, "");
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "sas-bid-match-api" });
    }
    if (req.method === "GET" && url.pathname === "/openapi.yaml") {
      return sendText(
        res,
        200,
        fs.readFileSync(path.join(__dirname, "openapi.yaml"), "utf8"),
        "text/yaml; charset=utf-8"
      );
    }
    if (url.pathname === "/analyze-bids" && ["GET", "POST"].includes(req.method)) {
      const body = req.method === "POST" ? await parseBody(req) : {};
      const result = await analyzeBids({
        date: body.date || url.searchParams.get("date") || undefined,
        top: body.top || url.searchParams.get("top") || 5
      });
      return sendJson(res, 200, result);
    }
    if (url.pathname === "/like-bid" && req.method === "POST") {
      const body = await parseBody(req);
      return sendJson(res, 200, likeBid(body));
    }
    if (url.pathname === "/tracked-bids" && req.method === "GET") {
      return sendJson(res, 200, { trackedBids: trackedBids() });
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Unable to analyze MyBidMatch solicitations",
      detail: error.message,
      nextStep: "Confirm the API server can reach MyBidMatch from its hosting environment."
    });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SAS Bid Match API listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  analyzeBids,
  buildAnalysis,
  dateLabels,
  extractOpportunities,
  findDayLink,
  previousDateIso,
  likeBid,
  scoreOpportunity,
  server
};
