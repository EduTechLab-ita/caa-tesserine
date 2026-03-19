// ══════════════════════════════════════════════════════════════════
//  app.js — Orchestrazione principale: UI, generazione tessere, PDF
// ══════════════════════════════════════════════════════════════════

import {
  loadDictionary, saveDictionary, lookupWord, rememberWord,
  exportDictionary, importDictionaryFromFile,
} from './dictionary.js';

import { parseText }                                    from './parser.js';
import { searchPictograms, getPictogramUrl,
         fetchImageAsDataURL }                          from './arasaac.js';
import { getCandidates }                                from './lemmatizer.js';
import {
  loadCustomImages, saveCustomImages, addCustomImage, removeCustomImage,
  fileToDataURL, exportAll, importAll, CUSTOM_PREFIX,
} from './custom-images.js';

// ── Stato globale ──────────────────────────────────────────────
let dictionary     = loadDictionary();
/**
 * @type {Array<{
 *   word:string, id:number|null, imageUrl:string|null, dataURL:string|null,
 *   alts:Array, lemma:string|null  // lemma: forma base usata per la ricerca (null = stessa parola)
 * }>}
 */
let tiles          = [];
/** Parole che sono state lemmatizzate: {ORIGINALE → lemma} */
let lemmaLog       = {};
let customImages = loadCustomImages();
let currentOptions = { cols: 4, rows: 5, tileSize: 45 };

// ── Riferimenti DOM ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const openInfo  = () => $('info-overlay').classList.remove('hidden');
const closeInfo = () => $('info-overlay').classList.add('hidden');

const txtInput       = $('txt-input');
const selCols        = $('sel-cols');
const selRows        = $('sel-rows');
const selSize        = $('sel-size');
const chkStop        = $('chk-stopwords');
const btnGenerate    = $('btn-generate');
const statusDiv      = $('status');
const secPreview     = $('sec-preview');
const lblCount       = $('lbl-count');
const lblPages       = $('lbl-pages');
const pagesContainer = $('pages-container');
const btnPdf         = $('btn-pdf');
const btnExportDict  = $('btn-export-dict');
const fileImportDict = $('file-import-dict');
const modalOverlay   = $('modal-overlay');
const modalWord      = $('modal-word');
const modalAlts      = $('modal-alternatives');
const modalClose     = $('modal-close');

