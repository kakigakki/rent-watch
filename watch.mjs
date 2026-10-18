// 租房监视：SUUMO / HOME'S 上出现符合条件的新房源或降价时，用 ntfy 推送到手机（也可同时发 WxPusher）。
// 用法：node watch.mjs            正常运行（由 cron-job.org 每 20 分钟触发 GitHub Actions）
//       node watch.mjs --dry-run  只打印，不推送、不写 state.json
//       node watch.mjs --probe    把各网站的原始 HTML 存到 probe/，用于排查解析问题
import * as cheerio from 'cheerio';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
const STATE = new URL('./state.json', import.meta.url);
const dry = process.argv.includes('--dry-run');
const probe = process.argv.includes('--probe');
const ntfyServer = process.env.NTFY_SERVER || 'https://ntfy.sh';
const ntfyTopic = process.env.NTFY_TOPIC;
const wxToken = process.env.WXPUSHER_TOKEN;
const wxUids = (process.env.WXPUSHER_UID || '').split(',').map((s) => s.trim()).filter(Boolean); // 多人用逗号分隔
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' } });
      const text = await res.text();
      if (res.ok && text) { await sleep(1500); return text; }
      if (res.status === 202 && !text) return { blocked: 'challenge', text }; // 反爬验证页：不重试、不绕过
      console.warn(`HTTP ${res.status} ${url}`);
      if (res.status === 403 || res.status === 404) return { blocked: res.status, text };
    } catch (e) { console.warn(`fetch error ${url}: ${e.message}`); }
    await sleep(3000 * (i + 1));
  }
  return { blocked: 'error', text: '' };
}
const saveProbe = (name, html) => {
  if (!probe) return;
  fs.mkdirSync(new URL('./probe/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`./probe/${name}.html`, import.meta.url), typeof html === 'string' ? html : html.text);
};

// ---------- 共通 ----------
const z2h = (s) => String(s ?? '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s+/g, ' ').trim();
const yen = (s) => {
  s = z2h(s).replace(/,/g, '');
  let m = s.match(/([\d.]+)\s*万/); if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = s.match(/([\d.]+)\s*円/); if (m) return Math.round(parseFloat(m[1]));
  return 0; // 「-」= 0
};
const ageOf = (s) => { s = z2h(s); if (/新築/.test(s)) return 0; const m = s.match(/築\s*(\d+)\s*年/); return m ? +m[1] : null; };
const areaOf = (s) => { const m = z2h(s).match(/([\d.]+)\s*(m|㎡)/); return m ? parseFloat(m[1]) : null; };
function townOk(addr) {
  const a = z2h(addr).replace(/^神奈川県/, '');
  for (const [city, towns] of Object.entries(cfg.towns)) {
    if (!a.startsWith(city)) continue;
    const rest = a.slice(city.length);
    if (towns.some((t) => rest.startsWith(t))) return true;
  }
  return false;
}
function parkingInfo(text) {
  const t = z2h(text);
  if (!t || t === '-') return { fee: null, ok: true, text: t || '未写' };
  if (/空無/.test(t) && !/空有/.test(t)) return { fee: null, ok: false, text: t };
  if (/無料|込/.test(t)) return { fee: 0, ok: true, text: t };
  const fees = [...t.replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*(万)?円/g)].map((m) => Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1)));
  if (!fees.length) return { fee: null, ok: true, text: t };
  const fee = Math.min(...fees);
  return { fee, ok: fee <= cfg.maxParkingYen, text: t };
}
// 同一房间在多个网站/多家中介重复挂牌 → 町名+间取+面积+楼层 作为键
// （SUUMO 地址只到丁目、HOME'S 写到番地，数字部分对不上，所以只取町名）
const townOf = (a) => z2h(a).replace(/^神奈川県/, '').replace(/[\d-].*$/, '').replace(/丁目$/, '');
// 楼层：「1-2階」（复式/联排）和没写楼层的不区分，统一记成 M
const floorKey = (f) => { f = z2h(f); return !/\d/.test(f) || /\d+\s*-\s*\d+/.test(f) ? 'M' : f.match(/\d+/)[0]; };
const roomKey = (r) => [townOf(r.address), z2h(r.layout).toUpperCase(), r.area?.toFixed(1), floorKey(r.floor)].join('|');
const legacyKey = (r) => [townOf(r.address), z2h(r.layout).toUpperCase(), r.area?.toFixed(1), (z2h(r.floor).match(/\d+/) || ['?'])[0]].join('|');
// 车站圈：交通栏里有「湘南台駅 歩18分」且步行分钟在范围内，
// 或「湘南台駅 バス8分 (バス停)〇〇 歩3分」且乘车、下车后步行都在上限内
function stationMatch(r) {
  for (const st of cfg.stations || []) {
    const walkRe = new RegExp(`${st.name}駅?\\s*(?:歩|徒歩)\\s*(\\d+)\\s*分`);
    const busRe = new RegExp(`${st.name}駅?\\s*バス\\s*(\\d+)\\s*分(?:.*?(?:歩|徒歩)\\s*(\\d+)\\s*分)?`);
    for (const line of r.accessAll || [r.access]) {
      const t = z2h(line);
      const w = t.match(walkRe);
      if (w && +w[1] >= st.minWalk && +w[1] <= st.maxWalk) return { name: st.name, walk: +w[1], line };
      const b = st.maxBus != null && t.match(busRe);
      if (b && +b[1] <= st.maxBus && +(b[2] ?? 0) <= (st.maxStopWalk ?? 99)) return { name: st.name, bus: +b[1], line };
    }
  }
  return null;
}
const inScope = (r) => townOk(r.address) || !!stationMatch(r);
const baseOk = (r) => r.total <= cfg.maxTotalYen && r.area >= cfg.minAreaM2 && r.age != null && r.age <= cfg.maxAgeYears
  && cfg.layouts.includes(z2h(r.layout).toUpperCase()) && inScope(r);

