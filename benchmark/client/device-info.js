// What a browser can tell about the device it runs on. Everything is optional:
// each probe that a browser does not support is simply left out.

async function webglInfo() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { status: 'WebGL unavailable' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const info = {
      version: gl instanceof WebGL2RenderingContext ? 2 : 1,
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return info;
  } catch (e) {
    return { status: `WebGL failed: ${e.message}` };
  }
}

/** WebGPU needs a secure context: https, or http://localhost. */
export function webgpuUnavailableReason() {
  if (!window.isSecureContext) return 'needs a secure context: open the page over https or on localhost, or allow this address in chrome://flags/#unsafely-treat-insecure-origin-as-secure';
  if (!('gpu' in navigator)) return 'this browser does not support WebGPU';
  return '';
}

async function webgpuInfo() {
  const reason = webgpuUnavailableReason();
  if (reason) return { status: reason };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { status: 'no WebGPU adapter' };
    const i = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    return {
      status: 'available',
      vendor: i.vendor || '',
      architecture: i.architecture || '',
      device: i.device || '',
      description: i.description || '',
      isFallbackAdapter: Boolean(i.isFallbackAdapter ?? adapter.isFallbackAdapter),
      features: adapter.features ? adapter.features.size : null,
    };
  } catch (e) {
    return { status: `WebGPU failed: ${e.message}` };
  }
}

async function clientHints() {
  const d = navigator.userAgentData;
  if (!d) return null;
  const out = { brands: d.brands, mobile: d.mobile, platform: d.platform };
  try {
    // high-entropy hints are only given out in secure contexts
    Object.assign(out, await d.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'fullVersionList', 'formFactors']));
  } catch {
    // keep the low-entropy values
  }
  return out;
}

async function battery() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return { level: b.level, charging: b.charging };
  } catch {
    return null;
  }
}

export async function collectDeviceInfo() {
  const [uaData, webgl, webgpu, bat] = await Promise.all([clientHints(), webglInfo(), webgpuInfo(), battery()]);
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // not important
  }
  return {
    userAgent: navigator.userAgent,
    uaData,
    platform: navigator.platform || '',
    language: navigator.language || '',
    timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio || 1,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    secureContext: window.isSecureContext,
    crossOriginIsolated: Boolean(window.crossOriginIsolated),
    connection: navigator.connection ? navigator.connection.effectiveType || '' : '',
    battery: bat,
    webgl,
    webgpu,
  };
}