// ── Event listeners ────────────────────────────────────────────
btnGenerate.addEventListener('click',    handleGenerate);
btnPdf.addEventListener('click',         handleExportPDF);
btnExportDict.addEventListener('click',  () => exportAll(dictionary, customImages));
fileImportDict.addEventListener('change', handleImportDict);
modalClose.addEventListener('click',     closeModal);
modalOverlay.addEventListener('click',   e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown',     e => { if (e.key === 'Escape') { closeModal(); closeInfo(); } });

// Info panel
$('btn-info').addEventListener('click',   openInfo);
$('info-close').addEventListener('click', closeInfo);
$('info-overlay').addEventListener('click', e => { if (e.target === $('info-overlay')) closeInfo(); });

// ══════════════════════════════════════════════════════════════════
//  GENERA TESSERE
// ══════════════════════════════════════════════════════════════════
async function handleGenerate() {
  const text = txtInput.value.trim();
  if (!text) { showStatus('Inserisci prima un testo.', 'error'); return; }

  const words = parseText(text, chkStop.checked);
  if (words.length === 0) {
    showStatus('Nessuna parola trovata dopo il filtro. Prova a deselezionare "Rimuovi articoli…".', 'error');
    return;
  }

  btnGenerate.disabled = true;
  secPreview.classList.add('hidden');
  tiles    = [];
  lemmaLog = {};

  let ok = 0, fail = 0;

  // ── Per ogni parola: cerca nel dizionario o chiama ARASAAC ───
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    showStatus(`⏳ (${i + 1}/${words.length}) Cerco pittogramma per: ${word}…`);

    const savedId = lookupWord(dictionary, word);
    let id    = savedId;
    let alts  = [];
    let lemma = null;   // forma base usata se diversa da word

    if (!savedId) {
      try {
        // 1. Prova la parola originale
        alts = await searchPictograms(word);

        // 2. Se non trovata, prova i candidati lemmatizzati
        if (alts.length === 0) {
          const candidates = getCandidates(word);
          for (const candidate of candidates) {
            showStatus(`⏳ (${i + 1}/${words.length}) "${word}" non trovata — provo: ${candidate}…`);
            try {
              const candidateAlts = await searchPictograms(candidate);
              if (candidateAlts.length > 0) {
                alts  = candidateAlts;
                lemma = candidate;           // segna che abbiamo usato la forma base
                lemmaLog[word] = candidate;  // per il riepilogo finale
                break;
              }
            } catch { /* prossimo candidato */ }
          }
        }

        if (alts.length > 0) {
          id         = alts[0].id;
          dictionary = rememberWord(dictionary, word, id);
        }

        // ── Prova SEMPRE anche l'infinito per parole simili a verbi ──────
        // (anche se ARASAAC ha trovato qualcosa, potrebbe essere sbagliato)
        // I risultati dell'infinito vengono aggiunti come alternative nella modale.
        if (!lemma) {
          const verbCandidates = getCandidates(word);
          if (verbCandidates.length > 0) {
            try {
              const verbAlts = await searchPictograms(verbCandidates[0]);
              if (verbAlts.length > 0) {
                if (alts.length === 0) {
                  // Parola non trovata originale → usa l'infinito
                  alts  = verbAlts;
                  lemma = verbCandidates[0];
                  lemmaLog[word] = verbCandidates[0];
                  id         = alts[0].id;
                  dictionary = rememberWord(dictionary, word, id);
                } else {
                  // Parola trovata originale → aggiungi risultati infinito come alt extra
                  const existingIds = new Set(alts.map(a => a.id));
                  verbAlts.forEach(a => { if (!existingIds.has(a.id)) alts.push(a); });
                }
              }
            } catch { /* ignora */ }
          }
        }

      } catch (e) {
        console.warn('[app] Errore ARASAAC per', word, e.message);
      }
    } else {
      // Carica le alternative in background senza bloccare la UI
      searchPictograms(word)
        .then(a => {
          const t = tiles.find(t => t.word === word);
          if (t && a.length > 0) t.alts = a;
        })
        .catch(() => {});
    }

    id ? ok++ : fail++;

    // Controlla se c'è un'immagine personalizzata per questa parola
    const customDataURL = customImages[word];
    tiles.push({
      word,
      id,
      imageUrl: customDataURL || (id ? getPictogramUrl(id) : null),
      dataURL:  customDataURL || null,   // se custom, già pronta come dataURL
      alts,
      lemma,
    });
  }

  // ── Pre-scarica le immagini come dataURL per jsPDF ───────────
  showStatus(`⏳ Scarico immagini per la stampa PDF (${ok} pittogrammi)…`);

  await Promise.all(
    tiles
      .filter(t => t.imageUrl && !t.dataURL)   // skippa se già ha dataURL (immagini custom)
      .map(async t => { t.dataURL = await fetchImageAsDataURL(t.imageUrl); })
  );

  // ── Leggi opzioni ────────────────────────────────────────────
  currentOptions = {
    cols:     parseInt(selCols.value),
    rows:     parseInt(selRows.value),
    tileSize: parseInt(selSize.value),
  };

  renderPages();

  // ── Componi messaggio di riepilogo ────────────────────────────
  const lemmaEntries = Object.entries(lemmaLog);
  let msg = fail > 0
    ? `✅ Completato! ${ok} tessere OK, ${fail} parole senza pittogramma (❓).`
    : `✅ Completato! ${words.length} tessere generate.`;

  if (lemmaEntries.length > 0) {
    const list = lemmaEntries.map(([orig, base]) => `${orig} → ${base}`).join(', ');
    msg += `\n📝 Forma base usata per: ${list}`;
  }

  showStatus(msg, 'success');

  btnGenerate.disabled = false;
}