// ---------- SUUMO ----------
const suumoList = (sc, page) => `https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&bs=040&ta=14&sc=${sc}&cb=0.0&ct=${(cfg.maxTotalYen / 10000).toFixed(1)}&co=1&et=9999999&md=07&md=10&mb=${cfg.minAreaM2}&mt=9999999&cn=${cfg.maxAgeYears}&tc=0400901&shkr1=03&shkr2=03&shkr3=03&shkr4=03&pc=50&page=${page}`;

async function scanSuumo() {
  const out = [];
  for (const [city, sc] of Object.entries(cfg.suumo.sc)) {
    for (let page = 1; page <= 20; page++) {
      const html = await get(suumoList(sc, page));
      if (typeof html !== 'string') throw new Error(`SUUMO ${city} p${page} 取得失败 (${html.blocked})`);
      if (page === 1) saveProbe(`suumo-${sc}`, html);
      const $ = cheerio.load(html);
      const items = $('.cassetteitem');
      if (!items.length) {
        if (page === 1 && !/条件にあう物件がありません/.test(html)) throw new Error(`SUUMO ${city} 列表解析不到房源（页面结构可能变了）`);
        break;
      }
      items.each((_, el) => {
        const b = $(el);
        const name = z2h(b.find('.cassetteitem_content-title').first().text());
        const address = z2h(b.find('.cassetteitem_detail-col1').first().text());
        const col3 = b.find('.cassetteitem_detail-col3 div').map((_, d) => z2h($(d).text())).get();
        const access = b.find('.cassetteitem_detail-col2 .cassetteitem_detail-text').map((_, d) => z2h($(d).text())).get().filter(Boolean);
        b.find('.cassetteitem_other tbody tr').each((_, tr) => {
          const row = $(tr);
          const href = row.find('a[href*="/chintai/jnc_"]').attr('href') || '';
          const id = (href.match(/jnc_\d+/) || [])[0];
          if (!id) return;
          const tds = row.find('td').map((_, td) => z2h($(td).text())).get();
          const rent = yen(row.find('.cassetteitem_price--rent').text());
          const mgmt = yen(row.find('.cassetteitem_price--administration').text());
          out.push({
            site: 'SUUMO', id, url: `https://suumo.jp/chintai/${id}/`, name, address, access: access[0] || '', accessAll: access,
            built: col3[0] || '', age: ageOf(col3[0]), floor: tds.find((t) => /階/.test(t) && t.length < 12) || '',
            layout: z2h(row.find('.cassetteitem_madori').text()), area: areaOf(row.find('.cassetteitem_menseki').text()),
            rent, mgmt, total: rent + mgmt,
          });
        });
      });
      if (!$('.pagination-parts a:contains("次へ")').length) break;
    }
  }
  return out;
}
// 详情页：停车费 ＋ 情報更新日 ＋ 用来比较"改了什么"的几项
const DETAIL_FIELDS = ['駐車場', '入居', '条件', 'ほか諸費用', '備考']; // 租金变化由列表页的降价判断负责
async function suumoDetail(url) {
  const html = await get(url);
  if (typeof html !== 'string') return null;
  saveProbe('suumo-detail', html);
  const $ = cheerio.load(html);
  const th = {};
  $('th').each((_, el) => { const k = z2h($(el).text()).replace(/\s/g, ''); if (!(k in th)) th[k] = z2h($(el).next('td').text()); });
  return {
    url, parking: parkingInfo(th['駐車場'] || ''), updated: th['情報更新日'] || null, next: th['次回更新予定日'] || null,
    fields: Object.fromEntries(DETAIL_FIELDS.map((k) => [k, (th[k] || '').slice(0, 300)])), checkedAt: now.toISOString(),
  };
}
const jstDate = (s) => Date.parse(`${String(s).replace(/\//g, '-')}T00:00:00+09:00`);
function detailDiff(a, b) {
  const out = DETAIL_FIELDS.filter((k) => (a.fields?.[k] ?? '') !== (b.fields?.[k] ?? '')).map((k) => {
    const x = a.fields?.[k] || '-', y = b.fields?.[k] || '-';
    return k === '備考' || x.length + y.length > 80 ? `${k}：有改动` : `${k}：${x} → ${y}`;
  });
  return out;
}

