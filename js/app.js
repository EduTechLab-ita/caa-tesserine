// ══════════════════════════════════════════════════════════════════
//  app.js — Orchestrazione principale: UI, generazione tessere, PDF
// ══════════════════════════════════════════════════════════════════

import {
  loadDictionary, saveDictionary, saveDictionaryForStudent, lookupWord, rememberWord,
  exportDictionary, importDictionaryFromFile,
  getStudentsList, getCurrentStudent, setCurrentStudent, addStudent, removeStudent,
  getLegacyDictionaryCount, loadDictionaryForStudent,
  loadLabelsForStudent, saveLabelsForStudent,
} from './dictionary.js';

import {
  loadDriveConfig, isDriveConnected, connectToDrive, disconnectDrive,
  saveStudentToDrive, loadStudentFromDrive, listStudentsOnDrive,
  connectSharedFile, isSharedStudent, getStudentShareCode, getDriveFolderUrl,
  openDriveModal, closeDriveModal, showDrivePanel, updateDriveButton, showDriveToast,
  makeShareReady,
} from './drive.js';

import { parseText, parseTextToPhrases }                from './parser.js';
import { searchPictograms, getPictogramUrl,
         fetchImageAsDataURL }                          from './arasaac.js';
import { getCandidates }                                from './lemmatizer.js';
import {
  addCustomImage, removeCustomImage,
  fileToDataURL, exportAll, importAll, CUSTOM_PREFIX,
} from './custom-images.js';

// ── Stato globale ──────────────────────────────────────────────
let dictionary     = loadDictionary();
let _driveSaveTimer = null; // debounce per sync Drive
/**
 * @type {Array<{
 *   word:string, id:number|null, imageUrl:string|null, dataURL:string|null,
 *   alts:Array, lemma:string|null  // lemma: forma base usata per la ricerca (null = stessa parola)
 * }>}
 */
let tiles          = [];
/** Parole che sono state lemmatizzate: {ORIGINALE → lemma} */
let lemmaLog       = {};
let customImages  = loadCustomImagesForStudent(getCurrentStudent());
let customLabels  = loadLabelsForStudent(getCurrentStudent());
let currentOptions = { cols: 4, rows: 5, tileSize: 45, orientation: 'portrait' };

// ── Riferimenti DOM ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const openInfo  = () => $('info-overlay').classList.remove('hidden');
const closeInfo = () => $('info-overlay').classList.add('hidden');

