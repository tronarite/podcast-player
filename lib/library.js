// Escaneo de la biblioteca: carpetas = series, audios = episodios. Mezcla etiquetas ID3 y data/library.json.
const fs = require('fs');
const path = require('path');
const { readTags, readCover } = require('./id3');

const ROOT = process.env.PODCAST_DIR || 'E:\\Podcast_Audioseries';
const DATA = path.join(__dirname, '..', 'data');
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.ogg', '.opus', '.wav', '.flac', '.aac']);
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

const tagCache = new Map(); // ruta -> { key, tags }
function tagsFor(file, stat) {
  const key = stat.mtimeMs + ':' + stat.size;
  const hit = tagCache.get(file);
  if (hit && hit.key === key) return hit.tags;
  let tags = null;
  try { tags = readTags(file); } catch { /* archivo sin etiquetas legibles */ }
  tagCache.set(file, { key, tags });
  return tags;
}

function loadManual() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'library.json'), 'utf8')); } catch { return {}; }
}

const readable = (s) => !!s && /[\p{L}\p{N}]{2,}/u.test(s);

// Limpia nombres de archivo: "T1E1_ Título" -> "T1E1: Título", "a _ b" -> "a · b".
function tidy(t) {
  return t.replace(/\s+_\s*/g, ' · ').replace(/_\s*$/, t.includes('¿') ? '?' : '').replace(/_\s*/g, ': ').trim();
}

function episodeInfo(file, tag, cfg, index) {
  const over = cfg.episodes?.[file] || {};
  let base = path.basename(file, path.extname(file)).replace(/^\d+\s*-\s*/, '');
  let label = String(index + 1);
  if (cfg.numberRegex) {
    const m = new RegExp(cfg.numberRegex, 'i').exec(base);
    if (m) label = String(parseInt(m[1], 10));
  }
  if (cfg.titleStrip) base = base.replace(new RegExp(cfg.titleStrip, 'i'), '');
  const fromFile = tidy(base);
  const title = over.title || (readable(tag?.title) ? tag.title : readable(fromFile) ? fromFile : `Episodio ${index + 1}`);
  return { title, description: over.description || tag?.description || '', n: label };
}

// Temporadas: primero las reglas de data/library.json ([regex, etiqueta con $1]), luego T2E3 / T02E03 / 2x01.
const SEASON_RE = [/\bT(\d{1,2})\s*E\s*\d+/i, /(?<![\p{L}\d])(\d{1,2})\s*x\s*E?\d+/iu];
const EPNUM_RE = /(?:\bT\d+\s*E|\d\s*x\s*E?|(?:^|[\s_-])E|Episodio\s+)(\d+)/i;
function seasonOf(base, cfg) {
  for (const [re, label] of cfg.seasons || []) {
    const m = new RegExp(re, 'iu').exec(base);
    if (m) return label.replace(/\$(\d)/g, (_, i) => String(parseInt(m[i], 10)));
  }
  for (const re of SEASON_RE) {
    const m = re.exec(base);
    if (m) return `Temporada ${parseInt(m[1], 10)}`;
  }
  return null;
}

// Los episodios sin temporada heredan la anterior; los del principio, la previa a la primera detectada.
function assignSeasons(files, cfg) {
  const found = files.map((f) => seasonOf(path.basename(f.name, path.extname(f.name)).replace(/^\d+\s*-\s*/, ''), cfg));
  const first = found.find(Boolean);
  if (!first) return files.map(() => '');
  const n = /^Temporada (\d+)$/.exec(first)?.[1];
  let prev = n > 1 ? `Temporada ${n - 1}` : first;
  const seasons = found.map((x) => (prev = x || prev));
  return new Set(seasons).size > 1 ? seasons : files.map(() => '');
}