// ---------- HOME'S ----------
// cond: 賃料上限(管理費込) / 2LDK=25 3LDK=35 / 55㎡以上 / 築15年以内 / 駐車場あり=320801
const homesList = (city, page) => `https://www.homes.co.jp/chintai/kanagawa/${city}/list/?` + new URLSearchParams({
  'cond[monthmoneyroomh]': String(cfg.maxTotalYen / 10000), 'cond[kanrihi]': '1', 'cond[madori][25]': '25', 'cond[madori][35]': '35',
  'cond[housearea]': String(cfg.minAreaM2), 'cond[houseageh]': String(cfg.maxAgeYears), 'cond[mcf][320801]': '320801', page: String(page),
});

async function scanHomes() {
  const out = [];
  for (const [cityName, city] of Object.entries(cfg.homes.cities)) {
    for (let page = 1; page <= 20; page++) {
      const html = await get(homesList(city, page));
      if (typeof html !== 'string') throw new Error(`HOME'S ${cityName} p${page} 取得失败 (${html.blocked})`);
      if (page === 1) saveProbe(`homes-${city}`, html);
      const $ = cheerio.load(html);
      const blds = $('.prg-building').filter((_, el) => $(el).find('tr.prg-roomInfo').length > 0);
      if (!blds.length) {
        if (page === 1 && !/条件に一致する物件|該当する物件がありません|0件/.test(html)) throw new Error(`HOME'S ${cityName} 列表解析不到房源（页面结构可能变了）`);
        break;
      }
      blds.each((_, el) => {
        const b = $(el);
        const spec = {};
        b.find('.bukkenSpec tr').each((_, tr) => { spec[z2h($(tr).find('th').text())] = z2h($(tr).find('td').text()); });
        const name = z2h(b.find('.bukkenName').first().text());
        const built = (spec['築年数/階数'] || '').split('/')[0].trim();
        const accessAll = b.find('.bukkenSpec .prg-stationText').map((_, e) => z2h($(e).text())).get();
        b.find('tr.prg-roomInfo').each((_, tr) => {
          const row = $(tr);
          const url = row.attr('data-href') || row.find('a[href*="/chintai/room/"]').attr('href') || '';
          const id = (url.match(/room\/([0-9a-f]+)/) || [])[1];
          if (!id) return;
          const priceTxt = z2h(row.find('td.price > span').first().text()); // 「19.5万円/10,000円」
          const [rentTxt, mgmtTxt] = priceTxt.split('/');
          const lay = row.find('td.layout').html() || '';
          const [layout, areaTxt] = lay.split(/<br\s*\/?>/i).map((s) => z2h(cheerio.load(s).text()));
          const rent = yen(rentTxt), mgmt = yen(mgmtTxt);
          out.push({
            site: "HOME'S", id, url: `https://www.homes.co.jp/chintai/room/${id}/`, name, address: spec['所在地'] || '',
            access: accessAll[0] || spec['交通'] || '', accessAll, built, age: ageOf(built), floor: z2h(row.find('.roomKaisuu').text()),
            layout, area: areaOf(areaTxt), rent, mgmt, total: rent + mgmt,
          });
        });
      });
      if (!$('a[rel="next"], .nextPage a, li.next a').length) break;
    }
  }
  return out;
}