// ══════════════════════════════════════════════════════════════════
//  RENDER GRIGLIA (anteprima browser)
// ══════════════════════════════════════════════════════════════════
function renderPages() {
  pagesContainer.innerHTML = '';

  const { cols, rows } = currentOptions;
  const perPage  = cols * rows;
  const numPages = Math.ceil(tiles.length / perPage);

  lblCount.textContent = tiles.length;
  lblPages.textContent = numPages;
  secPreview.classList.remove('hidden');

  for (let p = 0; p < numPages; p++) {
    const slice  = tiles.slice(p * perPage, (p + 1) * perPage);
    const pageEl = buildPageElement(slice, cols, rows, p + 1, numPages);
    pagesContainer.appendChild(pageEl);
  }
}

function buildPageElement(pageTiles, cols, rows, pageNum, totalPages) {
  const page = document.createElement('div');
  page.className = 'a4-page';

  if (totalPages > 1) {
    const lbl = document.createElement('div');
    lbl.className   = 'page-label';
    lbl.textContent = `Pagina ${pageNum} di ${totalPages}`;
    page.appendChild(lbl);
  }

  const grid = document.createElement('div');
  grid.className = 'tile-grid';
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  pageTiles.forEach(tile => grid.appendChild(buildTileElement(tile)));
  page.appendChild(grid);
  return page;
}

function buildTileElement(tile) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.title     = `Clicca per cambiare pittogramma: ${tile.word}`;

  // Icona hover "cambia"
  const hint = document.createElement('span');
  hint.className   = 'swap-hint';
  hint.textContent = '↔';
  el.appendChild(hint);

  // Zona immagine
  const imgWrap = document.createElement('div');
  imgWrap.className = 'tile-img-wrap';

  const customDataURL = customImages[tile.word];
  if (customDataURL) {
    // Immagine personalizzata (priorità su ARASAAC)
    const img = document.createElement('img');
    img.src = customDataURL;
    img.alt = tile.word;
    imgWrap.appendChild(img);
    // Badge 📷 per immagini custom
    const badge = document.createElement('span');
    badge.className   = 'custom-badge';
    badge.title       = 'Immagine personalizzata';
    badge.textContent = '📷';
    el.appendChild(badge);
  } else if (tile.imageUrl) {
    const img = document.createElement('img');
    img.src     = tile.dataURL || tile.imageUrl;
    img.alt     = tile.word;
    img.loading = 'lazy';
    imgWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className   = 'no-image';
    ph.textContent = '❓';
    imgWrap.appendChild(ph);
  }

  // Zona parola
  const wordEl = document.createElement('div');
  wordEl.className   = 'tile-word';
  wordEl.textContent = tile.word;

  // Se è stata usata la forma base (lemma), mostra un piccolo badge
  if (tile.lemma) {
    const badge = document.createElement('span');
    badge.className = 'lemma-badge';
    badge.title     = `Trovato come: "${tile.lemma}"`;
    badge.textContent = '≈';
    el.appendChild(badge);
  }

  el.appendChild(imgWrap);
  el.appendChild(wordEl);

  // Click → modale alternative
  el.addEventListener('click', () => openModal(tile));
  return el;
}