const txtInput       = $('txt-input');
const selCols        = $('sel-cols');
const selRows        = $('sel-rows');
const selSize        = $('sel-size');
const selOrient      = $('sel-orient');
const chkStop        = $('chk-stopwords');
const btnGenerate    = $('btn-generate');
const btnPrintVocab  = $('btn-print-vocab');
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
btnPrintVocab.addEventListener('click',  handlePrintVocab);
btnPdf.addEventListener('click',         handleExportPDF);
btnExportDict.addEventListener('click',  () => exportAll(dictionary, customImages, customLabels));
fileImportDict.addEventListener('change', handleImportDict);
modalClose.addEventListener('click',     closeModal);
modalOverlay.addEventListener('click',   e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown',     e => { if (e.key === 'Escape') { closeModal(); closeInfo(); } });

// Info panel
$('btn-info').addEventListener('click',   openInfo);
$('info-close').addEventListener('click', closeInfo);
$('info-close-bottom').addEventListener('click', closeInfo);
$('info-overlay').addEventListener('click', e => { if (e.target === $('info-overlay')) closeInfo(); });

// ── Inizializza selettore alunno ────────────────────────────────
initStudentSelector();

// ── Inizializza Drive ───────────────────────────────────────────
loadDriveConfig(() => {
  // Drive connesso al caricamento pagina (token già valido o silent auth)
  syncStudentListFromDrive();
});

// Drive connesso dopo login manuale (click sul pulsante) — es. Chromebook pulito
document.addEventListener('caa-drive-connected', () => {
  syncStudentListFromDrive();
});

// ── Link magico: ?condividi=CODICE ──────────────────────────────
// Salva il codice in sessionStorage SUBITO (sopravvive al reload OAuth)
const PENDING_SHARE_KEY = 'caa_pending_share_v1';
{
  const fromUrl = new URLSearchParams(location.search).get('condividi');
  if (fromUrl) {
    sessionStorage.setItem(PENDING_SHARE_KEY, fromUrl);
    // Pulisce l'URL senza ricaricare la pagina
    history.replaceState(null, '', location.pathname);
  }
}

function _fillPendingShareInputs(code) {
  const pre  = document.getElementById('shared-code-input-pre');
  const post = document.getElementById('shared-code-input-post');
  if (pre)  pre.value = code;
  if (post) post.value = code;
  // Mostra il banner nel modal
  const banner = document.getElementById('drive-incoming-banner');
  if (banner) {
    banner.style.display = 'block';
    const codeEl = banner.querySelector('#drive-incoming-code');
    if (codeEl) codeEl.textContent = code;
  }
}

function applyPendingShare() {
  const code = sessionStorage.getItem(PENDING_SHARE_KEY);
  if (!code) return;
  _fillPendingShareInputs(code);
  _refreshDriveSharePanel();
  openDriveModal();
  showDriveToast('📥 Codice vocabolario ricevuto! Collega il Drive e clicca Carica.');
}

// Applica il codice dopo che Drive e DOM sono pronti
setTimeout(applyPendingShare, 800);

// Esponi funzioni Drive all'HTML (onclick nei pulsanti del modal)
window._openDriveModal  = () => { _refreshDriveSharePanel(); openDriveModal(); };
window._openDriveFolder = () => {
  const url = getDriveFolderUrl();
  if (url) window.open(url, '_blank');
};
window._closeDriveModal = closeDriveModal;
window._connectDrive    = connectToDrive;
window._disconnectDrive = () => disconnectDrive(() => { updateStudentSelector(); });
window._copyShareCode   = async () => {
  const code        = document.getElementById('drive-share-code')?.value;
  const studentName = getCurrentStudent();
  if (!code || code.startsWith('—') || code.startsWith('⏳')) return;

  // Rende il file pubblicamente leggibile prima di condividere il link
  await makeShareReady(code);

  const shareUrl = `https://edutechlab.it/caa-tesserine/?condividi=${code}`;
  const msg =
`📚 Ti condivido il vocabolario CAA di "${studentName}" tramite CAArtella.

Ora APRI L'APP CAArtella — copia SOLO questo link:


👉  ${shareUrl}


e incollalo nella barra degli indirizzi del browser
(la barra in cima al browser dove si scrivono i siti web, non nel motore di ricerca), poi premi Invio.

Una volta aperta la pagina, si aprirà automaticamente il pannello Drive con il codice già precompilato. Poi:

1. Clicca "Collega a Google Drive" e accedi con il tuo account Google scolastico

   ⚠️ AVVISO NORMALE — La prima volta Google mostra la schermata "Questa app non è verificata".
   Non è un virus. È normale per le app scolastiche interne.
   Come procedere: clicca "Avanzate" (in basso a sinistra) → poi "Vai su edutechlab.it (non sicuro)" → autorizza.
   Questo avviso compare SOLO la prima volta. Dopo, il collegamento è automatico.

2. Nel box giallo/blu vedrai il codice già pronto — clicca "Carica"
3. Il vocabolario di "${studentName}" apparirà nel selettore alunno!

Da quel momento le nostre modifiche si sincronizzano automaticamente 🎉

---
⚠️ Se il link non si apre correttamente, puoi usare il codice manuale:
Apri https://edutechlab.it/caa-tesserine/, clicca "Drive" in alto a destra, collega il tuo account Google, poi incolla questo codice nel box blu "Hai ricevuto un vocabolario?":


👉  ${code}


e clicca Carica.`;

  navigator.clipboard.writeText(msg)
    .then(() => alert(
      '✅ Messaggio copiato!\n\n' +
      'Ora incollalo nello spazio del messaggio della condivisione Drive\n' +
      '(quello che compare quando aggiungi il/la collega come editor).\n\n' +
      'Il messaggio contiene già il codice e tutte le istruzioni.'
    ));
};
// Copia solo il codice (file ID)
window._copyCode = () => {
  const code = document.getElementById('drive-share-code')?.value;
  if (!code || code.startsWith('—') || code.startsWith('⏳')) return;
  navigator.clipboard.writeText(code)
    .then(() => alert('✅ Codice copiato!\n\nIncollalo nel box blu "Hai ricevuto un vocabolario?" nell\'app CAArtella.'));
};
// Collegamento vocabolario condiviso — dalla schermata di login (non ancora connessa)
window._connectShared = async () => {
  const input = document.getElementById('shared-code-input-pre');
  const code  = input ? input.value.trim() : '';
  if (!code) { alert('Inserisci il codice ricevuto dal/dalla collega.'); return; }
  try {
    const data = await connectSharedFile(code);
    addStudent(data.studentName);
    // Salva i dati ricevuti in locale
    saveDictionaryForStudent(data.studentName, data.dict);
    saveCustomImagesForStudent(data.studentName, data.custom || {});
    saveLabelsForStudent(data.studentName, data.labels || {});
    updateStudentSelector(data.studentName);
    setCurrentStudent(data.studentName);
    dictionary   = data.dict;
    customImages = data.custom || {};
    customLabels = data.labels || {};
    closeDriveModal();
    showStatus(`✅ Vocabolario di "${data.studentName}" caricato e sincronizzato!`, 'success');
  } catch(err) {
    alert('❌ ' + err.message);
  }
};
// Collegamento vocabolario condiviso — dalla schermata già connessa
window._connectSharedPost = async () => {
  const input = document.getElementById('shared-code-input-post');
  const code  = input ? input.value.trim() : '';
  if (!code) { alert('Inserisci il codice ricevuto dal/dalla collega.'); return; }
  try {
    const data = await connectSharedFile(code);
    addStudent(data.studentName);
    saveDictionaryForStudent(data.studentName, data.dict);
    saveCustomImagesForStudent(data.studentName, data.custom || {});
    saveLabelsForStudent(data.studentName, data.labels || {});
    updateStudentSelector(data.studentName);
    setCurrentStudent(data.studentName);
    dictionary   = data.dict;
    customImages = data.custom || {};
    customLabels = data.labels || {};
    if (input) input.value = '';
    sessionStorage.removeItem(PENDING_SHARE_KEY); // codice usato, pulizia
    const banner = document.getElementById('drive-incoming-banner');
    if (banner) banner.style.display = 'none';
    _refreshDriveSharePanel();
    showStatus(`✅ Vocabolario di "${data.studentName}" caricato e attivo!`, 'success');
  } catch(err) {
    alert('❌ ' + err.message);
  }
};

// ══════════════════════════════════════════════════════════════════
//  GENERA TESSERE
// ══════════════════════════════════════════════════════════════════
async function handleGenerate() {
  const text = txtInput.value.trim();
  if (!text) { showStatus('Inserisci prima un testo.', 'error'); return; }

  const phrases = parseTextToPhrases(text, chkStop.checked);
  if (phrases.length === 0) {
    showStatus('Nessuna parola trovata dopo il filtro. Prova a deselezionare "Rimuovi articoli…".', 'error');
    return;
  }

  btnGenerate.disabled = true;
  secPreview.classList.add('hidden');
  tiles    = [];
  lemmaLog = {};

  let ok = 0, fail = 0;
  const allWords  = phrases.flat();
  let   globalIdx = 0;

  // ── Per ogni frase, per ogni parola: cerca nel dizionario o chiama ARASAAC ───
  for (let pi = 0; pi < phrases.length; pi++) {
    const phrase = phrases[pi];
    for (let wi = 0; wi < phrase.length; wi++) {
      const word          = phrase[wi];
      const isLastOfPhrase = wi === phrase.length - 1;
      showStatus(`⏳ (${globalIdx + 1}/${allWords.length}) Cerco pittogramma per: ${word}…`);

      const savedId = lookupWord(dictionary, word);
      let id    = savedId;
      let alts  = [];
      let lemma = null;

      if (!savedId) {
        try {
          // 1. Prova PRIMA i candidati all'infinito (verbi coniugati → infinito)
          const candidates = getCandidates(word);
          for (const candidate of candidates) {
            showStatus(`⏳ (${globalIdx + 1}/${allWords.length}) "${word}" → provo: ${candidate}…`);
            try {
              const candidateAlts = await searchPictograms(candidate);
              if (candidateAlts.length > 0) {
                alts  = candidateAlts;
                lemma = candidate;
                lemmaLog[word] = candidate;
                break;
              }
            } catch { /* prossimo candidato */ }
          }

          // 2. Se nessun infinito trovato, prova la parola originale
          if (alts.length === 0) {
            alts = await searchPictograms(word);
          }

          if (alts.length > 0) {
            id         = alts[0].id;
            dictionary = rememberWord(dictionary, word, id);
            scheduleDriveSync();
          }

        } catch (e) {
          console.warn('[app] Errore ARASAAC per', word, e.message);
        }
      } else {
        searchPictograms(word)
          .then(a => {
            const t = tiles.find(t => t.word === word);
            if (t && a.length > 0) t.alts = a;
          })
          .catch(() => {});
      }

      id ? ok++ : fail++;

      const customDataURL = customImages[word];
      tiles.push({
        word,
        id,
        imageUrl:  customDataURL || (id ? getPictogramUrl(id) : null),
        dataURL:   customDataURL || null,
        alts,
        lemma,
        phraseEnd: isLastOfPhrase,   // true = ultima parola di questa frase
      });
      globalIdx++;
    }
  }

  // ── Pre-scarica le immagini come dataURL per jsPDF ───────────
  showStatus(`⏳ Scarico immagini per la stampa PDF (${ok} pittogrammi)…`);

  await Promise.all(
    tiles
      .filter(t => t.imageUrl && !t.dataURL)
      .map(async t => { t.dataURL = await fetchImageAsDataURL(t.imageUrl); })
  );

  // ── Leggi opzioni ────────────────────────────────────────────
  currentOptions = {
    cols:        parseInt(selCols.value),
    rows:        parseInt(selRows.value),
    tileSize:    parseInt(selSize.value),
    orientation: selOrient.value,
  };

  renderPages();

  // ── Componi messaggio di riepilogo ────────────────────────────
  const lemmaEntries = Object.entries(lemmaLog);
  let msg = fail > 0
    ? `✅ Completato! ${ok} tessere OK, ${fail} parole senza pittogramma (❓).`
    : `✅ Completato! ${allWords.length} tessere generate in ${phrases.length} fras${phrases.length === 1 ? 'e' : 'i'}.`;

  if (lemmaEntries.length > 0) {
    const list = lemmaEntries.map(([orig, base]) => `${orig} → ${base}`).join(', ');
    msg += `\n📝 Forma base usata per: ${list}`;
  }

  showStatus(msg, 'success');
  btnGenerate.disabled = false;
}

// ══════════════════════════════════════════════════════════════════
//  STAMPA VOCABOLARIO COMPLETO
// ══════════════════════════════════════════════════════════════════
function handlePrintVocab() {
  const allWords = new Set([
    ...Object.keys(dictionary),
    ...Object.keys(customImages),
  ]);

  if (allWords.size === 0) {
    showStatus('Il vocabolario è vuoto. Prima genera alcune tessere.', 'error');
    return;
  }

  currentOptions = {
    cols:        parseInt(selCols.value),
    rows:        parseInt(selRows.value),
    tileSize:    parseInt(selSize.value),
    orientation: selOrient.value,
  };

  lemmaLog = {};
  tiles = [...allWords].sort().map(word => {
    const id           = dictionary[word] ?? null;
    const customDataURL = customImages[word] ?? null;
    return {
      word,
      id,
      imageUrl:  customDataURL || (id ? getPictogramUrl(id) : null),
      dataURL:   customDataURL || null,
      alts:      [],
      lemma:     null,
      phraseEnd: false,
    };
  });

  renderPages();
  showStatus(`📖 Vocabolario completo: ${tiles.length} tessere. Clicca "Scarica PDF" per stamparlo.`, 'success');
}

// ══════════════════════════════════════════════════════════════════
//  LAYOUT FRASE-AWARE
//  Produce array di pagine; ogni pagina è array di righe;
//  ogni riga è array di (tile | null).  null = cella vuota (fine frase).
// ══════════════════════════════════════════════════════════════════
function computeLayout(tilesArr, cols, rows) {
  const pages = [];
  let page = [];
  let row  = [];

  for (const tile of tilesArr) {
    row.push(tile);
    const rowFull   = row.length >= cols;
    const breakHere = tile.phraseEnd;

    if (rowFull || breakHere) {
      while (row.length < cols) row.push(null);   // padding celle vuote
      page.push(row);
      row = [];
      if (page.length >= rows) {
        pages.push(page);
        page = [];
      }
    }
  }

  // Flush riga/pagina parziale rimasta
  if (row.length > 0) {
    while (row.length < cols) row.push(null);
    page.push(row);
  }
  if (page.length > 0) pages.push(page);

  return pages;
}

// ══════════════════════════════════════════════════════════════════
//  RENDER GRIGLIA (anteprima browser)
// ══════════════════════════════════════════════════════════════════
function renderPages() {
  pagesContainer.innerHTML = '';

  const { cols, rows } = currentOptions;
  const layout   = computeLayout(tiles, cols, rows);
  const numPages = layout.length;

  lblCount.textContent = tiles.length;
  lblPages.textContent = numPages;
  secPreview.classList.remove('hidden');

  layout.forEach((pageRows, pi) => {
    const pageEl = buildPageElement(pageRows, cols, pi + 1, numPages);
    pagesContainer.appendChild(pageEl);
  });
}

function buildPageElement(pageRows, cols, pageNum, totalPages) {
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

  pageRows.forEach(row => {
    row.forEach(tile => {
      if (tile) {
        grid.appendChild(buildTileElement(tile));
      } else {
        const empty = document.createElement('div');
        empty.className = 'tile tile--empty';
        grid.appendChild(empty);
      }
    });
  });

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

  // Zona parola (usa etichetta personalizzata se presente)
  const wordEl = document.createElement('div');
  wordEl.className   = 'tile-word';
  const customLabel  = customLabels[tile.word.toUpperCase()];
  wordEl.textContent = customLabel || tile.word;

  // Badge ✏️ se l'etichetta è stata personalizzata
  if (customLabel) {
    const lblBadge = document.createElement('span');
    lblBadge.className   = 'label-badge';
    lblBadge.title       = `Etichetta personalizzata (parola cercata: "${tile.word}")`;
    lblBadge.textContent = '✏️';
    el.appendChild(lblBadge);
  }

  // Badge "≈" se è stata usata la forma base (lemma)
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

  // ── Carica alternative ARASAAC (con fallback lemmatizzazione) ─
  if (!tile.alts || tile.alts.length === 0) {
    try {
      tile.alts = await searchPictograms(tile.word);
    } catch {
      tile.alts = [];
    }

    // Se ARASAAC non trova nulla, prova la forma base (es. mangia → mangiare)
    if (tile.alts.length === 0) {
      const candidates = getCandidates(tile.word);
      for (const candidate of candidates) {
        try {
          const found = await searchPictograms(candidate);
          if (found.length > 0) {
            tile.alts = found;
            tile.lemma = candidate;
            break;
          }
        } catch { /* prossimo */ }
      }
    }
  }

  // ── Render modal ──────────────────────────────────────────────
  modalAlts.innerHTML = '';

  // ── Sezione modifica etichetta (SEMPRE visibile) ──────────────
  const labelSection = document.createElement('div');
  labelSection.className = 'label-edit-section';

  const labelTitle = document.createElement('p');
  labelTitle.className = 'label-edit-title';
  labelTitle.textContent = '✏️ Testo sulla tessera';
  labelSection.appendChild(labelTitle);

  const currentLabel = customLabels[tile.word.toUpperCase()] || '';

  const labelRow = document.createElement('div');
  labelRow.className = 'label-edit-row';

  const labelInput = document.createElement('input');
  labelInput.type        = 'text';
  labelInput.className   = 'label-edit-input';
  labelInput.placeholder = tile.word;
  labelInput.value       = currentLabel;
  labelInput.title       = 'Testo mostrato sulla tessera al posto della parola originale';

  const labelSaveBtn = document.createElement('button');
  labelSaveBtn.className   = 'btn secondary small';
  labelSaveBtn.textContent = '✓ Salva';
  labelSaveBtn.addEventListener('click', () => {
    const newLabel = labelInput.value.trim();
    const wordKey  = tile.word.toUpperCase();
    if (newLabel && newLabel !== tile.word) {
      customLabels[wordKey] = newLabel;
    } else {
      delete customLabels[wordKey];
    }
    saveLabels(customLabels);
    scheduleDriveSync();
    renderPages();
    showStatus(`✏️ Etichetta di "${tile.word}" aggiornata.`, 'success');
    closeModal();
  });

  const labelResetBtn = document.createElement('button');
  labelResetBtn.className   = 'btn small';
  labelResetBtn.textContent = '↩';
  labelResetBtn.title       = 'Ripristina testo originale';
  labelResetBtn.disabled    = !currentLabel;
  labelResetBtn.addEventListener('click', () => {
    delete customLabels[tile.word.toUpperCase()];
    saveLabels(customLabels);
    scheduleDriveSync();
    renderPages();
    closeModal();
  });

  labelRow.appendChild(labelInput);
  labelRow.appendChild(labelSaveBtn);
  labelRow.appendChild(labelResetBtn);
  labelSection.appendChild(labelRow);
  modalAlts.appendChild(labelSection);

  // ── Sezione immagine personalizzata (SEMPRE visibile) ────────
  const customSection = document.createElement('div');
  customSection.className = 'custom-upload-section';

  const customDataURL = customImages[tile.word];
  if (customDataURL) {
    const currentCustom = document.createElement('div');
    currentCustom.className = 'current-custom';
    currentCustom.innerHTML = `
      <img src="${customDataURL}" alt="Immagine personalizzata"
           style="width:80px;height:80px;object-fit:contain;border:2px solid #22c55e;border-radius:8px;">
      <span>Immagine personalizzata attiva</span>
      <button class="btn secondary small" id="btn-remove-custom">↩ Ripristina immagine ARASAAC</button>
    `;
    currentCustom.querySelector('#btn-remove-custom').addEventListener('click', () => {
      customImages = removeCustomImage(customImages, tile.word);
      saveCustomImages(customImages);
      scheduleDriveSync();
      renderPages();
      openModal(tile);
    });
    customSection.appendChild(currentCustom);
  }

  const uploadLabel = document.createElement('label');
  uploadLabel.className = 'custom-upload-label';
  uploadLabel.innerHTML = `
    📁 Carica immagine personalizzata (PNG, JPG, GIF…)
    <input type="file" accept="image/*" style="display:none">
  `;
  uploadLabel.querySelector('input[type=file]').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataURL = await fileToDataURL(file);
      customImages  = addCustomImage(customImages, tile.word, dataURL);
      saveCustomImages(customImages);
      tile.dataURL  = dataURL;
      tile.imageUrl = dataURL;
      scheduleDriveSync();
      renderPages();
      closeModal();
    } catch (err) {
      alert('Errore caricamento immagine: ' + err.message);
    }
  });
  customSection.appendChild(uploadLabel);

  // ── Rimuovi parola dal dizionario ─────────────────────────────
  const forgetBtn = document.createElement('button');
  forgetBtn.className   = 'btn danger small';
  forgetBtn.style.marginTop = '0.5rem';
  forgetBtn.textContent = '🗑️ Rimuovi dal dizionario';
  forgetBtn.title       = 'Elimina questa parola dal vocabolario salvato. Operazione irreversibile.';
  forgetBtn.addEventListener('click', () => {
    if (!confirm(`Rimuovere "${tile.word}" dal dizionario?\n\nQuesta operazione è irreversibile: la tessera scomparirà dal vocabolario salvato.`)) return;
    const wordKey = tile.word.toUpperCase();
    const updated = { ...dictionary };
    delete updated[wordKey];
    dictionary = updated;
    saveDictionary(dictionary);
    if (customImages[wordKey]) {
      customImages = removeCustomImage(customImages, tile.word);
      saveCustomImages(customImages);
    }
    scheduleDriveSync();
    tiles = tiles.filter(t => t.word !== tile.word);
    closeModal();
    renderPages();
    showStatus(`🗑️ "${tile.word}" rimosso dal vocabolario.`, 'success');
  });
  customSection.appendChild(forgetBtn);

  modalAlts.appendChild(customSection);

  // ── Se nessun risultato ARASAAC → messaggio + stop ────────────
  if (tile.alts.length === 0) {
    const noRes = document.createElement('p');
    noRes.style.cssText = 'color:#64748b;font-size:.85rem;text-align:center;padding:0.8rem 0 0.3rem;';
    noRes.textContent   = 'Nessun pittogramma trovato su ARASAAC. Puoi usare un\'immagine personalizzata qui sopra.';
    modalAlts.appendChild(noRes);
    return;
  }

  // ── Divisore + griglia ARASAAC ────────────────────────────────
  const divider = document.createElement('div');
  divider.className   = 'modal-divider';
  divider.innerHTML   = '<span>oppure scegli un pittogramma ARASAAC</span>';
  modalAlts.appendChild(divider);

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
      scheduleDriveSync();
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
    const { dict, imgs, labels } = await importAll(file);
    dictionary   = { ...dictionary, ...dict };
    customImages = { ...customImages, ...imgs };
    customLabels = { ...customLabels, ...labels };
    saveDictionary(dictionary);
    saveCustomImages(customImages);
    saveLabels(customLabels);
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

  // ── Secondo tentativo (sequenziale) per immagini non scaricate al primo giro ─
  const missing = tiles.filter(t => t.imageUrl && !t.dataURL);
  if (missing.length > 0) {
    showStatus(`⏳ Riprovo ${missing.length} immagini mancanti…`);
    for (const t of missing) {
      t.dataURL = await fetchImageAsDataURL(t.imageUrl);
    }
  }

  showStatus('⏳ Generazione PDF in corso…');

  try {
    await generatePDF();
  } catch (err) {
    console.error('[PDF]', err);
    showStatus('❌ Errore PDF: ' + err.message + ' — Ricarica la pagina e riprova.', 'error');
  } finally {
    btnPdf.disabled = false;
  }
}