// ---------- 推送（ntfy 手机通知 ＋ 可选 WxPusher） ----------
const man = (n) => (n / 10000).toFixed(2).replace(/\.?0+$/, '');
const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TAG_COLOR = { 新房源: '#2f7a68', 在招: '#5f6d68', 重新招租: '#1f5f7a' }; // 其他（降价）= 橙色
// 「JR東海道本線 辻堂駅 2階建 築14年」这类是中介没写楼名时 SUUMO 自动生成的标题
const displayName = (r) => (/駅 (地上)?\d+階建|^\S+線 \S+駅/.test(r.name) ? '（楼名未公开）' : r.name);
const shortAccess = (a) => z2h(a).replace(/^[^/]*\//, '').replace(/\(バス停\)/, '').replace(/\s*（.*$/, '');
// 只因为车站步行圈才进范围的房源，标题前加「湘南台圈」
const areaName = (r) => (townOk(r.address) ? '' : `${stationMatch(r)?.name}圈 `) + townOf(r.address).replace(/^.+?[市町区]/, '');
const accessLine = (r) => (!townOk(r.address) && stationMatch(r)?.line) || r.access;
const parkText = (r) => (r.parking.fee == null ? '停车费待确认' : r.parking.fee === 0 ? '停车免费' : `停车 ${r.parking.fee.toLocaleString()}円`);
const siteLinks = (r) => [...new Set(r.urls.map((u) => u.site))].map((site) => ({
  site, n: r.urls.filter((u) => u.site === site).length, url: r.urls.find((u) => u.site === site).url,
}));

// WxPusher 用的 HTML 卡片
function card(r, tag, note = '') {
  const pf = r.parking.fee;
  const park = pf == null ? `<span style="color:#a8741a">${parkText(r)}</span>` : pf === 0 ? `<b style="color:#2f7a68">${parkText(r)}</b>` : parkText(r);
  const sites = siteLinks(r).map((s) => `<a href="${h(s.url)}" style="display:inline-block;margin:6px 8px 0 0;padding:4px 12px;border:1px solid #1f5f7a;border-radius:14px;color:#1f5f7a;text-decoration:none;font-size:13px">${h(s.site)}${s.n > 1 ? ` ×${s.n}` : ''} ›</a>`).join('');
  return `<div style="border:1px solid #dde3dd;border-radius:10px;padding:10px 12px;margin:10px 0;background:#fff">`
    + `<div style="font-size:12px;font-weight:bold;color:${TAG_COLOR[tag] || '#c0562a'}">${h(tag)}</div>`
    + `<div style="font-size:16px;font-weight:bold;margin:2px 0">${h(displayName(r))}</div>`
    + `<div style="font-size:12px;color:#5f6d68">${h(z2h(r.address).replace(/^神奈川県/, ''))}　${h(shortAccess(accessLine(r)))}</div>`
    + `<div style="margin:6px 0 2px"><span style="font-size:22px;font-weight:bold;color:#c0562a">${man(r.total)}</span><span style="font-size:13px;color:#c0562a">万</span>`
    + `<span style="font-size:12px;color:#5f6d68">　含停车 ${man(r.total + (pf || 0))}万</span></div>`
    + `<div style="font-size:14px"><b>${h(r.layout)}</b> · ${r.area}㎡ · ${h(r.built)} · ${h(r.floor)} · ${park}</div>`
    + (note ? `<div style="font-size:13px;color:#1f5f7a;margin-top:6px;white-space:pre-line">${h(note)}</div>` : '')
    + sites + '</div>';
}
// ntfy 用的纯文本
const itemText = (r) => `${displayName(r)}\n${z2h(r.address).replace(/^神奈川県/, '')} · ${shortAccess(accessLine(r))}\n`
  + `${r.layout} ${r.area}㎡ · ${r.built} · ${r.floor}\n月租+管理费 ${man(r.total)}万（含停车 ${man(r.total + (r.parking.fee || 0))}万）· ${parkText(r)}`;
const listLine = (r) => `${man(r.total)}万 ${areaName(r)} ${r.layout} ${Math.round(r.area)}㎡ ${r.built} · ${parkText(r)}\n${siteLinks(r)[0].url}`;

async function ntfy(msg) {
  if (!ntfyTopic) return;
  const res = await fetch(ntfyServer, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: ntfyTopic, tags: ['house'], ...msg }),
  });
  console.log(`ntfy 回应：HTTP ${res.status}`);
  if (!res.ok) console.error('ntfy 推送失败:', (await res.text()).slice(0, 200));
}
async function wxpusher(title, html) {
  if (!wxToken || !wxUids.length) return;
  const res = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appToken: wxToken, uids: wxUids, contentType: 2, summary: title.slice(0, 100), content: html }),
  });
  const j = await res.json().catch(() => ({}));
  console.log(`WxPusher 回应：HTTP ${res.status} code=${j.code} msg=${j.msg ?? ''}`);
}

