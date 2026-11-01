const canvas = document.querySelector('#resonance');
const context = canvas.getContext('2d', { alpha: true });
const modes = [[3, 5], [4, 7], [2, 5], [5, 8]];
let mode = 0;
function drawPattern() {
  const { width, height } = canvas.getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * scale; canvas.height = height * scale;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  const [m, n] = modes[mode];
  let seed = 619;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Nodal lines of a Chladni mode: original mathematical drawing, no copied artwork.
  for (let y = 0; y < height; y += 3) {
    const v = y / height;
    for (let x = 0; x < width; x += 3) {
      const u = x / width;
      const f = Math.cos(m * Math.PI * u) * Math.cos(n * Math.PI * v) - Math.cos(n * Math.PI * u) * Math.cos(m * Math.PI * v);
      if (Math.abs(f) < .1) {
        const centerFade = 1 - .65 * Math.exp(-((u - .5) ** 2 + (v - .48) ** 2) / .045);
        context.fillStyle = `rgba(195,126,80,${(.17 + random() * .2) * centerFade})`;
        context.fillRect(x + random() * 3, y + random() * 3, .6 + random(), .6 + random());
      }
    }
  }
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawPattern, 100); });
document.querySelector('#shuffle').addEventListener('click', () => { mode = (mode + 1) % modes.length; drawPattern(); document.querySelector('#pattern-status').textContent = `Patrón ${mode + 1} de ${modes.length}`; });
drawPattern();
const os = /Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'mac' : /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent) ? 'linux' : null;
if (os) document.querySelector(`[data-platform="${os}"]`)?.classList.add('current');
async function loadDownloads() {
  try {
    const response = await fetch('https://api.github.com/repos/Matias-Sanmiguel/lupino/releases/tags/v0.1.2', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('Release unavailable');
    const release = await response.json();
    let readyInstallers = 0;
    for (const link of document.querySelectorAll('[data-asset]')) {
      const asset = release.assets.find(a => a.name === link.dataset.asset);
      if (asset) { link.href = asset.browser_download_url; link.title = `${asset.name} · ${(asset.size / 1048576).toFixed(0)} MB`; if (!link.dataset.asset.endsWith('.zip')) readyInstallers++; }
      else { link.title = 'Consultá el estado de esta compilación en GitHub Releases'; }
    }
    if (readyInstallers < 5) document.querySelector('#release-status').innerHTML = 'Algunos instaladores todavía se están compilando. Podés ver los archivos disponibles y el progreso en <a href="https://github.com/Matias-Sanmiguel/lupino/releases/tag/v0.1.2">GitHub Releases</a>.';
  } catch { /* All links already lead to the real release page; no broken download claims. */ }
}
loadDownloads();