async function generatePDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('Libreria jsPDF non caricata. Verifica la connessione Internet.');
  }

  const { cols, rows, orientation } = currentOptions;
  const { jsPDF }                   = window.jspdf;

  // ── Misure A4 in mm (adattate all'orientamento) ───────────────
  const isLandscape = orientation === 'landscape';
  const PAGE_W  = isLandscape ? 297 : 210;   // ⚙️ larghezza pagina
  const PAGE_H  = isLandscape ? 210 : 297;   // ⚙️ altezza pagina
  const MARGIN  = 8;                          // ⚙️ margine esterno in mm
  const GAP     = 2;                          // ⚙️ spazio tra tessere in mm
  const TEXT_H  = 6;                          // ⚙️ altezza zona testo in mm
  const IMG_PAD = 1;                          // ⚙️ padding interno immagine in mm

  const availW  = PAGE_W - 2 * MARGIN;
  const availH  = PAGE_H - 2 * MARGIN - 5;   // -5mm per nota licenza in fondo
  const cellW   = (availW - (cols - 1) * GAP) / cols;
  const cellH   = (availH - (rows - 1) * GAP) / rows;
  const cell    = Math.min(cellW, cellH);
  const imgSize = cell - TEXT_H - IMG_PAD * 2;

  // ── Font adattivo: scala il testo alla dimensione della tessera ─
  const FONT_SIZE = Math.max(4, Math.min(9, Math.round(cell * 0.28)));

  // ── Layout frase-aware (condiviso con il preview) ─────────────
  const layout    = computeLayout(tiles, cols, rows);
  const pageCount = layout.length;

  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(FONT_SIZE);

  // ── Genera ogni pagina ────────────────────────────────────────
  for (let pi = 0; pi < pageCount; pi++) {
    if (pi > 0) doc.addPage();

    layout[pi].forEach((row, rowIdx) => {
      row.forEach((tile, colIdx) => {
        if (!tile) return;  // cella vuota (fine frase) → salta

        const x = MARGIN + colIdx * (cell + GAP);
        const y = MARGIN + rowIdx * (cell + GAP);

        // ── Bordo tessera ─────────────────────────────────────
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.3);
        doc.roundedRect(x, y, cell, cell, 1, 1, 'S');

        // ── Immagine ──────────────────────────────────────────
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

        // ── Linea separatrice immagine / testo ────────────────
        const sepY = y + IMG_PAD + imgSize + 0.5;
        doc.setDrawColor(220, 220, 220);
        doc.line(x + 1, sepY, x + cell - 1, sepY);

        // ── Testo parola ──────────────────────────────────────
        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(FONT_SIZE);
        doc.text(
          customLabels[tile.word.toUpperCase()] || tile.word,
          x + cell / 2,
          y + cell - 1.5,
          { align: 'center', maxWidth: cell - 2 }
        );
      });
    });
  }

  // ── Nota di licenza ARASAAC (obbligatoria per CC BY-NC-SA) ───
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(4.5);
    doc.setTextColor(170, 170, 170);
    doc.text(
      'Pittogrammi ARASAAC \u00a9 Gobierno de Arag\u00f3n \u2013 Licenza CC BY-NC-SA 4.0 \u2013 arasaac.org  |  \u00a9 2026 EduTechLab \u2013 Fabio Rizzotto \u2013 Tutti i diritti riservati  |  App a scopo didattico non commerciale  |  D.Lgs. 196/2003',
      PAGE_W / 2, PAGE_H - 2.5,
      { align: 'center' }
    );
  }

  doc.save('caartella.pdf');
  showStatus('✅ PDF scaricato!', 'success');
}