// title：通知标题；intro：说明文字（行数组）；items：[{ r, tag }]
// each=true 时 ntfy 每套房单独一条（点通知直接打开招租页），否则合成一条列表
async function push(title, intro = [], items = [], { each = false, priority = 3 } = {}) {
  console.log(`\n=== ${title} ===\n${intro.join('\n')}\n${items.map((i) => `[${i.tag}] ${itemText(i.r)}${i.note ? `
${i.note}` : ''}`).join('\n\n')}\n`);
  if (probe) {
    fs.mkdirSync(new URL('./probe/', import.meta.url), { recursive: true });
    fs.writeFileSync(new URL('./probe/message.html', import.meta.url), `<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="background:#f4f6f4;font-family:sans-serif;max-width:480px;margin:auto;padding:12px"><h3>${h(title)}</h3>${intro.map(h).join('<br>')}${items.map((i) => card(i.r, i.tag, i.note)).join('')}`);
  }
  if (dry) return;
  if (!ntfyTopic && !(wxToken && wxUids.length)) { console.error('推送跳过：NTFY_TOPIC 和 WxPusher 都没有设置'); return; }

  if (each && items.length) {
    for (const { r, tag, note, priority: p } of items) {
      const links = siteLinks(r);
      await ntfy({
        title: `${tag}｜${areaName(r)} ${r.layout} ${man(r.total)}万`, message: itemText(r) + (note ? `

${note}` : ''), priority: p ?? priority,
        click: links[0].url, actions: links.slice(0, 3).map((s) => ({ action: 'view', label: `打开 ${s.site}`, url: s.url })),
      });
    }
  } else {
    // ntfy 单条消息上限 4096 字节，超过就分条
    const chunks = [intro.join('\n')];
    for (const { r, tag } of items) {
      const line = (tag && tag !== '在招' ? `【${tag}】` : '') + listLine(r);
      if (Buffer.byteLength(chunks.at(-1) + '\n\n' + line) > 3800) chunks.push(line);
      else chunks[chunks.length - 1] += (chunks.at(-1) ? '\n\n' : '') + line;
    }
    for (const [i, message] of chunks.entries()) {
      await ntfy({ title: chunks.length > 1 ? `${title}（${i + 1}/${chunks.length}）` : title, message, priority });
    }
  }

  const html = `<div style="font-family:-apple-system,sans-serif;color:#1a2422"><div style="font-size:13px;color:#5f6d68;line-height:1.6">${intro.map(h).join('<br>')}</div>${items.map((i) => card(i.r, i.tag, i.note)).join('')}</div>`;
  await wxpusher(title, html);
}
if (process.argv.includes('--test-push')) {
  await push('租房监视 测试消息', ['这是一条测试消息，收到说明推送正常。', new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })], [], { priority: 4 });
  process.exit(0);
}

