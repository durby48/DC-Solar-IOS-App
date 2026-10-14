// Builds report.html for "DC Solar KC — Our First 100 Days" from data.json (collect.mjs).
import { readFileSync, writeFileSync } from 'node:fs';

const here = (f) => new URL(`./${f}`, import.meta.url);
const D = JSON.parse(readFileSync(here('data.json'), 'utf8'));
const logo = `data:image/png;base64,${readFileSync(here('logo.png')).toString('base64')}`;
const S = D.stats;

const C = {
  green: '#22382B', green2: '#2F4A38', sage: '#7E9271', tan: '#C4A06A', tanDeep: '#9A7646',
  tanSoft: '#E6D5B8', cream: '#F6F0E3', paper: '#FBF8F1', ink: '#23302A', muted: '#6D6A5F',
};
const usd = (n, d = 0) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n) => Number(n).toLocaleString('en-US');
const k = (n) => (Math.abs(n) >= 1000 ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n) / 1000)}k` : usd(n));
const md = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const t = (iso) => new Date(`${iso}T12:00:00Z`).getTime();

/** Area/line chart as inline SVG. series: [{d, v}] */
function areaChart(series, { w = 640, h = 250, color = C.green2, fill = C.green2, step = false, ticks = 5, markEnd = true, zero = false, label } = {}) {
  const pad = { l: 58, r: 18, t: 18, b: 34 };
  const xs = series.map((p) => t(p.d));
  const vs = series.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let lo = Math.min(...vs, zero ? 0 : Infinity), hi = Math.max(...vs);
  const span = hi - lo || 1;
  lo = lo >= 0 && !zero ? 0 : lo - span * 0.06; hi += span * 0.1;
  const niceStep = (() => { const raw = (hi - lo) / ticks; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw); })();
  lo = Math.floor(lo / niceStep) * niceStep; hi = Math.ceil(hi / niceStep) * niceStep;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  let path = '';
  series.forEach((p, i) => {
    const x = X(t(p.d)), y = Y(p.v);
    if (i === 0) path += `M${x.toFixed(1)},${y.toFixed(1)}`;
    else if (step) path += `H${x.toFixed(1)}V${y.toFixed(1)}`;
    else path += `L${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const base = Y(Math.max(lo, 0) > 0 ? lo : 0 < lo ? lo : Math.max(lo, Math.min(0, hi)));
  const area = `${path}L${X(x1).toFixed(1)},${Y(lo).toFixed(1)}L${X(x0).toFixed(1)},${Y(lo).toFixed(1)}Z`;
  const grid = [];
  for (let v = lo; v <= hi + 1e-6; v += niceStep) {
    grid.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${v === 0 ? C.tanDeep : C.tanSoft}" stroke-width="${v === 0 ? 1.2 : 0.8}" ${v === 0 ? '' : 'stroke-dasharray="2 4"'}/>`);
    grid.push(`<text x="${pad.l - 10}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" class="ax">${k(v)}</text>`);
  }
  const months = [];
  for (let m = new Date(Date.UTC(2026, 6, 1)); m.getTime() <= x1; m.setUTCMonth(m.getUTCMonth() + 1)) {
    if (m.getTime() < x0) continue;
    const x = X(m.getTime() + 12 * 3600e3);
    months.push(`<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${h - pad.b}" stroke="${C.tanSoft}" stroke-width="0.8"/>`);
    months.push(`<text x="${x + 4}" y="${h - pad.b + 18}" class="ax">${m.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}</text>`);
  }
  const last = series.at(-1);
  const end = markEnd ? `<circle cx="${X(t(last.d))}" cy="${Y(last.v)}" r="4.5" fill="${C.tan}" stroke="${C.paper}" stroke-width="2"/>
    <text x="${X(t(last.d)) - 8}" y="${Y(last.v) - 12}" text-anchor="end" class="endlabel">${usd(last.v)}</text>` : '';
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${label ?? ''}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fill}" stop-opacity="0.38"/><stop offset="1" stop-color="${fill}" stop-opacity="0.03"/></linearGradient></defs>
    ${grid.join('')}${months.join('')}
    <path d="${area}" fill="url(#${id})"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${end}</svg>`;
}

/** Grouped monthly bars: collected (tan) and profit (green). */
function monthBars(months, { w = 640, h = 230 } = {}) {
  const pad = { l: 58, r: 18, t: 22, b: 34 };
  const keys = Object.keys(months).sort();
  const vals = keys.flatMap((m) => [D.monthlyIn[m] ?? 0, D.monthly[m] ?? 0]);
  let lo = Math.min(0, ...vals), hi = Math.max(...vals);
  const stepv = 10000; lo = Math.floor(lo / stepv) * stepv; hi = Math.ceil((hi * 1.08) / stepv) * stepv;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const band = (w - pad.l - pad.r) / keys.length;
  const bw = band * 0.26;
  const out = [];
  for (let v = lo; v <= hi; v += stepv) {
    out.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? C.tanDeep : C.tanSoft}" stroke-width="${v === 0 ? 1.2 : 0.8}" ${v === 0 ? '' : 'stroke-dasharray="2 4"'}/>`);
    out.push(`<text x="${pad.l - 10}" y="${Y(v) + 4}" text-anchor="end" class="ax">${k(v)}</text>`);
  }
  keys.forEach((m, i) => {
    const cx = pad.l + band * i + band / 2;
    const a = D.monthlyIn[m] ?? 0, p = D.monthly[m] ?? 0;
    const bar = (x, v, fill) => {
      const y1 = Y(Math.max(v, 0)), y2 = Y(Math.min(v, 0));
      return `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(1, y2 - y1)}" rx="3" fill="${fill}"/>
        <text x="${x + bw / 2}" y="${v >= 0 ? y1 - 6 : y2 + 14}" text-anchor="middle" class="barlabel">${k(v)}</text>`;
    };
    out.push(bar(cx - bw - 3, a, C.tan));
    out.push(bar(cx + 3, p, C.green2));
    const name = new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    out.push(`<text x="${cx}" y="${h - pad.b + 20}" text-anchor="middle" class="ax">${name}${m === D.today.slice(0, 7) ? ' (so far)' : ''}</text>`);
  });
  return `<svg viewBox="0 0 ${w} ${h}" class="chart">${out.join('')}</svg>`;
}

