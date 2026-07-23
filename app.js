'use strict';

/* =========================================================================
   Scanly — vanilla JS PWA document scanner
   Sections: DOM refs · navigation · toast · camera · edge detection ·
             capture/warp · review/adjust · pages builder · storage (IDB) ·
             PDF export/share · library · install prompt · boot
   ========================================================================= */

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);

const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const cameraPlaceholder = $('camera-placeholder');
const cameraPlaceholderText = $('camera-placeholder-text');
const confidencePill = $('confidence-pill');
const confidenceText = $('confidence-text');
const filmstrip = $('filmstrip');
const captureProcessing = $('capture-processing');
const shutterBtn = $('btn-shutter');
const pageCountEl = $('page-count');
const btnDone = $('btn-done');
const btnFlash = $('btn-flash');
const btnOpenPages = $('btn-open-pages');
const toastEl = $('toast');
const tabbar = $('tabbar');

const reviewCanvas = $('review-canvas');
const reviewCtx = reviewCanvas.getContext('2d');
const filterChips = document.querySelectorAll('.chip');
const sBright = $('s-bright');
const sContrast = $('s-contrast');
const sSat = $('s-sat');

const pageGrid = $('page-grid');
const docTitleInput = $('doc-title');
const docMeta = $('doc-meta');

const libraryList = $('library-list');
const libraryEmpty = $('library-empty');
const viewerOverlay = $('viewer-overlay');
const viewerPages = $('viewer-pages');
const viewerTitle = $('viewer-title');

const installBanner = $('install-banner');

/* ---------------- App state ---------------- */
let stream = null;
let cvReady = false;
let detecting = false;
let lastDetectTime = 0;
let lastQuad = null;         // { points: [[x,y],x4] in video-native px, confidence }
let stableCount = 0;
let autoArmed = true;
let capturing = false;

let pages = [];               // [{ id, full: dataURL, thumb: dataURL }]
let pendingPage = null;       // { canvas, mode, bright, contrast, sat }
let currentDocId = null;
let currentTitle = '';

const AUTO_CAPTURE_FRAMES = 7;   // ~ 7 * 110ms ≈ 0.77s held steady
const LOCK_THRESHOLD = 0.42;

const FILTER_PRESETS = {
  color:   { bright: 0, contrast: 10, sat: 0 },
  enhance: { bright: 8, contrast: 30, sat: 12 },
  bw:      { bright: 4, contrast: 60, sat: -100 },
  gray:    { bright: 0, contrast: 15, sat: -100 },
};
let currentMode = 'color';

/* ---------------- Toast ---------------- */
let toastTimer = null;
function showToast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------------- Navigation ---------------- */
const SCREENS = ['scan-screen', 'review-screen', 'pages-screen', 'library-screen'];
function showScreen(id) {
  for (const s of SCREENS) {
    const el = $(s);
    if (!el) continue;
    el.hidden = s !== id;
  }
  tabbar.hidden = (id === 'review-screen' || id === 'pages-screen');
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === id);
  });
  if (id === 'scan-screen') startCamera(); else stopDetectionOnly();
  if (id === 'library-screen') renderLibrary();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => showScreen(btn.dataset.tab));
});

/* ================================================================
   CAMERA
   ================================================================ */
async function startCamera() {
  if (stream) { resizeOverlay(); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    cameraPlaceholder.hidden = true;
    await video.play().catch(() => {});
    resizeOverlay();
    setupFlashButton();
    startDetectionLoop();
  } catch (err) {
    cameraPlaceholder.hidden = false;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      cameraPlaceholderText.textContent = 'Camera access was denied. Enable it in your browser or system settings, then try again.';
    } else if (err.name === 'NotFoundError') {
      cameraPlaceholderText.textContent = 'No camera was found on this device.';
    } else {
      cameraPlaceholderText.textContent = 'Camera unavailable right now. You can still import a photo from Library.';
    }
  }
}

function stopCameraStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
function stopDetectionOnly() {
  // Keep camera warm while on review/pages screens (fast return-to-scan),
  // but release it fully if the tab is hidden for a while.
}

$('btn-enable-camera').addEventListener('click', startCamera);

function resizeOverlay() {
  const rect = overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(rect.width * dpr);
  overlay.height = Math.round(rect.height * dpr);
}
window.addEventListener('resize', resizeOverlay);
window.addEventListener('orientationchange', () => setTimeout(resizeOverlay, 250));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCameraStream();
  } else if (!$('scan-screen').hidden) {
    startCamera();
  }
});

