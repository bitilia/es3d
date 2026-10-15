// Turn what a browser reports about itself into a few comparable columns:
// device type, operating system, browser, model and GPU.
//
// User-Agent Client Hints (navigator.userAgentData) are preferred where the
// browser offers them; the high-entropy hints (model, platform version, full
// browser version) are only available in a secure context. Otherwise the
// User-Agent string is parsed. Chrome on Android reduces it to "Android 10; K",
// so over plain http the phone model is usually unknown and the GPU name from
// WebGL or WebGPU is the best identifier.

const clean = (s, max = 200) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function osFromHints(ch) {
  const platform = clean(ch.platform);
  const v = clean(ch.platformVersion);
  if (!platform) return null;
  if (platform === 'Windows' && v) return { os: 'Windows', osVersion: Number(v.split('.')[0]) >= 13 ? '11' : '10' };
  if (platform === 'macOS') return { os: 'macOS', osVersion: v };
  if (platform === 'Chrome OS') return { os: 'ChromeOS', osVersion: v };
  return { os: platform, osVersion: v };
}

function osFromUA(ua) {
  let m;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) return { os: 'Windows', osVersion: m[1] === '10.0' ? '10 or 11' : m[1] };
  if ((m = ua.match(/Android ([\d.]+)/))) return { os: 'Android', osVersion: m[1] };
  if ((m = ua.match(/(?:iPhone|CPU) OS ([\d_]+)/))) return { os: /iPad/.test(ua) ? 'iPadOS' : 'iOS', osVersion: m[1].replace(/_/g, '.') };
  if ((m = ua.match(/Mac OS X ([\d_.]+)/))) return { os: 'macOS', osVersion: m[1].replace(/_/g, '.') };
  if (/CrOS/.test(ua)) return { os: 'ChromeOS', osVersion: '' };
  if (/Linux/.test(ua)) return { os: 'Linux', osVersion: '' };
  return { os: '', osVersion: '' };
}

const GENERIC_BRAND = /not.?a.?brand|^chromium$/i;

function browserFromHints(ch) {
  const list = Array.isArray(ch.fullVersionList) && ch.fullVersionList.length ? ch.fullVersionList : ch.brands;
  if (!Array.isArray(list) || !list.length) return null;
  const named = list.filter((b) => b && !GENERIC_BRAND.test(clean(b.brand)));
  const pick = named[0] || list.find((b) => /chromium/i.test(clean(b.brand)));
  return pick ? { browser: clean(pick.brand), browserVersion: clean(pick.version) } : null;
}

function browserFromUA(ua) {
  const rules = [
    [/Edg(?:A|iOS)?\/([\d.]+)/, 'Microsoft Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/FxiOS\/([\d.]+)/, 'Firefox'],
    [/CriOS\/([\d.]+)/, 'Chrome'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  for (const [re, name] of rules) {
    const m = ua.match(re);
    if (m) return { browser: name, browserVersion: m[1] };
  }
  return { browser: '', browserVersion: '' };
}

function deviceType(ua, ch, touchPoints) {
  if (ch && typeof ch.mobile === 'boolean') {
    if (Array.isArray(ch.formFactors) && ch.formFactors.some((f) => /tablet/i.test(f))) return 'tablet';
    if (ch.mobile) return 'mobile';
    if (/Android/.test(ua)) return 'tablet';
    return 'desktop';
  }
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'tablet';
  if (/Mobi|iPhone|iPod/.test(ua)) return 'mobile';
  if (/Android/.test(ua)) return 'tablet';
  return 'desktop';
}

function modelFrom(ua, ch) {
  const hinted = clean(ch && ch.model);
  if (hinted) return hinted;
  const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/);
  if (m && m[1] !== 'K') return clean(m[1]);
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return '';
}

function gpuFrom(info) {
  const g = info.webgpu || {};
  const fromWebGPU = [g.vendor, g.architecture, g.description || g.device].map((s) => clean(s, 80)).filter(Boolean).join(' ');
  const gl = info.webgl || {};
  return clean(gl.renderer, 160) || fromWebGPU;
}

/**
 * @param {Record<string, any>} info what the page collected (see client/device-info.js)
 * @param {Record<string, string|string[]|undefined>} headers request headers
 */
export function describeDevice(info = {}, headers = {}) {
  const ua = clean(info.userAgent, 400) || clean(String(headers['user-agent'] || ''), 400);
  const ch = info.uaData && typeof info.uaData === 'object' ? info.uaData : null;
  const os = (ch && osFromHints(ch)) || osFromUA(ua);
  const br = (ch && browserFromHints(ch)) || browserFromUA(ua);
  const type = deviceType(ua, ch, Number(info.maxTouchPoints) || 0);
  const model = modelFrom(ua, ch);
  const gpu = gpuFrom(info);
  const major = (br.browserVersion || '').split('.')[0];
  const auto = [model || [os.os, type === 'desktop' ? '' : type].filter(Boolean).join(' '), [br.browser, major].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return {
    label: clean(info.name, 60) || auto || 'unknown device',
    deviceType: type,
    os: os.os,
    osVersion: os.osVersion,
    browser: br.browser,
    browserVersion: br.browserVersion,
    model,
    gpu,
    userAgent: ua,
  };
}