/** Decorative sunburst for the cover. */
function sunburst(cx, cy, r1, r2, n, color, op) {
  const rays = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (Math.PI * i) / (n - 1);
    rays.push(`<line x1="${cx + r1 * Math.cos(a)}" y1="${cy + r1 * Math.sin(a)}" x2="${cx + r2 * Math.cos(a)}" y2="${cy + r2 * Math.sin(a)}" stroke="${color}" stroke-width="${i % 2 ? 1.2 : 2.4}" stroke-opacity="${op}" stroke-linecap="round"/>`);
  }
  return rays.join('');
}

const photo = (cls, caption) => `<figure class="slot ${cls}"><div class="frame"><div class="inner"><span class="plus">+</span><span>${caption}</span></div></div></figure>`;

const valueNow = D.value.at(-1);
const valueStart = D.value.find((v) => v.d >= D.start) ?? D.value[0];
const crewNames = ['Isaiah Nettleton', 'Ben Nettleton', 'Simon Nettleton', 'Tyler Sisson', 'Garrett Nimsgern', 'Ethan Carson'];
const otherCosts = S.expenses - S.materials;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>DC Solar KC — Our First 100 Days</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Josefin+Sans:wght@400;600&display=block" rel="stylesheet">
<style>
@page { size: 8.5in 11in; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; background: ${C.cream}; color: ${C.ink}; }
body { font-family: 'Lora', Georgia, serif; font-size: 11.2pt; line-height: 1.55; }
.page { width: 8.5in; height: 11in; position: relative; overflow: hidden; page-break-after: always; break-after: page; background: ${C.paper}; }
.page:last-child { page-break-after: auto; break-after: auto; }
.wrap { position: absolute; inset: 0.7in 0.75in 0.75in 0.75in; }
h1, h2, h3, .display { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 600; letter-spacing: 0.01em; margin: 0; color: ${C.green}; }
.eyebrow { font-family: 'Josefin Sans', 'Segoe UI', sans-serif; text-transform: uppercase; letter-spacing: 0.28em; font-size: 8.5pt; color: ${C.tanDeep}; font-weight: 600; }
.rule { height: 1px; background: linear-gradient(90deg, transparent, ${C.tan}, transparent); margin: 14px 0; }
.folio { position: absolute; bottom: 0.38in; left: 0.75in; right: 0.75in; display: flex; justify-content: space-between; font-family: 'Josefin Sans', sans-serif; font-size: 7.5pt; letter-spacing: 0.22em; text-transform: uppercase; color: ${C.tanDeep}; }
.border { position: absolute; inset: 0.32in; border: 1px solid ${C.tanSoft}; pointer-events: none; }
.border::after { content: ''; position: absolute; inset: 5px; border: 0.5px solid ${C.tanSoft}; }