/* Flash / torch */
function setupFlashButton() {
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      btnFlash.hidden = false;
      let on = false;
      btnFlash.onclick = async () => {
        on = !on;
        await track.applyConstraints({ advanced: [{ torch: on }] });
        btnFlash.style.color = on ? 'var(--amber)' : '';
      };
    } else {
      btnFlash.hidden = true;
    }
  } catch { btnFlash.hidden = true; }
}

/* ================================================================
   EDGE DETECTION (OpenCV.js)
   ================================================================ */
function waitForCv() {
  const poll = setInterval(() => {
    if (window.cv && typeof cv.Mat === 'function') {
      clearInterval(poll);
      cvReady = true;
    }
  }, 200);
}
waitForCv();

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
const DETECT_W = 400;

function startDetectionLoop() {
  if (detecting) return;
  detecting = true;
  requestAnimationFrame(detectFrame);
}

function detectFrame() {
  if ($('scan-screen').hidden || !stream) { detecting = false; return; }
  requestAnimationFrame(detectFrame);

  if (!cvReady || video.readyState < 2 || !video.videoWidth) return;
  const now = performance.now();
  if (now - lastDetectTime < 110) return;
  lastDetectTime = now;

  const scale = DETECT_W / video.videoWidth;
  const dh = Math.round(video.videoHeight * scale);
  detectCanvas.width = DETECT_W;
  detectCanvas.height = dh;
  detectCtx.drawImage(video, 0, 0, DETECT_W, dh);

  let src, gray, blurred, edges, hierarchy, contours, kernel;
  let best = null, bestArea = 0;
  try {
    src = cv.imread(detectCanvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = DETECT_W * dh;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > frameArea * 0.15 && area > bestArea) {
          bestArea = area;
          if (best) best.delete();
          best = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    if (best) {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push([best.data32S[i * 2] / scale, best.data32S[i * 2 + 1] / scale]);
      }
      const confidence = Math.max(0, Math.min(1, bestArea / (frameArea * 0.82)));
      lastQuad = { points: pts, confidence };
      best.delete();
    } else {
      lastQuad = null;
    }
  } catch (e) {
    lastQuad = null;
  } finally {
    src && src.delete(); gray && gray.delete(); blurred && blurred.delete();
    edges && edges.delete(); hierarchy && hierarchy.delete(); contours && contours.delete();
    kernel && kernel.delete();
  }

  drawOverlay();
  updateConfidence();
}

function videoToCanvasTransform() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = overlay.width, ch = overlay.height;
  const videoRatio = vw / vh, boxRatio = cw / ch;
  let scale, offsetX = 0, offsetY = 0;
  if (videoRatio > boxRatio) {
    scale = ch / vh;
    offsetX = (cw - vw * scale) / 2;
  } else {
    scale = cw / vw;
    offsetY = (ch - vh * scale) / 2;
  }
  return { scale, offsetX, offsetY };
}
function mapPt(x, y, t) { return [x * t.scale + t.offsetX, y * t.scale + t.offsetY]; }

function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (!lastQuad) return;
  const t = videoToCanvasTransform();
  const pts = lastQuad.points.map(([x, y]) => mapPt(x, y, t));
  const locked = lastQuad.confidence >= LOCK_THRESHOLD;
  const color = locked ? '#34d399' : '#ffb74d';

  overlayCtx.save();
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = 3;
  overlayCtx.globalAlpha = 0.9;
  overlayCtx.beginPath();
  pts.forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
  overlayCtx.closePath();
  overlayCtx.fillStyle = locked ? 'rgba(52,211,153,0.12)' : 'rgba(255,183,77,0.08)';
  overlayCtx.fill();
  overlayCtx.stroke();

  // corner brackets for a native "viewfinder" feel
  const L = 22;
  overlayCtx.lineWidth = 5;
  overlayCtx.lineCap = 'round';
  pts.forEach(([x, y], i) => {
    const prev = pts[(i + 3) % 4], next = pts[(i + 1) % 4];
    const d1 = norm([prev[0] - x, prev[1] - y]);
    const d2 = norm([next[0] - x, next[1] - y]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x + d1[0] * L, y + d1[1] * L);
    overlayCtx.lineTo(x, y);
    overlayCtx.lineTo(x + d2[0] * L, y + d2[1] * L);
    overlayCtx.stroke();
  });
  overlayCtx.restore();
}
function norm(v) { const m = Math.hypot(v[0], v[1]) || 1; return [v[0] / m, v[1] / m]; }