// ══════════════════════════════════════════════════════════════════
//  MODAL SELEZIONE ALTERNATIVA
// ══════════════════════════════════════════════════════════════════
async function openModal(tile) {
  modalWord.textContent = tile.word;
  modalAlts.innerHTML   = '<p style="color:#64748b;font-size:.9rem">Carico alternative…</p>';
  modalOverlay.classList.remove('hidden');

  // Carica le alternative se non ancora disponibili
  if (!tile.alts || tile.alts.length === 0) {
    try {
      tile.alts = await searchPictograms(tile.word);
    } catch {
      tile.alts = [];
    }
  }

  if (tile.alts.length === 0) {
    modalAlts.innerHTML =
      '<p style="color:#ef4444;font-size:.9rem">Nessun pittogramma trovato per questa parola.</p>';
    return;
  }

  modalAlts.innerHTML = '';

  // ── Sezione immagine personalizzata ──────────────────────────
  const customSection = document.createElement('div');
  customSection.className = 'custom-upload-section';
  const customDataURL = customImages[tile.word];
  if (customDataURL) {
    const currentCustom = document.createElement('div');
    currentCustom.className = 'current-custom';
    currentCustom.innerHTML = `
      <img src="${customDataURL}" alt="Immagine personalizzata" style="width:80px;height:80px;object-fit:contain;border:2px solid #22c55e;border-radius:8px;">
      <span>Immagine personalizzata attiva</span>
      <button class="btn secondary small" id="btn-remove-custom">✕ Rimuovi</button>
    `;
    currentCustom.querySelector('#btn-remove-custom').addEventListener('click', () => {
      customImages = removeCustomImage(customImages, tile.word);
      renderPages();
      openModal(tile);
    });
    customSection.appendChild(currentCustom);
  }
  const uploadLabel = document.createElement('label');
  uploadLabel.className = 'custom-upload-label';
  uploadLabel.innerHTML = `
    📁 Carica immagine personalizzata (PNG, JPG, GIF...)
    <input type="file" accept="image/*" style="display:none" id="inp-custom-img">
  `;
  uploadLabel.querySelector('#inp-custom-img').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataURL = await fileToDataURL(file);
      customImages  = addCustomImage(customImages, tile.word, dataURL);
      tile.dataURL  = dataURL;
      tile.imageUrl = dataURL;
      renderPages();
      closeModal();
    } catch (err) {
      alert('Errore caricamento immagine: ' + err.message);
    }
  });
  customSection.appendChild(uploadLabel);
  const divider = document.createElement('div');
  divider.className = 'modal-divider';
  divider.innerHTML = '<span>oppure scegli un pittogramma ARASAAC</span>';
  customSection.appendChild(divider);
  modalAlts.appendChild(customSection);

  tile.alts.forEach(alt => {
    const el = document.createElement('div');
    el.className = 'alt-tile' + (alt.id === tile.id ? ' selected' : '');

    const img = document.createElement('img');
    img.src     = alt.imageUrl;
    img.alt     = alt.keyword;
    img.loading = 'lazy';

    const lbl = document.createElement('span');
    lbl.textContent = `#${alt.id}`;

    el.appendChild(img);
    el.appendChild(lbl);

    el.addEventListener('click', async () => {
      // Aggiorna tessera e dizionario
      tile.id       = alt.id;
      tile.imageUrl = alt.imageUrl;
      tile.dataURL  = await fetchImageAsDataURL(alt.imageUrl);
      dictionary    = rememberWord(dictionary, tile.word, alt.id);
      renderPages();
      closeModal();
    });

    modalAlts.appendChild(el);
  });
}

function closeModal() {
  modalOverlay.classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════════
//  IMPORT DIZIONARIO
// ══════════════════════════════════════════════════════════════════
async function handleImportDict(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const { dict, imgs } = await importAll(file);
    dictionary   = { ...dictionary, ...dict };
    customImages = { ...customImages, ...imgs };
    saveDictionary(dictionary);
    saveCustomImages(customImages);
    const nd = Object.keys(dict).length;
    const ni = Object.keys(imgs).length;
    const msg = ni > 0
      ? `✅ Importati: ${nd} pittogrammi + ${ni} immagini personalizzate.`
      : `✅ Dizionario importato: ${nd} parole.`;
    showStatus(msg, 'success');
  } catch (err) {
    showStatus(`❌ Errore importazione: ${err.message}`, 'error');
  }

  e.target.value = '';
}

