import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const HP_SEARCH = "https://hunhepan.com/open/search/disk";
const HP_HOME = "https://hunhepan.com/";

const jar = {};
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}
function absorb(res) {
  const scs = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of scs) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBlockedMsg(msg) {
  return !!msg && (msg.includes("不能提供") || msg.includes("不允许"));
}

// 单页请求：exact=true 精确 / false 宽松
async function hpSearchPage(kw, page, size, exact, retries = 2) {
  let last = { ok: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2500);
    try {
      const res = await fetch(HP_SEARCH, {
        method: "POST",
        headers: {
          "user-agent": UA,
          "content-type": "application/json",
          referer: "https://hunhepan.com/search?keyword=" + encodeURIComponent(kw),
          origin: "https://hunhepan.com",
          cookie: cookieHeader(),
        },
        body: JSON.stringify({ q: kw, exact, page, size, type: "", time: "", from: "web", user_id: 0, filter: true }),
        signal: AbortSignal.timeout(20000),
      });
      absorb(res);
      const j = await res.json();
      if (j.code === 200 && j.data && Array.isArray(j.data.list)) {
        return { ok: true, items: j.data.list };
      }
      last = { ok: false, code: j.code, msg: j.msg || "" };
      if (isBlockedMsg(j.msg)) return { ok: false, blocked: true, msg: j.msg }; // 敏感词，不重试
    } catch (e) {
      last = { ok: false, error: String((e && e.message) || e).slice(0, 120) };
    }
  }
  return last;
}

// 两级收集：exact 精确翻页；0 结果降级宽松翻页
async function hpCollect(kw, pages = 2, size = 30) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const r = await hpSearchPage(kw, p, size, true);
    if (r.blocked) return { blocked: true, items: [], mode: "exact" };
    if (!r.ok) break;
    all.push(...r.items);
    if (r.items.length < size) break;
    await sleep(1500);
  }
  if (all.length > 0) return { blocked: false, items: all, mode: "exact" };
  // 降级宽松
  for (let p = 1; p <= pages; p++) {
    const r = await hpSearchPage(kw, p, size, false);
    if (r.blocked) return { blocked: true, items: [], mode: "loose" };
    if (!r.ok) break;
    all.push(...r.items);
    if (r.items.length < size) break;
    await sleep(1500);
  }
  return { blocked: false, items: all, mode: all.length > 0 ? "loose" : "empty" };
}

function cleanNote(s) {
  return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

(async () => {
  mkdirSync("data", { recursive: true });

  const raw = readFileSync("keywords.txt", "utf8");
  const keywords = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, year] = l.split("|").map((x) => (x || "").trim());
      return { name, year: year || "" };
    });

  console.log("keywords: " + keywords.length);

  try {
    const home = await fetch(HP_HOME, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    absorb(home);
    console.log("homepage session ok");
  } catch (e) {
    console.log("homepage session failed (continue anyway): " + e.message);
  }

  const entries = [];
  const seenUrls = new Set();
  let okCount = 0, blockedCount = 0, emptyCount = 0;
  const blockedWords = [];

  function buildEntry(kw, via, mode, items) {
    const links = [];
    for (const it of items) {
      const url = String(it.link || it.url || "").trim();
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      links.push({
        t: String(it.disk_type || "others"),
        u: url,
        p: String(it.disk_pass || ""),
        n: cleanNote(it.disk_name),
        d: String(it.shared_time || ""),
        s: "hunhepan",
      });
    }
    if (links.length > 0) entries.push({ kw, via, mode, links });
    return links.length;
  }

  async function crawlWord(name, year) {
    const r = await hpCollect(name, 2, 30);
    if (!r.blocked && r.mode !== "empty" && r.items.length > 0) {
      const n = buildEntry(name, name, r.mode, r.items);
      okCount++;
      console.log(`-> ${name} [${r.mode}] links=${n}`);
      return;
    }
    if (r.blocked) {
      // 被敏感词拦截：宽松模式单页抢救
      const r2 = await hpSearchPage(name, 1, 30, false);
      if (!r2.blocked && r2.ok && r2.items.length > 0) {
        const n = buildEntry(name, name + "(loose-escape)", "loose", r2.items);
        okCount++;
        console.log(`-> ${name} [loose-escape] links=${n}`);
        return;
      }
    }
    // 年份变形兜底（exact/loose 都空 或 blocked 时）
    if (year) {
      for (const alt of [name + " " + year, year + " " + name]) {
        if (!alt) continue;
        const r3 = await hpSearchPage(alt, 1, 30, false);
        if (!r3.blocked && r3.ok && r3.items.length > 0) {
          const n = buildEntry(name, alt + "(year-loose)", "loose", r3.items);
          okCount++;
          console.log(`-> ${name} [year:${alt}] links=${n}`);
          return;
        }
        await sleep(1500);
      }
    }
    if (r.blocked) {
      blockedCount++;
      blockedWords.push(name);
      console.log(`-> ${name} BLOCKED`);
    } else {
      emptyCount++;
      console.log(`-> ${name} empty`);
    }
  }

  for (let i = 0; i < keywords.length; i++) {
    const { name, year } = keywords[i];
    await crawlWord(name, year);
    console.log(`[${i + 1}/${keywords.length}]`);
    await sleep(2500);
  }

  const index = {
    updatedAt: new Date().toISOString(),
    source: "hunhepan",
    count: entries.reduce((s, e) => s + e.links.length, 0),
    entries,
  };
  writeFileSync("data/pan-index.json", JSON.stringify(index));
  writeFileSync(
    "data/crawl-state.json",
    JSON.stringify({ updatedAt: index.updatedAt, okCount, blockedCount, emptyCount, blockedWords, keywordTotal: keywords.length }, null, 2)
  );
  console.log(`DONE ok=${okCount} blocked=${blockedCount} empty=${emptyCount} entries=${entries.length} links=${index.count}`);
})();