function updateConfidence() {
  if (!lastQuad) {
    confidencePill.hidden = false;
    confidencePill.classList.remove('locked');
    confidenceText.textContent = 'Finding document…';
    stableCount = 0; autoArmed = true;
    return;
  }
  confidencePill.hidden = false;
  const locked = lastQuad.confidence >= LOCK_THRESHOLD;
  confidencePill.classList.toggle('locked', locked);
  confidenceText.textContent = locked ? 'Aligned — hold still' : 'Move closer / straighten';

  if (locked) {
    stableCount++;
    if (stableCount >= AUTO_CAPTURE_FRAMES && autoArmed && !capturing) {
      autoArmed = false;
      capturePage(true);
    }
  } else {
    stableCount = 0;
    autoArmed = true;
  }
}

/* ================================================================
   CAPTURE + PERSPECTIVE WARP
   ================================================================ */
shutterBtn.addEventListener('click', () => capturePage(false));

async function capturePage(auto) {
  if (capturing || !stream || !video.videoWidth) return;
  capturing = true;
  shutterBtn.classList.add('flash');
  if (navigator.vibrate) navigator.vibrate(auto ? [10, 40, 10] : 18);
  captureProcessing.hidden = false;
  await new Promise((r) => setTimeout(r, 90)); // let flash render

  const full = document.createElement('canvas');
  full.width = video.videoWidth;
  full.height = video.videoHeight;
  full.getContext('2d').drawImage(video, 0, 0);

  let resultCanvas = full;
  let usedWarp = false;
  if (cvReady && lastQuad && lastQuad.confidence > 0.28) {
    try {
      resultCanvas = warpToQuad(full, lastQuad.points);
      usedWarp = true;
    } catch (e) {
      resultCanvas = full;
    }
  }
  if (!usedWarp && !auto) showToast('No edges detected — captured full frame');

  pendingPage = { canvas: resultCanvas, mode: 'color', ...FILTER_PRESETS.color };
  captureProcessing.hidden = true;
  setTimeout(() => {
    shutterBtn.classList.remove('flash');
    capturing = false;
    stableCount = 0; autoArmed = true; lastQuad = null;
    openReview();
  }, 130);
}

function orderPoints(pts) {
  const sum = pts.map((p) => p[0] + p[1]);
  const diff = pts.map((p) => p[0] - p[1]);
  const tl = pts[sum.indexOf(Math.min(...sum))];
  const br = pts[sum.indexOf(Math.max(...sum))];
  const tr = pts[diff.indexOf(Math.max(...diff))];
  const bl = pts[diff.indexOf(Math.min(...diff))];
  return [tl, tr, br, bl];
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

function warpToQuad(sourceCanvas, points) {
  const ordered = orderPoints(points);
  const [tl, tr, br, bl] = ordered;
  const maxWidth = Math.max(dist(br, bl), dist(tr, tl));
  const maxHeight = Math.max(dist(tr, br), dist(tl, bl));

  const src = cv.imread(sourceCanvas);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1],
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, maxWidth - 1, 0, maxWidth - 1, maxHeight - 1, 0, maxHeight - 1,
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(maxWidth, maxHeight), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  const outCanvas = document.createElement('canvas');
  outCanvas.width = maxWidth; outCanvas.height = maxHeight;
  cv.imshow(outCanvas, dst);

  src.delete(); dst.delete(); M.delete(); srcTri.delete(); dstTri.delete();
  return outCanvas;
}

/* ================================================================
   REVIEW / ADJUST SCREEN
   ================================================================ */
function openReview() {
  currentMode = 'color';
  filterChips.forEach((c) => c.classList.toggle('active', c.dataset.filter === 'color'));
  sBright.value = pendingPage.bright;
  sContrast.value = pendingPage.contrast;
  sSat.value = pendingPage.sat;
  renderReviewCanvas();
  showScreen('review-screen');
}

