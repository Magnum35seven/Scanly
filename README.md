# Scanly — Document Scanner PWA

A installable, offline-capable Progressive Web App that scans documents with
the camera, auto-detects and corrects the page edges, lets you clean up the
image, and exports a PDF you can share or download — all processed on-device.

## Features implemented

- Live camera viewfinder with real-time document-edge detection (OpenCV.js:
  grayscale → blur → Canny → contour → 4-point polygon approximation)
- Green "locked" corner brackets + confidence pill when a page is well aligned
- **Auto-capture** after the page holds steady and aligned for ~0.8s, or tap
  the shutter to capture manually any time
- Perspective correction (4-point warp) to a flat, top-down crop
- Post-capture adjustments: Brightness / Contrast / Saturation sliders, plus
  Original / Enhance / B&W / Grayscale presets
- Multi-page capture with a filmstrip, reorderable/deletable page grid, and
  an editable document title
- PDF export (jsPDF) with `navigator.share()` (falls back to file download)
- Local library backed by IndexedDB — reopen, re-share, or delete past scans
- Installable (manifest + service worker, offline app-shell caching)
- Torch/flash toggle when the device supports it
- Light blue / orange / white theme with a glossy, native-feeling UI

## Running it

Camera access and service workers only work over **HTTPS or localhost** —
opening `index.html` directly via `file://` will not work.

**Quick local test:**
```bash
cd pwa-scanner
python3 -m http.server 8080
# then open http://localhost:8080 on your phone or desktop
```
On a phone, use your computer's LAN IP (e.g. `http://192.168.1.20:8080`) —
some browsers still require HTTPS for camera access on non-localhost hosts,
so for real device testing prefer deploying to a host with TLS (see below).

**Deploy (any static host works — no build step needed):**
- **GitHub Pages**: push this folder to a repo, enable Pages on the branch.
- **Netlify / Vercel**: drag-and-drop the folder, or connect the repo.
- **Firebase Hosting**: `firebase init hosting` then `firebase deploy`.

Once deployed over HTTPS, open it on a phone and use "Add to Home Screen"
(the app also prompts for this itself via the in-app install banner where
the browser supports `beforeinstallprompt`, e.g. Chrome/Edge on Android;
iOS Safari requires the manual Share → Add to Home Screen route).

## File structure

```
pwa-scanner/
├── index.html          # app shell, all screens' markup
├── styles.css           # design system + all screen styles
├── app.js               # camera, OpenCV detection, capture, storage, PDF
├── manifest.json         # PWA manifest
├── service-worker.js     # offline caching
└── icons/                # generated app icons (incl. maskable + Apple touch)
```

Everything is plain HTML/CSS/JS — no bundler, no npm install required.
OpenCV.js and jsPDF load from CDN (`docs.opencv.org`, `cdnjs.cloudflare.com`);
swap those `<script>` tags in `index.html` for self-hosted copies if you'd
rather not depend on those CDNs in production.

## Notes / things you may want to extend

- **OCR**: not included yet. Tesseract.js could be added as an optional pass
  over each page's canvas before it's added to `pages[]`.
- **Cloud sync**: local-only by design (IndexedDB). A backend or
  Drive/Dropbox integration would hook in alongside `persistCurrentDoc()`.
- **Auto-capture threshold**: tune `AUTO_CAPTURE_FRAMES` and `LOCK_THRESHOLD`
  in `app.js` if it fires too eagerly/slowly for your paper size or lighting.
- **PDF DPI assumption**: page sizing in `buildPdfBlob()` assumes ~150 DPI
  captures; adjust the `/150` divisor there if you change the capture
  resolution constraints in `startCamera()`.