// ---------- 主流程 ----------
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
state.rooms ??= {}; state.fail ??= {};
const firstRun = !state.initializedAt || process.argv.includes('--list'); // --list：再发一次现有房源一览
const events = [], errors = [];

const scanned = [];
for (const [site, fn] of [['SUUMO', scanSuumo], ["HOME'S", scanHomes]]) {
  try {
    const rows = await fn();
    console.log(`${site}: ${rows.length} 行`);
    scanned.push(...rows);
    state.fail[site] = 0;
  } catch (e) {
    console.error(`${site}: ${e.message}`);
    state.fail[site] = (state.fail[site] || 0) + 1;
    const limit = site === 'SUUMO' ? 3 : 24;
    if (state.fail[site] === limit) errors.push(`${site} 已连续 ${limit} 次失败：${e.message}`);
  }
}

// 按房间合并
const byKey = new Map();
for (const r of scanned.filter(baseOk)) {
  const k = roomKey(r);
  const cur = byKey.get(k);
  if (!cur) byKey.set(k, { ...r, urls: [{ site: r.site, url: r.url }] });
  else {
    if (!cur.urls.some((u) => u.url === r.url)) cur.urls.push({ site: r.site, url: r.url });
    if (r.total < cur.total) Object.assign(cur, { ...r, urls: cur.urls });
  }
}
console.log(`范围内符合条件：${byKey.size} 间`);

