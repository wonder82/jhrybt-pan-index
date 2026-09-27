import { writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const out = { testedAt: new Date().toISOString(), runner: "github-actions", tests: [] };

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

async function probe(name, url, opts = {}) {
  const t = { name, url: url.slice(0, 90) };
  const start = Date.now();
  try {
    const headers = { "user-agent": UA, ...(opts.headers || {}) };
    if (!headers.cookie && Object.keys(jar).length) headers.cookie = cookieHeader();
    const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(20000) });
    absorb(res);
    const text = await res.text();
    t.status = res.status;
    t.len = text.length;
    t.snippet = text.slice(0, 160).replace(/\s+/g, " ");
    try {
      const j = JSON.parse(text);
      t.code = j.code;
      t.msg = j.msg;
      t.total = j.data && j.data.total;
      t.items = j.data && j.data.list ? j.data.list.length : undefined;
      if (j.data && j.data.list && j.data.list[0]) t.first = String(j.data.list[0].disk_name || "").slice(0, 50);
    } catch {}
    out.tests.push(t);
    return text;
  } catch (e) {
    t.error = String((e && e.message) || e).slice(0, 130);
    out.tests.push(t);
    return "";
  }
}

(async () => {
  // ---- qkpanso：找 CSRF 机制 ----
  const html = await probe("qkpanso-searchpage", "https://qkpanso.com/search?keyword=test");
  // 提取页面中的 token 线索
  const tokenMatches = {};
  for (const pat of [
    /name="_token"[^>]*value="([^"]+)"/,
    /csrf[_-]?token["'\s:=]+["']([^"']{10,})["']/i,
    /window\._csrf\s*=\s*["']([^"']+)["']/,
    /X-CSRF-TOKEN["'\s:]+["']([^"']+)["']/i,
  ]) {
    const m = html.match(pat);
    if (m) tokenMatches[pat.source.slice(0, 30)] = m[1].slice(0, 40);
  }
  out.qkpansoTokenClues = tokenMatches;
  out.qkpansoCookieKeys = Object.keys(jar);

  await probe("qkpanso-get-api", "https://qkpanso.com/v1/search/disk?kw=test&page=1&size=5");
  await probe("qkpanso-post-tokenless", "https://qkpanso.com/v1/search/disk", {
    method: "POST",
    body: JSON.stringify({ q: "test", exact: false, page: 1, size: 5, type: "", time: "", from: "web", user_id: 0, filter: true }),
    headers: { "content-type": "application/json", referer: "https://qkpanso.com/search?keyword=test", origin: "https://qkpanso.com" },
  });

  // ---- hunhepan：exact:false 宽松匹配测试 ----
  for (const kw of ["碟中谍8", "沙丘2", "三体", "狂飙"]) {
    await probe("hunhepan-loose-" + kw, "https://hunhepan.com/open/search/disk", {
      method: "POST",
      body: JSON.stringify({ q: kw, exact: false, page: 1, size: 5, type: "", time: "", from: "web", user_id: 0, filter: true }),
      headers: { "content-type": "application/json", referer: "https://hunhepan.com/search", origin: "https://hunhepan.com" },
    });
    await sleep(2000);
  }

  console.log(JSON.stringify(out, null, 2));
  writeFileSync("probe-result.json", JSON.stringify(out, null, 2));
})();