/** Disegna un segnaposto testuale quando l'immagine non è disponibile. */
function drawNoImage(doc, x, y, cell, imgSize, pad) {
  doc.setFontSize(16);
  doc.setTextColor(210, 210, 210);
  doc.text('?', x + cell / 2, y + pad + imgSize / 2 + 3, { align: 'center' });
  doc.setTextColor(0, 0, 0);
}

// ══════════════════════════════════════════════════════════════════
//  SELETTORE ALUNNO
// ══════════════════════════════════════════════════════════════════
function initStudentSelector() {
  updateStudentSelector();

  $('sel-student').addEventListener('change', async e => {
    const name = e.target.value;
    setCurrentStudent(name);
    dictionary   = loadDictionary();
    customImages = loadCustomImagesForStudent(name);
    customLabels = loadLabelsForStudent(name);

    // Se Drive connesso, carica dizionario dal Drive per questo alunno
    if (isDriveConnected()) {
      const driveData = await loadStudentFromDrive(name);
      if (driveData) {
        dictionary   = { ...dictionary,   ...driveData.dict   };
        customImages = { ...customImages, ...driveData.custom };
        saveDictionary(dictionary);
        saveCustomImages(customImages);
      }
    }

    _updateRemoveBtn(name);
    // Se c'erano tessere visibili, aggiorna la preview col nuovo dizionario
    if (tiles.length > 0) renderPages();
  });

  $('btn-add-student').addEventListener('click', async () => {
    const name = prompt('Nome dell\'alunno (es. "Mario R." oppure usa iniziali per la privacy):');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    addStudent(trimmed);
    updateStudentSelector(trimmed);
    setCurrentStudent(trimmed);
    dictionary   = loadDictionary();
    customImages = loadCustomImagesForStudent(trimmed);

    // Migrazione: se esisteva vecchio dizionario anonimo, chiedi se importarlo
    const legacyCount = getLegacyDictionaryCount();
    if (legacyCount > 0) {
      const migrate = confirm(
        `Hai ${legacyCount} parole già salvate nel dizionario generico.\n` +
        `Vuoi importarle anche per "${trimmed}"?`
      );
      if (migrate) {
        const legacy = loadDictionaryForStudent('');
        dictionary   = { ...legacy, ...dictionary };
        saveDictionary(dictionary);
      }
    }
    _updateRemoveBtn(trimmed);
  });

  $('btn-remove-student').addEventListener('click', () => {
    const name = getCurrentStudent();
    if (!name) return;
    if (!confirm(`Rimuovi "${name}" dalla lista? Il dizionario salvato non viene eliminato.`)) return;
    removeStudent(name);
    updateStudentSelector('');
    setCurrentStudent('');
    dictionary   = loadDictionary();
    customImages = loadCustomImages();
  });
}