const iso = now.toISOString();
for (const [k, r] of byKey) {
  // 旧版键（楼层按数字区分）迁移过来，避免改键后被当成新房源
  const lk = legacyKey(r);
  if (!state.rooms[k] && state.rooms[lk]) { state.rooms[k] = state.rooms[lk]; delete state.rooms[lk]; }
  const old = state.rooms[k];
  // HOME'S 详情页有反爬验证，读不到；同一间在 SUUMO 也有时用 SUUMO 的详情页
  const su = r.urls.find((u) => u.site === 'SUUMO');
  let detail = old?.detail || null, fresh = null;
  if (old?.parking && !(old.parking.retry && su)) r.parking = old.parking;
  else {
    fresh = su ? await suumoDetail(su.url) : null;
    r.parking = fresh?.parking || (su ? { fee: null, ok: true, text: '未取得' } : { fee: null, ok: true, text: "只在 HOME'S 上有，停车费请点开确认" });
    if (!su) r.parking.retry = true;
  }
  if (!r.parking.ok) { state.rooms[k] = { ...(old || { firstSeen: iso }), parking: r.parking, total: r.total, lastSeen: iso, excluded: true }; continue; }
  const isNew = !old || old.excluded;
  if (isNew) events.push({ r, tag: '新房源' });
  else if (r.total < old.total) events.push({ r, tag: `降价 ${man(old.total)}→${man(r.total)}万` });
  else if (Date.parse(old.lastSeen) < now - 3 * 864e5) events.push({ r, tag: '重新招租' });
  else if (su) {
    // 页面「情報更新日」变了就再推一次。每天最多查一次详情页，到了「次回更新予定日」也查
    const due = !detail || detail.url !== su.url || now - Date.parse(detail.checkedAt) > 20 * 3600e3 || (detail.next && jstDate(detail.next) <= now);
    if (due && !fresh) fresh = await suumoDetail(su.url);
    if (fresh && detail?.url === su.url && fresh.updated && detail.updated && fresh.updated !== detail.updated) {
      const diff = detailDiff(detail, fresh);
      events.push({
        r, tag: diff.length ? '信息更新' : '信息更新（内容没变）', priority: diff.length ? 4 : 2,
        note: `情報更新日 ${detail.updated} → ${fresh.updated}\n${diff.length ? diff.join('\n') : '租金、停车费、入住时间等都没变，可能是中介例行刷新'}`,
      });
    }
  }
  if (fresh) detail = fresh;
  state.rooms[k] = { firstSeen: old?.firstSeen || iso, lastSeen: iso, total: Math.min(r.total, old?.total ?? Infinity), parking: r.parking, name: r.name, url: r.urls[0].url, detail };
}
for (const [k, v] of Object.entries(state.rooms)) if (now - Date.parse(v.lastSeen) > cfg.forgetAfterDays * 864e5) delete state.rooms[k];

const live = [...byKey.values()].filter((r) => r.parking.ok);
if (firstRun) {
  live.sort((a, b) => a.total - b.total);
  await push(`现有房源 ${live.length} 间${live.length ? `｜最低 ${man(live[0].total)}万 ${areaName(live[0])}` : ''}`,
    [`现住处约 10 分钟内（${Object.values(cfg.towns).flat().length} 个町）${(cfg.stations || []).map((st) => `＋${st.name}駅 徒歩${st.minWalk ? `${st.minWalk}〜${st.maxWalk}分` : `${st.maxWalk}分以内`}${st.maxBus != null ? `或巴士${st.maxBus}分以内` : ''}`).join('')}，按 月租＋管理费 从低到高。`,
      `停车免费 ${live.filter((r) => r.parking.fee === 0).length} 间 · 3LDK ${live.filter((r) => r.layout.startsWith('3')).length} 间。之后有新房源或降价会再推送。`],
    live.map((r) => ({ r, tag: '在招' })));
  state.initializedAt = iso;
} else if (events.length) {
  const news = events.filter((e) => e.tag === '新房源').length;
  const title = news ? `新房源 ${news} 间${events.length > news ? `＋其他更新 ${events.length - news}` : ''}` : `房源更新 ${events.length} 间`;
  await push(title, events.length > 8 ? ['一次出现的比较多（可能是刚扩大了范围），合成一条列表。'] : [], events, { each: events.length <= 8, priority: 4 });
}
if (errors.length) await push('租房监视出错', [...errors, '网站可能改版或拦截了访问，需要修一下程序。'], [], { priority: 4 });
state.lastRun = iso;
if (!dry) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
console.log(`完成：事件 ${events.length}，错误 ${errors.length}`);
