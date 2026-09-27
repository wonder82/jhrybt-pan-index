import { writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const out = { testedAt: new Date().toISOString(), runner: "github-actions", tests: [] };

function cookieHeader(jar) {
  const parts = [];
  for (const [k, v] of Object.entries(jar)) parts.push(k + "=" + v);
  return parts.join("; ");
}

function absorb(jar, res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

async function probe(name, url, opts = {}, jar = null) {
  const t = { name, url };
  const start = Date.now();
  try {
    const headers = { "user-agent": UA, ...(opts.headers || {}) };
    if (jar && Object.keys(jar).length) headers.cookie = cookieHeader(jar);
    const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(15000) });
    if (jar) absorb(jar, res);
    const text = await res.text();
    t.status = res.status;
    t.len = text.length;
    t.snippet = text.slice(0, 200).replace(/\s+/g, " ");
    try {
      const j = JSON.parse(text);
      t.code = j.code;
      t.msg = j.msg;
      t.total = j.data && j.data.total;
      t.items = j.data && j.data.list ? j.data.list.length : undefined;
      if (j.data && j.data.list && j.data.list[0]) t.first = (j.data.list[0].disk_name || "").slice(0, 60);
    } catch {}
  } catch (e) {
    t.error = String((e && e.message) || e).slice(0, 150);
  }
  t.ms = Date.now() - start;
  out.tests.push(t);
  return t;
}

(async () => {
  // 1) hunhepan: 先访问首页建立会话，再 POST 多个关键词
  const hpJar = {};
  await probe("hunhepan-homepage", "https://hunhepan.com/", {}, hpJar);
  for (const kw of ["流浪地球", "三体", "test", "2024"]) {
    await probe(
      "hunhepan-kw-" + kw,
      "https://hunhepan.com/open/search/disk",
      {
        method: "POST",
        body: JSON.stringify({ q: kw, exact: true, page: 1, size: 5, type: "", time: "", from: "web", user_id: 0, filter: true }),
        headers: {
          "content-type": "application/json",
          referer: "https://hunhepan.com/search?keyword=" + encodeURIComponent(kw),
          origin: "https://hunhepan.com",
        },
      },
      hpJar
    );
  }

  // 2) qkpanso: 先 GET 首页/搜索页建立会话，再 POST
  const qkJar = {};
  await probe("qkpanso-searchpage", "https://qkpanso.com/search?keyword=test", {}, qkJar);
  await probe(
    "qkpanso-post",
    "https://qkpanso.com/v1/search/disk",
    {
      method: "POST",
      body: JSON.stringify({ q: "test", exact: true, page: 1, size: 5, type: "", time: "", from: "web", user_id: 0, filter: true }),
      headers: {
        "content-type": "application/json",
        referer: "https://qkpanso.com/search?keyword=test",
        origin: "https://qkpanso.com",
      },
    },
    qkJar
  );

  console.log(JSON.stringify(out, null, 2));
  writeFileSync("probe-result.json", JSON.stringify(out, null, 2));
})();
