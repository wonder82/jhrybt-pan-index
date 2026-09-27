import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const HP_SEARCH = "https://hunhepan.com/open/search/disk";
const HP_HOME = "https://hunhepan.com/";

const jar = {};
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}
function absorb(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hpSearch(kw, size = 30, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
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
        body: JSON.stringify({ q: kw, exact: true, page: 1, size, type: "", time: "", from: "web", user_id: 0, filter: true }),
        signal: AbortSignal.timeout(15000),
      });
      absorb(res);
      const j = await res.json();
      if (j.code === 200 && j.data && Array.isArray(j.data.list)) {
        return { ok: true, total: j.data.total || j.data.list.length, items: j.data.list };
      }
      return { ok: false, code: j.code, msg: j.msg || "" };
    } catch (e) {
      if (attempt >= retries) return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
      await sleep(1500);
    }
  }
}

function cleanNote(s) {
  return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeKey(kw) {
  return String(kw).toLowerCase().replace(/[\s:：·・'"",，。.()（）\[\]【】\-—_]/g, "");
}

(async () => {
  mkdirSync("data", { recursive: true });

  // 读取词表：每行一条，支持 "片名|年份"
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

  // 建立会话
  try {
    const home = await fetch(HP_HOME, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    absorb(home);
    console.log("homepage session ok");
  } catch (e) {
    console.log("homepage session failed (continue anyway): " + e.message);
  }

  const entries = [];
  let okCount = 0;
  let blockedCount = 0;
  let errCount = 0;
  const blockedWords = [];

  for (let i = 0; i < keywords.length; i++) {
    const { name, year } = keywords[i];
    const r = await hpSearch(name, 30);
    let items = [];
    let source = "";

    if (r.ok && r.items.length > 0) {
      items = r.items;
      source = name;
      okCount++;
    } else {
      // 失败时尝试变形词：带年份
      if (!r.ok) {
        if (r.msg && (r.msg.includes("不能提供") || r.msg.includes("不允许"))) blockedCount++;
        else errCount++;
        if (r.msg && (r.msg.includes("不能提供") || r.msg.includes("不允许"))) blockedWords.push(name);
      }
      if (year) {
        const alt = year + " " + name;
        const r2 = await hpSearch(alt, 30);
        if (r2.ok && r2.items.length > 0) {
          items = r2.items;
          source = alt;
          okCount++;
          blockedCount = Math.max(0, blockedCount - (r.ok ? 0 : 1));
        } else if (year) {
          const alt2 = name + " " + year;
          if (alt2 !== alt) {
            const r3 = await hpSearch(alt2, 30);
            if (r3.ok && r3.items.length > 0) {
              items = r3.items;
              source = alt2;
              okCount++;
            }
          }
        }
        await sleep(1200);
      }
    }

    const links = [];
    const seen = new Set();
    for (const it of items) {
      const url = String(it.link || it.url || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({
        t: String(it.disk_type || "others"),
        u: url,
        p: String(it.disk_pass || ""),
        n: cleanNote(it.disk_name),
        d: String(it.shared_time || ""),
        s: "hunhepan",
      });
    }
    if (links.length > 0) {
      entries.push({ kw: name, via: source, links });
    }
    console.log(`[${i + 1}/${keywords.length}] ${name} -> links=${links.length}${source && source !== name ? " (via: " + source + ")" : ""}`);
    await sleep(1000);
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
    JSON.stringify({ updatedAt: index.updatedAt, okCount, blockedCount, errCount, blockedWords, keywordTotal: keywords.length }, null, 2)
  );
  console.log(`DONE ok=${okCount} blocked=${blockedCount} err=${errCount} entries=${entries.length} links=${index.count}`);
})();