// ══════════════════════════════════════════════════════════════════
//  ESPORTAZIONE PDF  (jsPDF, nessun backend)
// ══════════════════════════════════════════════════════════════════
async function handleExportPDF() {
  if (tiles.length === 0) return;

  btnPdf.disabled = true;
  showStatus('⏳ Generazione PDF in corso…');

  const { cols, rows } = currentOptions;
  const { jsPDF }      = window.jspdf;

  // ── Misure A4 in mm ──────────────────────────────────────────
  const PAGE_W  = 210;   // ⚙️ larghezza A4 (non modificare per A4 standard)
  const PAGE_H  = 297;   // ⚙️ altezza A4
  const MARGIN  = 8;     // ⚙️ margine esterno in mm (aumenta per più spazio)
  const GAP     = 2;     // ⚙️ spazio tra tessere in mm
  const TEXT_H  = 6;     // ⚙️ altezza zona testo sotto l'immagine in mm
  const IMG_PAD = 1;     // ⚙️ padding interno immagine in mm

  const availW  = PAGE_W - 2 * MARGIN;
  const availH  = PAGE_H - 2 * MARGIN;

  // Dimensione cella quadrata che si adatta a colonne e righe
  const cellW = (availW - (cols - 1) * GAP) / cols;
  const cellH = (availH - (rows - 1) * GAP) / rows;
  const cell  = Math.min(cellW, cellH);

  const imgSize = cell - TEXT_H - IMG_PAD * 2;

  // ── Font PDF ──────────────────────────────────────────────────
  // ⚙️  Cambia FONT_SIZE per parole più grandi o più piccole
  const FONT_SIZE = 9;

  const perPage   = cols * rows;
  const pageCount = Math.ceil(tiles.length / perPage);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(FONT_SIZE);

  // ── Genera ogni pagina ────────────────────────────────────────
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    if (pageIdx > 0) doc.addPage();

    const pageTiles = tiles.slice(pageIdx * perPage, (pageIdx + 1) * perPage);

    pageTiles.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x   = MARGIN + col * (cell + GAP);
      const y   = MARGIN + row * (cell + GAP);

      // ── Bordo tessera ─────────────────────────────────────────
      // ⚙️  Cambia colore bordo con setDrawColor(R,G,B)
      doc.setDrawColor(180, 180, 180);
      doc.setLineWidth(0.3);
      doc.roundedRect(x, y, cell, cell, 1, 1, 'S');

      // ── Immagine ──────────────────────────────────────────────
      if (tile.dataURL && tile.dataURL.startsWith('data:')) {
        try {
          doc.addImage(
            tile.dataURL, 'PNG',
            x + IMG_PAD, y + IMG_PAD,
            imgSize, imgSize,
            undefined, 'FAST'
          );
        } catch (e) {
          console.warn('[PDF] addImage fallito per', tile.word, e.message);
          drawNoImage(doc, x, y, cell, imgSize, IMG_PAD);
        }
      } else {
        drawNoImage(doc, x, y, cell, imgSize, IMG_PAD);
      }

      // ── Linea separatrice immagine / testo ────────────────────
      const sepY = y + IMG_PAD + imgSize + 0.5;
      doc.setDrawColor(220, 220, 220);
      doc.line(x + 1, sepY, x + cell - 1, sepY);

      // ── Testo parola ──────────────────────────────────────────
      // ⚙️  Cambia colore testo: setTextColor(R,G,B)
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(FONT_SIZE);
      doc.text(
        tile.word,
        x + cell / 2,
        y + cell - 1.5,
        { align: 'center', maxWidth: cell - 2 }
      );
    });
  }

  // ── Nota di licenza ARASAAC (obbligatoria per CC BY-NC-SA) ───
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(4.5);
    doc.setTextColor(170, 170, 170);
    doc.text(
      'Pittogrammi ARASAAC © Gobierno de Aragón – Licenza CC BY-NC-SA 4.0 – arasaac.org',
      PAGE_W / 2, PAGE_H - 2.5,
      { align: 'center' }
    );
  }

  doc.save('tesserine-caa.pdf');
  showStatus('✅ PDF scaricato!', 'success');
  btnPdf.disabled = false;
}

/** Disegna un segnaposto testuale quando l'immagine non è disponibile. */
function drawNoImage(doc, x, y, cell, imgSize, pad) {
  doc.setFontSize(16);
  doc.setTextColor(210, 210, 210);
  doc.text('?', x + cell / 2, y + pad + imgSize / 2 + 3, { align: 'center' });
  doc.setTextColor(0, 0, 0);
}

// ── Utility ────────────────────────────────────────────────────
function showStatus(msg, type = '') {
  statusDiv.textContent = msg;
  statusDiv.className   = `status ${type}`;
  statusDiv.classList.remove('hidden');
}