function updateStudentSelector(selectName) {
  const sel  = $('sel-student');
  const list = getStudentsList();
  const curr = selectName !== undefined ? selectName : getCurrentStudent();

  sel.innerHTML = '<option value="">— Nessun nome (uso generico) —</option>';
  list.filter(n => n !== '').forEach(name => {
    const opt = document.createElement('option');
    opt.value       = name;
    opt.textContent = name;
    if (name === curr) opt.selected = true;
    sel.appendChild(opt);
  });
  if (curr === '' || !curr) sel.value = '';
  _updateRemoveBtn(curr);
}

function _updateRemoveBtn(studentName) {
  const btn = $('btn-remove-student');
  btn.style.display = studentName ? 'inline-block' : 'none';
}

// Helper per caricare custom images per alunno specifico
function loadCustomImagesForStudent(studentName) {
  const key = studentName === '' ? 'caa_custom_images_v1' : `caa_custom_v2_${studentName}`;
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function saveCustomImages(imgs) {
  saveCustomImagesForStudent(getCurrentStudent(), imgs);
}

function saveCustomImagesForStudent(studentName, imgs) {
  const key = studentName === '' ? 'caa_custom_images_v1' : `caa_custom_v2_${studentName}`;
  localStorage.setItem(key, JSON.stringify(imgs));
}

function saveLabels(lbls) {
  saveLabelsForStudent(getCurrentStudent(), lbls);
}

// ── Sync lista alunni da Drive (aggiunge alunni trovati su Drive) ─
async function syncStudentListFromDrive() {
  if (!isDriveConnected()) return;
  const driveStudents = await listStudentsOnDrive();
  driveStudents.forEach(s => { if (s.name !== undefined) addStudent(s.name); });
  updateStudentSelector();
}

// ── Aggiorna pannello condivisione nel modal Drive ────────────────
async function _refreshDriveSharePanel() {
  const studentName   = getCurrentStudent();
  const nameEl        = document.getElementById('drive-share-student-name');
  const noStudentEl   = document.getElementById('drive-share-no-student');
  const withStudentEl = document.getElementById('drive-share-with-student');
  const codeEl        = document.getElementById('drive-share-code');
  const fileNameEl    = document.getElementById('drive-share-filename');

  if (nameEl) nameEl.textContent = studentName || '—';

  if (!studentName || !isDriveConnected()) {
    if (noStudentEl)   noStudentEl.style.display   = 'block';
    if (withStudentEl) withStudentEl.style.display = 'none';
    return;
  }

  if (noStudentEl)   noStudentEl.style.display   = 'none';
  if (withStudentEl) withStudentEl.style.display = 'block';

  // Carica il codice (file ID) per questo alunno
  if (codeEl) {
    codeEl.value = '⏳ Carico codice…';
    const code = await getStudentShareCode(studentName);
    codeEl.value = code || '— salva prima un vocabolario per questo alunno —';
    if (fileNameEl) {
      const safeName = studentName.replace(/[/\\?%*:|"<>]/g, '-');
      fileNameEl.textContent = `vocabolario-${safeName}.json`;
    }
  }

  // Mostra vocabolari condivisi ricevuti
  const sharedStudentsEl = document.getElementById('drive-shared-students');
  const sharedListEl     = document.getElementById('drive-shared-list');
  const students = getStudentsList().filter(n => n && isSharedStudent(n));
  if (sharedStudentsEl && sharedListEl) {
    if (students.length > 0) {
      sharedStudentsEl.style.display = 'block';
      sharedListEl.innerHTML = students
        .map(n => `<span style="display:inline-block;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:2px 8px;margin:2px;font-size:0.8rem;">📂 ${n}</span>`)
        .join('');
    } else {
      sharedStudentsEl.style.display = 'none';
    }
  }
}

// ── Salvataggio Drive con debounce (evita chiamate troppo frequenti) ─
function scheduleDriveSync() {
  if (!isDriveConnected()) return;
  clearTimeout(_driveSaveTimer);
  _driveSaveTimer = setTimeout(async () => {
    const studentName = getCurrentStudent();
    await saveStudentToDrive(studentName, dictionary, customImages, customLabels);
  }, 1500); // aspetta 1.5s dopo l'ultima modifica prima di salvare
}

// ── Utility ────────────────────────────────────────────────────
function showStatus(msg, type = '') {
  statusDiv.textContent = msg;
  statusDiv.className   = `status ${type}`;
  statusDiv.classList.remove('hidden');
}