function findCover(seriesName, files) {
  const covers = path.join(DATA, 'covers');
  const dir = path.join(ROOT, seriesName);
  const candidates = [];
  for (const ext of Object.keys(IMAGE_MIME)) {
    candidates.push(path.join(covers, seriesName + ext));
    for (const n of ['cover', 'folder', 'poster']) candidates.push(path.join(dir, n + ext));
  }
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return { kind: 'file', path: c, mime: IMAGE_MIME[path.extname(c).toLowerCase()], v: Math.floor(st.mtimeMs) };
    } catch { /* siguiente candidato */ }
  }
  const emb = files.find((f) => f.tags?.hasCover);
  return emb ? { kind: 'embedded', path: emb.abs, v: Math.floor(emb.stat.mtimeMs) } : null;
}

let memo = null;
function scan() {
  if (memo && Date.now() - memo.at < 3000) return memo.data;
  const manual = loadManual();
  const out = [];
  for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const files = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const childRel = path.join(rel, e.name);
        if (e.isDirectory()) walk(childRel);
        else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
          const abs = path.join(ROOT, childRel), stat = fs.statSync(abs);
          files.push({ id: childRel.replace(/\\/g, '/'), name: e.name, abs, stat, tags: tagsFor(abs, stat) });
        }
      }
    };
    walk(dir.name);
    if (!files.length) continue;
    files.sort((a, b) => collator.compare(a.id, b.id));

    const cfg = manual[dir.name] || {};
    const first = files.find((f) => f.tags?.album) || files[0];
    const years = files.map((f) => +f.tags?.year).filter(Boolean);
    const yMin = Math.min(...years), yMax = Math.max(...years);
    const cover = findCover(dir.name, files);
    const seasons = assignSeasons(files, cfg);
    out.push({
      name: dir.name,
      title: cfg.title || first.tags?.album || dir.name,
      kind: cfg.kind || first.tags?.genre || '',
      author: cfg.author || first.tags?.albumArtist || first.tags?.artist || '',
      credits: cfg.credits || '',
      year: cfg.year || (years.length ? (yMin === yMax ? String(yMin) : `${yMin}–${yMax}`) : ''),
      description: cfg.description || '',
      cover: cover ? `/api/cover/${encodeURIComponent(dir.name)}?v=${cover.v}` : null,
      _cover: cover,
      episodes: files.map((f, i) => {
        const ep = { id: f.id, size: f.stat.size, ...episodeInfo(f.name, f.tags, cfg, i) };
        if (seasons[i]) {
          ep.season = seasons[i];
          // La temporada ya se muestra aparte: "T01E03 - Cajas negras" -> "Cajas negras".
          const short = ep.title.replace(/^(T\d+\s*E\d+|E\d+|\d+\s*x\s*E?\d+)\s*[-–:·]?\s*/i, '');
          if (!cfg.episodes?.[f.name]?.title && readable(short)) ep.title = short;
          if (!cfg.numberRegex) ep.n = EPNUM_RE.exec(path.basename(f.name, path.extname(f.name)).replace(/^\d+\s*-\s*/, ''))?.[1]?.replace(/^0+(?=\d)/, '') || '–';
        }
        if (f.tags?.chapters?.length > 1) ep.ch = true;
        return ep;
      }),
    });
  }
  out.sort((a, b) => collator.compare(a.title, b.title));
  memo = { at: Date.now(), data: out };
  return out;
}

const publicLibrary = () => scan().map(({ _cover, ...s }) => s);

// Devuelve { mime, data } para la portada de una serie, o null.
function coverFor(seriesName) {
  const s = scan().find((x) => x.name === seriesName);
  if (!s?._cover) return null;
  if (s._cover.kind === 'file') return { mime: s._cover.mime, data: fs.readFileSync(s._cover.path) };
  return readCover(s._cover.path);
}

// Capítulos de un episodio de la biblioteca, ordenados por inicio; [] si no tiene.
function chaptersFor(id) {
  if (!scan().some((s) => s.episodes.some((e) => e.id === id))) return [];
  const abs = path.join(ROOT, id);
  let stat;
  try { stat = fs.statSync(abs); } catch { return []; }
  const chapters = tagsFor(abs, stat)?.chapters || [];
  return [...chapters].sort((a, b) => a.start - b.start).map((c, i) => ({ start: c.start, title: c.title || `Capítulo ${i + 1}` }));
}

module.exports = { ROOT, AUDIO_EXT, publicLibrary, coverFor, chaptersFor };
