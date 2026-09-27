import { writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const out = { testedAt: new Date().toISOString(), runner: "github-actions", tests: [] };

async function probe(name, url, opts = {}) {
  const t = { name, url };
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { "user-agent": UA, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    t.status = res.status;
    t.len = text.length;
    t.hasWidget = text.includes("tgme_widget_message");
    t.hasQuark = text.includes("pan.quark.cn");
    t.hasAliyun = text.includes("alipan.com") || text.includes("aliyundrive.com");
    t.snippet = text.slice(0, 120).replace(/\s+/g, " ");
  } catch (e) {
    t.error = String((e && e.message) || e).slice(0, 150);
  }
  t.ms = Date.now() - start;
  out.tests.push(t);
}

(async () => {
  const postBody = JSON.stringify({
    q: "凡人修仙传",
    exact: true,
    page: 1,
    size: 10,
    type: "",
    time: "",
    from: "web",
    user_id: 0,
    filter: true,
  });

  await probe("tg-direct-tgsearchers3", "https://t.me/s/tgsearchers3");
  await probe("tg-direct-dianyingshare", "https://t.me/s/dianyingshare");
  await probe("hunhepan-post", "https://hunhepan.com/open/search/disk", {
    method: "POST",
    body: postBody,
    headers: {
      "content-type": "application/json",
      referer: "https://hunhepan.com/search",
      origin: "https://hunhepan.com",
    },
  });
  await probe("qkpanso-post", "https://qkpanso.com/v1/search/disk", {
    method: "POST",
    body: postBody,
    headers: {
      "content-type": "application/json",
      referer: "https://qkpanso.com/search",
      origin: "https://qkpanso.com",
    },
  });
  await probe("rsshub-app-tg", "https://rsshub.app/telegram/channel/tgsearchers3");

  console.log(JSON.stringify(out, null, 2));
  writeFileSync("probe-result.json", JSON.stringify(out, null, 2));
})();