function filterCSS() {
  const b = 100 + Number(sBright.value);
  const c = 100 + Number(sContrast.value);
  const s = 100 + Number(sSat.value);
  return `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
}

function renderReviewCanvas() {
  const src = pendingPage.canvas;
  const maxDim = 1100;
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  reviewCanvas.width = Math.round(src.width * scale);
  reviewCanvas.height = Math.round(src.height * scale);
  reviewCtx.save();
  reviewCtx.filter = filterCSS();
  reviewCtx.drawImage(src, 0, 0, reviewCanvas.width, reviewCanvas.height);
  reviewCtx.restore();
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderReviewCanvas(); renderQueued = false; });
}
[sBright, sContrast, sSat].forEach((s) => s.addEventListener('input', queueRender));

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    filterChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    currentMode = chip.dataset.filter;
    const preset = FILTER_PRESETS[currentMode];
    sBright.value = preset.bright;
    sContrast.value = preset.contrast;
    sSat.value = preset.sat;
    renderReviewCanvas();
  });
});

$('btn-retake').addEventListener('click', () => {
  pendingPage = null;
  showScreen('scan-screen');
});

$('btn-keep').addEventListener('click', () => {
  const out = document.createElement('canvas');
  out.width = pendingPage.canvas.width;
  out.height = pendingPage.canvas.height;
  const ctx = out.getContext('2d');
  ctx.filter = filterCSS();
  ctx.drawImage(pendingPage.canvas, 0, 0);

  const thumb = document.createElement('canvas');
  const tw = 300;
  const th = Math.round(out.height * (tw / out.width));
  thumb.width = tw; thumb.height = th;
  thumb.getContext('2d').drawImage(out, 0, 0, tw, th);

  pages.push({
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    full: out.toDataURL('image/jpeg', 0.92),
    thumb: thumb.toDataURL('image/jpeg', 0.8),
  });
  pendingPage = null;
  updatePageChrome();
  showToast(`Page ${pages.length} added`);
  showScreen('scan-screen');
});

/* ---------------- Scan-screen chrome (filmstrip + counters) --------------- */
function updatePageChrome() {
  pageCountEl.textContent = String(pages.length);
  btnDone.hidden = pages.length === 0;
  filmstrip.innerHTML = '';
  pages.forEach((p) => {
    const img = document.createElement('img');
    img.className = 'film-thumb';
    img.src = p.thumb;
    img.alt = '';
    filmstrip.appendChild(img);
  });
  filmstrip.scrollLeft = filmstrip.scrollWidth;
}

btnOpenPages.addEventListener('click', () => { if (pages.length) openPagesScreen(); });
btnDone.addEventListener('click', openPagesScreen);

/* ================================================================
   PAGES / BUILDER SCREEN
   ================================================================ */
function openPagesScreen() {
  if (!currentTitle) currentTitle = defaultTitle();
  docTitleInput.value = currentTitle;
  renderPageGrid();
  showScreen('pages-screen');
}
function defaultTitle() {
  const d = new Date();
  return 'Scan – ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
docTitleInput.addEventListener('input', () => { currentTitle = docTitleInput.value; });

function renderPageGrid() {
  docMeta.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  pageGrid.innerHTML = '';
  pages.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.innerHTML = `
      <img src="${p.thumb}" alt="Page ${i + 1}" />
      <span class="page-num">${i + 1}</span>
      <button class="page-remove" aria-label="Remove page ${i + 1}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <div class="page-move">
        <button data-dir="-1" aria-label="Move left" ${i === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button data-dir="1" aria-label="Move right" ${i === pages.length - 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>`;
    card.querySelector('.page-remove').addEventListener('click', () => {
      pages.splice(i, 1);
      updatePageChrome();
      renderPageGrid();
    });
    card.querySelectorAll('.page-move button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = Number(btn.dataset.dir);
        const j = i + dir;
        if (j < 0 || j >= pages.length) return;
        [pages[i], pages[j]] = [pages[j], pages[i]];
        renderPageGrid();
      });
    });
    pageGrid.appendChild(card);
  });
  const addCard = document.createElement('button');
  addCard.className = 'add-page-card';
  addCard.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg><span>Add page</span>`;
  addCard.addEventListener('click', () => showScreen('scan-screen'));
  pageGrid.appendChild(addCard);
}

$('btn-pages-back').addEventListener('click', () => showScreen('scan-screen'));
$('btn-clear-pages').addEventListener('click', () => {
  if (!pages.length || window.confirm('Discard all pages in this scan?')) {
    pages = []; currentDocId = null; currentTitle = '';
    updatePageChrome();
    showScreen('scan-screen');
  }
});

/* ================================================================
   STORAGE — IndexedDB
   ================================================================ */
const DB_NAME = 'scanly-db', DB_VERSION = 1, STORE = 'documents';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(doc) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(doc);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => reject(req.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

async function persistCurrentDoc() {
  if (!pages.length) return null;
  const id = currentDocId || ('doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const now = Date.now();
  const doc = {
    id,
    title: currentTitle || defaultTitle(),
    createdAt: currentDocId ? undefined : now,
    updatedAt: now,
    pages: pages.map((p) => ({ full: p.full, thumb: p.thumb })),
  };
  const existing = currentDocId ? await (await dbGetAll()).find((d) => d.id === id) : null;
  if (existing) doc.createdAt = existing.createdAt;
  if (doc.createdAt === undefined) doc.createdAt = now;
  await dbPut(doc);
  currentDocId = id;
  return doc;
}

$('btn-save-only').addEventListener('click', async () => {
  if (!pages.length) return showToast('Add at least one page first');
  await persistCurrentDoc();
  showToast('Saved to Library');
});

/* ================================================================
   PDF EXPORT + SHARE
   ================================================================ */
async function buildPdfBlob(pageList) {
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (let i = 0; i < pageList.length; i++) {
    const dims = await imageDims(pageList[i].full);
    const isLandscape = dims.w > dims.h;
    const mmW = (dims.w / 150) * 25.4; // assume ~150dpi capture
    const mmH = (dims.h / 150) * 25.4;
    if (!doc) {
      doc = new jsPDF({ orientation: isLandscape ? 'l' : 'p', unit: 'mm', format: [mmW, mmH] });
    } else {
      doc.addPage([mmW, mmH], isLandscape ? 'l' : 'p');
    }
    doc.addImage(pageList[i].full, 'JPEG', 0, 0, mmW, mmH);
  }
  return doc.output('blob');
}
function imageDims(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = dataUrl;
  });
}

async function exportAndShare(pageList, title) {
  showToast('Building PDF…', 4000);
  const blob = await buildPdfBlob(pageList);
  const fileName = `${(title || 'Scan').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'Scan'}.pdf`;
  const file = new File([blob], fileName, { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      showToast('Shared');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled share sheet
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast('PDF downloaded');
}

$('btn-export').addEventListener('click', async () => {
  if (!pages.length) return showToast('Add at least one page first');
  const btn = $('btn-export');
  const original = btn.textContent;
  btn.textContent = 'Preparing…';
  btn.disabled = true;
  try {
    await persistCurrentDoc();
    await exportAndShare(pages, currentTitle);
  } catch (e) {
    showToast('Could not build PDF');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

/* ================================================================
   LIBRARY
   ================================================================ */
async function renderLibrary() {
  const docs = await dbGetAll().catch(() => []);
  libraryEmpty.hidden = docs.length > 0;
  libraryList.innerHTML = '';
  docs.forEach((doc) => {
    const item = document.createElement('div');
    item.className = 'lib-item';
    const dateStr = new Date(doc.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    item.innerHTML = `
      <img class="lib-thumb" src="${(doc.pages[0] && doc.pages[0].thumb) || ''}" alt="" />
      <div class="lib-info">
        <p class="name">${escapeHtml(doc.title || 'Untitled scan')}</p>
        <p class="sub">${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'} · ${dateStr}</p>
      </div>
      <button class="lib-more" aria-label="Delete scan">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z"/></svg>
      </button>`;
    item.querySelector('.lib-info').addEventListener('click', () => openViewer(doc));
    item.querySelector('.lib-thumb').addEventListener('click', () => openViewer(doc));
    item.querySelector('.lib-more').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.confirm(`Delete "${doc.title}"? This can't be undone.`)) {
        await dbDelete(doc.id);
        renderLibrary();
        showToast('Deleted');
      }
    });
    libraryList.appendChild(item);
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openViewer(doc) {
  viewerTitle.textContent = doc.title || 'Scan';
  viewerPages.innerHTML = '';
  doc.pages.forEach((p) => {
    const img = document.createElement('img');
    img.src = p.full;
    img.alt = '';
    viewerPages.appendChild(img);
  });
  viewerOverlay.hidden = false;
  $('btn-viewer-share').onclick = () => exportAndShare(doc.pages, doc.title);
}
$('btn-viewer-close').addEventListener('click', () => { viewerOverlay.hidden = true; });

/* ================================================================
   INSTALL PROMPT (Add to Home Screen)
   ================================================================ */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem('scanly_install_dismissed')) {
    installBanner.hidden = false;
  }
});
$('btn-install').addEventListener('click', async () => {
  installBanner.hidden = true;
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => {});
  deferredInstallPrompt = null;
});
$('btn-install-dismiss').addEventListener('click', () => {
  installBanner.hidden = true;
  localStorage.setItem('scanly_install_dismissed', '1');
});
window.addEventListener('appinstalled', () => { installBanner.hidden = true; });

/* ================================================================
   SERVICE WORKER
   ================================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

/* ================================================================
   BOOT
   ================================================================ */
updatePageChrome();
showScreen('scan-screen');