/* cover */
.cover { background: radial-gradient(ellipse at 50% 108%, #3B5A44 0%, ${C.green} 55%, #18271E 100%); color: ${C.cream}; }
.cover svg.sun { position: absolute; left: 0; bottom: 0; width: 100%; height: 6.2in; }
.cover .top { position: absolute; top: 0.95in; left: 0; right: 0; text-align: center; }
.cover .logo { width: 3.3in; filter: invert(1) sepia(0.35) brightness(1.05); mix-blend-mode: screen; opacity: 0.95; }
.cover .eyebrow { color: ${C.tan}; margin-top: 0.5in; }
.cover h1 { color: ${C.cream}; font-size: 54pt; line-height: 1.02; margin-top: 0.18in; font-weight: 600; }
.cover h1 em { color: ${C.tan}; font-style: italic; font-weight: 500; }
.cover .dates { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 17pt; color: ${C.tanSoft}; margin-top: 0.2in; }
.cover .ring { position: absolute; left: 50%; bottom: 0.9in; transform: translateX(-50%); width: 2.4in; height: 2.4in; border-radius: 50%; background: radial-gradient(circle at 50% 40%, #E8C98F 0%, ${C.tan} 55%, ${C.tanDeep} 100%); box-shadow: 0 0 0 10px rgba(196,160,106,0.15), 0 0 0 26px rgba(196,160,106,0.07); display: flex; align-items: center; justify-content: center; flex-direction: column; color: ${C.green}; }
.cover .ring b { font-family: 'Cormorant Garamond', serif; font-size: 60pt; line-height: 0.9; }
.cover .ring span { font-family: 'Josefin Sans', sans-serif; letter-spacing: 0.3em; font-size: 9pt; text-transform: uppercase; font-weight: 600; }
.cover .foot { position: absolute; bottom: 0.42in; left: 0; right: 0; text-align: center; font-family: 'Josefin Sans', sans-serif; letter-spacing: 0.32em; font-size: 8pt; color: ${C.tanSoft}; text-transform: uppercase; }

/* letter */
.letter .logo { width: 1.7in; mix-blend-mode: multiply; }
.letter h2 { font-size: 28pt; margin: 4px 0 0; }
.letter { font-size: 11pt; line-height: 1.55; } .letter p { margin: 0 0 10px; text-align: justify; hyphens: auto; }
.letter .salute { font-family: 'Cormorant Garamond', serif; font-size: 15pt; font-style: italic; color: ${C.green2}; margin-bottom: 10px; }
blockquote { margin: 12px 0.45in; padding: 6px 0 6px 18px; border-left: 2px solid ${C.tan}; font-family: 'Cormorant Garamond', serif; font-size: 14.5pt; font-style: italic; color: ${C.green2}; line-height: 1.35; }
blockquote cite { display: block; font-family: 'Josefin Sans', sans-serif; font-style: normal; font-size: 7.5pt; letter-spacing: 0.24em; text-transform: uppercase; color: ${C.tanDeep}; margin-top: 4px; }
.names { color: ${C.green}; font-weight: 600; }
.sign { margin-top: 6px; }
.sign .script { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 26pt; color: ${C.green}; line-height: 1; }
.sign .who { font-family: 'Josefin Sans', sans-serif; letter-spacing: 0.2em; text-transform: uppercase; font-size: 8pt; color: ${C.tanDeep}; margin-top: 4px; }

/* numbers */
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 16px; }
.stat { background: ${C.cream}; border: 1px solid ${C.tanSoft}; border-radius: 14px; padding: 14px 16px 12px; position: relative; overflow: hidden; }
.stat::before { content: ''; position: absolute; right: -22px; top: -22px; width: 70px; height: 70px; border-radius: 50%; background: radial-gradient(circle, rgba(196,160,106,0.28), transparent 70%); }
.stat .v { font-family: 'Cormorant Garamond', serif; font-weight: 700; font-size: 31pt; color: ${C.green}; line-height: 1.05; }
.stat .l { font-family: 'Josefin Sans', sans-serif; text-transform: uppercase; letter-spacing: 0.16em; font-size: 7.6pt; color: ${C.tanDeep}; font-weight: 600; }
.stat .n { font-size: 8.6pt; color: ${C.muted}; margin-top: 3px; line-height: 1.35; }
.stat.dark { background: ${C.green}; border-color: ${C.green}; }
.stat.dark .v { color: ${C.cream}; } .stat.dark .l { color: ${C.tan}; } .stat.dark .n { color: ${C.tanSoft}; }

/* charts */
.chartcard { background: ${C.cream}; border: 1px solid ${C.tanSoft}; border-radius: 16px; padding: 14px 18px 8px; margin-top: 12px; }
.chartcard h3 { font-size: 20pt; }
.chartcard .sub { font-size: 9pt; color: ${C.muted}; margin: 0 0 4px; }
.chart { width: 100%; height: auto; display: block; }
.chart .ax { font-family: 'Josefin Sans', sans-serif; font-size: 10px; fill: ${C.muted}; letter-spacing: 0.04em; }
.chart .endlabel { font-family: 'Cormorant Garamond', serif; font-weight: 700; font-size: 15px; fill: ${C.green}; }
.chart .barlabel { font-family: 'Cormorant Garamond', serif; font-weight: 700; font-size: 12.5px; fill: ${C.ink}; }
.kpis { display: flex; gap: 10px; margin: 2px 0 6px; }
.kpi { flex: 1; border-top: 2px solid ${C.tan}; padding-top: 4px; }
.kpi b { display: block; font-family: 'Cormorant Garamond', serif; font-size: 17pt; color: ${C.green}; line-height: 1.1; }
.kpi span { font-family: 'Josefin Sans', sans-serif; font-size: 7.2pt; letter-spacing: 0.16em; text-transform: uppercase; color: ${C.tanDeep}; }
.legend { font-family: 'Josefin Sans', sans-serif; font-size: 7.6pt; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.muted}; display: flex; gap: 16px; margin-bottom: 2px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
table.pl { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 10.5pt; }
table.pl td { padding: 4px 4px; border-bottom: 1px dotted ${C.tanSoft}; }
table.pl td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
table.pl tr.total td { border-top: 1.5px solid ${C.tan}; border-bottom: none; font-family: 'Cormorant Garamond', serif; font-size: 16pt; font-weight: 700; color: ${C.green}; padding-top: 8px; }
.note { font-size: 8.4pt; color: ${C.muted}; font-style: italic; margin-top: 6px; }

/* photo slots */
.slot { margin: 0; height: 100%; }
.slot .frame { width: 100%; height: 100%; padding: 7px; background: ${C.cream}; border: 1px solid ${C.tanSoft}; border-radius: 6px; box-shadow: 0 1px 0 ${C.tanSoft}; }
.slot .inner { width: 100%; height: 100%; border: 1.5px dashed ${C.tan}; border-radius: 3px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: repeating-linear-gradient(135deg, rgba(196,160,106,0.06) 0 12px, transparent 12px 24px); font-family: 'Josefin Sans', sans-serif; font-size: 7.6pt; letter-spacing: 0.2em; text-transform: uppercase; color: ${C.tanDeep}; text-align: center; }
.slot .plus { font-family: 'Cormorant Garamond', serif; font-size: 26pt; letter-spacing: 0; color: ${C.tan}; line-height: 0.8; }
.gallery { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 2.75in 2.75in 2.15in; gap: 14px; margin-top: 14px; }
.gallery .wide { grid-column: span 2; }
.stats-photo { height: 3.55in; margin-top: 16px; }

/* closing */
.closing { background: radial-gradient(ellipse at 50% 0%, #3B5A44 0%, ${C.green} 60%, #18271E 100%); color: ${C.cream}; }
.closing .slot .frame { background: rgba(246,240,227,0.06); border-color: rgba(196,160,106,0.4); }
.closing .slot .inner { color: ${C.tan}; border-color: rgba(196,160,106,0.65); }
.closing h2 { color: ${C.cream}; font-size: 40pt; text-align: center; }
.closing h2 em { color: ${C.tan}; }
.closing blockquote { color: ${C.tanSoft}; border-color: ${C.tan}; margin: 18px 0.9in; }
.closing .logo { width: 2.2in; filter: invert(1) sepia(0.35) brightness(1.05); mix-blend-mode: screen; display: block; margin: 0 auto; opacity: 0.9; }
</style></head><body>

<!-- 1. Cover -->
<section class="page cover">
  <svg class="sun" viewBox="0 0 816 600" preserveAspectRatio="xMidYMax slice">
    ${sunburst(408, 600, 150, 760, 37, C.tan, 0.22)}
    <circle cx="408" cy="600" r="250" fill="none" stroke="${C.tan}" stroke-opacity="0.18" stroke-width="1"/>
    <circle cx="408" cy="600" r="330" fill="none" stroke="${C.tan}" stroke-opacity="0.1" stroke-width="1"/>
  </svg>
  <div class="top">
    <img class="logo" src="${logo}" alt="DC Solar">
    <div class="eyebrow">DC Solar KC · Kansas City</div>
    <h1>Our First<br><em>100 Days</em></h1>
    <div class="dates">${longDate(D.start)} — ${longDate(D.today)}</div>
  </div>
  <div class="ring"><b>100</b><span>days in</span></div>
  <div class="foot">Solar removal · reinstall · residential &amp; commercial installations</div>
</section>

<!-- 2. Letter -->
<section class="page letter">
  <div class="border"></div>
  <div class="wrap">
    <img class="logo" src="${logo}" alt="DC Solar">
    <div class="eyebrow" style="margin-top:10px">A letter from our co-owner</div>
    <h2>One hundred days of grace</h2>
    <div class="rule"></div>
    <div class="salute">To our crew, our customers, and everyone who has stood behind us,</div>
    <p>On July 1st we opened the doors of DC Solar KC with a simple plan: do honest work, take care of our people, and treat every solar system like it was our own. 100 days later, all I can say is that God has been faithful far beyond anything we planned or deserved.</p>
    <p>When Isaiah and I started DC Solar, we honestly were not sure we would survive the leap of faith the Lord had led us to. So for these first 100 days we took our stress and our fears to Christ, asking Him to help us steward a company modeled after His heart — one that serves others and glorifies the Father. And on top of 100-degree roofs, with our knees ready to buckle underneath us, He kept our phones ringing and our emails chiming. Day after day He showed us that our work is valuable to others, and that our services are in higher demand than we ever thought possible.</p>
    <p>In these first months our crew logged more than ${num(Math.floor(S.hours / 50) * 50)} hours on rooftops from Wichita to Lawrence, Parkville, Blue Springs, Harrisonville, and plenty of other surrounding towns. Together we facilitated the installation, removal, and reinstallation of ${num(S.panels)} panels, laid critter guard around ${num(S.critter)} more, finished ${S.projectsCompleted} projects for ${S.customers} customers, and added a van and two trucks to the fleet. None of that happens without the men I want to thank next.</p>
    <blockquote>“Commit thy works unto the LORD, and thy thoughts shall be established.”<cite>Proverbs 16:3</cite></blockquote>
    <p>Thank you to <span class="names">${crewNames.slice(0, -1).join(', ')} and ${crewNames.at(-1)}</span> — you carried the panels, drove the miles, worked the long days in the heat, and showed up ready again the next morning. Thank you to <span class="names">Ken Crum, Carson Keating and Clark Lynch</span> for the calls, the relationships, and for believing in what we are building before there was much to see. Every one of you is part of this story.</p>
  </div>
  <div class="folio"><span>Our First 100 Days</span><span>A letter from Devon</span></div>
</section>

<section class="page letter">
  <div class="border"></div>
  <div class="wrap">
    <div class="eyebrow">A letter from our co-owner · continued</div>
    <div class="rule"></div>
    <p>To our customers and partners — <span class="names">Cromwell Environmental, SunSmart, Your Neighborhood Roofer, Kansas Solar Systems, Elevation Roofing and Trusted Roofing</span> — thank you for trusting a brand-new company with your projects and your homeowners. We do not take that trust lightly, and we intend to keep earning it.</p>
    <p>We are still learning, and the next hundred days will bring their own challenges. But we will keep working the way Scripture asks us to:</p>
    <blockquote>“And whatsoever ye do, do it heartily, as to the Lord, and not unto men.”<cite>Colossians 3:23</cite></blockquote>
    <div class="sign"><div style="font-size:10.5pt">With gratitude,</div><div class="script">Devon Durbin</div><div class="who">Co-Owner · DC Solar LLC</div></div>
    <div style="height:4.75in;margin-top:24px">${photo('', 'Insert photo — Devon &amp; Isaiah')}</div>
  </div>
  <div class="folio"><span>Our First 100 Days</span><span>DC Solar KC</span></div>
</section>

<!-- 3. By the numbers -->
<section class="page">
  <div class="border"></div>
  <div class="wrap">
    <div class="eyebrow">${md(D.start)} – ${md(D.today)}, 2026</div>
    <h2 style="font-size:34pt">By the numbers</h2>
    <div class="rule"></div>
    <div class="stats">
      <div class="stat dark"><div class="l">Days in business</div><div class="v">100</div><div class="n">Open since July 1, 2026</div></div>
      <div class="stat"><div class="l">Hours worked</div><div class="v">${num(S.hours)}</div><div class="n">Logged by the crew on site and in the shop</div></div>
      <div class="stat"><div class="l">Panels installed</div><div class="v">${num(S.panels)}</div><div class="n">New installs plus removals and reinstalls, completed</div></div>
      <div class="stat"><div class="l">Critter guard laid</div><div class="v">${num(S.critter)}</div><div class="n">Panels protected from birds and rodents</div></div>
      <div class="stat"><div class="l">Projects completed</div><div class="v">${S.projectsCompleted}</div><div class="n">${S.projectsActive} projects worked on in all</div></div>
      <div class="stat"><div class="l">Customers served</div><div class="v">${S.customers}</div><div class="n">Homeowners, roofers and solar partners</div></div>
      <div class="stat dark"><div class="l">Revenue collected</div><div class="v">${k(S.revenue)}</div><div class="n">${usd(S.revenue)} paid by customers</div></div>
      <div class="stat"><div class="l">Payroll paid</div><div class="v">${k(S.payroll)}</div><div class="n">${S.payrollRuns} pay runs · ${usd(S.grossWages)} in wages</div></div>
      <div class="stat"><div class="l">Vehicles bought</div><div class="v">${S.vehicles.length}</div><div class="n">${S.vehicles.map((v) => v.replace(/\s*\(.*\)/, '')).join(' · ')}</div></div>
    </div>
    <div class="stats-photo">${photo('', 'Insert photo — the crew on a job')}</div>
  </div>
  <div class="folio"><span>Our First 100 Days</span><span>By the numbers</span></div>
</section>

<!-- 4. Value + cash -->
<section class="page">
  <div class="border"></div>
  <div class="wrap">
    <div class="eyebrow">The financial picture</div>
    <h2 style="font-size:34pt">Value &amp; cash</h2>
    <div class="rule"></div>
    <div class="chartcard">
      <h3>Company value</h3>
      <p class="sub">What DC Solar owns — cash, money customers owe us, and our vehicles — less what we owe, week by week (QuickBooks balance sheet).</p>
      <div class="kpis"><div class="kpi"><b>${usd(valueStart.v)}</b><span>week one</span></div><div class="kpi"><b>${usd(Math.max(...D.value.map((v) => v.v)))}</b><span>peak</span></div><div class="kpi"><b>${usd(valueNow.v)}</b><span>today</span></div></div>
      ${areaChart(D.value.filter((v) => v.d >= '2026-06-27'), { color: C.green2, fill: C.sage, h: 225, label: 'Company value' })}
    </div>
    <div class="chartcard">
      <h3>Cash in the bank</h3>
      <p class="sub">The Chase business account at the end of every banking day.</p>
      <div class="kpis"><div class="kpi"><b>${usd(S.cashStart, 2)}</b><span>June 30</span></div><div class="kpi"><b>${usd(Math.max(...D.cash.map((c) => c.v)), 2)}</b><span>high point</span></div><div class="kpi"><b>${usd(S.cashToday, 2)}</b><span>${md(D.cash.at(-1).d)}</span></div></div>
      ${areaChart(D.cash, { step: true, color: C.tanDeep, fill: C.tan, h: 225, label: 'Cash' })}
    </div>
  </div>
  <div class="folio"><span>Our First 100 Days</span><span>Value &amp; cash</span></div>
</section>

<!-- 5. Profit -->
<section class="page">
  <div class="border"></div>
  <div class="wrap">
    <div class="eyebrow">The financial picture</div>
    <h2 style="font-size:34pt">Profit</h2>
    <div class="rule"></div>
    <div class="chartcard">
      <h3>Profit, building day by day</h3>
      <p class="sub">Money collected less job costs, overhead and payroll — counted the day it moved (cash basis).</p>
      ${areaChart(D.profit, { color: C.green2, fill: C.green2, h: 190, zero: true, label: 'Cumulative profit' })}
    </div>
    <div class="chartcard">
      <h3>Month by month</h3>
      <div class="legend"><span><i style="background:${C.tan}"></i>Collected</span><span><i style="background:${C.green2}"></i>Profit</span></div>
      ${monthBars(D.monthly, { h: 175 })}
    </div>
    <table class="pl">
      <tr><td>Revenue collected from customers</td><td>${usd(S.revenue)}</td></tr>
      <tr><td>Job materials</td><td>−${usd(S.materials)}</td></tr>
      <tr><td>Fuel, tools, vehicles, insurance &amp; other costs</td><td>−${usd(otherCosts)}</td></tr>
      <tr><td>Payroll — wages and payroll taxes</td><td>−${usd(S.payroll)}</td></tr>
      <tr class="total"><td>Net profit</td><td>${usd(S.netProfit)}</td></tr>
    </table>
    <p class="note">${usd(S.vehicleCost)} of vehicles are company property, not expenses, so they are not in the costs above. Figures from DC Solar's books in QuickBooks, ${longDate(D.start)} – ${longDate(D.today)}.</p>
  </div>
  <div class="folio"><span>Our First 100 Days</span><span>Profit</span></div>
</section>

<!-- 6. Gallery -->
<section class="page">
  <div class="border"></div>
  <div class="wrap">
    <div class="eyebrow">On the roof</div>
    <h2 style="font-size:34pt">Our work</h2>
    <div class="rule"></div>
    <div class="gallery">
      ${photo('', 'Insert photo — installed project')}
      ${photo('', 'Insert photo — installed project')}
      ${photo('', 'Insert photo — before &amp; after')}
      ${photo('', 'Insert photo — critter guard')}
      ${photo('wide', 'Insert photo — marketing image')}
    </div>
  </div>
  <div class="folio"><span>Our First 100 Days</span><span>Our work</span></div>
</section>

<!-- 7. Closing -->
<section class="page closing">
  <div class="wrap" style="display:flex;flex-direction:column">
    <div class="eyebrow" style="text-align:center;color:${C.tan}">Looking ahead</div>
    <h2>Here’s to the <em>next hundred</em></h2>
    <div style="height:4.1in;margin-top:22px">${photo('', 'Insert photo — the DC Solar team')}</div>
    <blockquote>“This is the day which the LORD hath made; we will rejoice and be glad in it.”<cite>Psalm 118:24</cite></blockquote>
    <div style="margin-top:auto"><img class="logo" src="${logo}" alt="DC Solar"></div>
    <div style="text-align:center;font-family:'Josefin Sans',sans-serif;letter-spacing:0.3em;font-size:8pt;color:${C.tan};margin-top:10px;text-transform:uppercase">DC Solar LLC · Kansas City · dcsolarkc.com</div>
  </div>
</section>
</body></html>`;

writeFileSync(here('report.html'), html);
console.log('report.html written');






