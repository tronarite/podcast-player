// Lector mínimo de etiquetas ID3v2.3/2.4: título, autor, álbum, año, descripción, capítulos y portada.
const fs = require('fs');

const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const wide = (enc) => enc === 1 || enc === 2;

function decode(enc, buf) {
  if (!wide(enc)) return buf.toString(enc === 3 ? 'utf8' : 'latin1');
  let b = buf, le = enc === 1;
  if (b[0] === 0xff && b[1] === 0xfe) { b = b.subarray(2); le = true; }
  else if (b[0] === 0xfe && b[1] === 0xff) { b = b.subarray(2); le = false; }
  b = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
  if (!le) b.swap16();
  return b.toString('utf16le');
}

// Posición del terminador nulo según la codificación (alineado en UTF-16), o -1.
function findTerm(enc, buf) {
  if (wide(enc)) {
    for (let i = 0; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i;
    return -1;
  }
  return buf.indexOf(0);
}

const clean = (s) => s.replace(/\0+/g, ' ').trim();

function textFrame(d) {
  const enc = d[0], body = d.subarray(1), t = findTerm(enc, body);
  return clean(decode(enc, t < 0 ? body : body.subarray(0, t)));
}

// COMM / USLT: codificación, idioma (3), descripción corta, texto.
function longText(d) {
  const enc = d[0], rest = d.subarray(4), t = findTerm(enc, rest);
  return clean(decode(enc, rest.subarray(t < 0 ? 0 : t + (wide(enc) ? 2 : 1))));
}

function picture(d) {
  const enc = d[0], mimeEnd = d.indexOf(0, 1);
  if (mimeEnd < 0) return null;
  const rest = d.subarray(mimeEnd + 2), t = findTerm(enc, rest);
  if (t < 0) return null;
  const data = rest.subarray(t + (wide(enc) ? 2 : 1));
  let mime = d.toString('latin1', 1, mimeEnd).toLowerCase();
  if (!mime.includes('/')) mime = 'image/' + (mime === 'jpg' ? 'jpeg' : mime);
  if (data[0] === 0x89 && data[1] === 0x50) mime = 'image/png';
  else if (data[0] === 0xff && data[1] === 0xd8) mime = 'image/jpeg';
  return { mime, data };
}

const stripHtml = (s) =>
  s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// CHAP: id del elemento, inicio y fin en ms, offsets y subframes (el título va en TIT2).
function chapter(d, ver) {
  const idEnd = d.indexOf(0);
  if (idEnd < 0 || idEnd + 17 > d.length) return null;
  const start = d.readUInt32BE(idEnd + 1) / 1000;
  let o = idEnd + 17, title = '';
  while (o + 10 <= d.length) {
    const id = d.toString('latin1', o, o + 4);
    const n = ver === 4 ? synchsafe(d, o + 4) : d.readUInt32BE(o + 4);
    if (id === 'TIT2') title = textFrame(d.subarray(o + 10, o + 10 + n));
    o += 10 + n;
  }
  return { start, title };
}

// Lee los frames; con wantCover devuelve la portada en lugar de los textos.
function parse(file, wantCover) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(10);
    if (fs.readSync(fd, h, 0, 10, 0) < 10 || h.toString('latin1', 0, 3) !== 'ID3' || h[3] < 3) return null;
    const ver = h[3], size = synchsafe(h, 6);
    const body = Buffer.alloc(size);
    fs.readSync(fd, body, 0, size, 10);
    let o = 0;
    if (h[5] & 0x40) o = ver === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
    const out = { hasCover: false };
    while (o + 10 <= size) {
      const id = body.toString('latin1', o, o + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const n = ver === 4 ? synchsafe(body, o + 4) : body.readUInt32BE(o + 4);
      const fmt = body[o + 9];
      let d = body.subarray(o + 10, o + 10 + n);
      o += 10 + n;
      if (ver === 4 && (fmt & 1)) d = d.subarray(4);
      if (!d.length) continue;
      if (id === 'CHAP' && !wantCover) {
        const c = chapter(d, ver);
        if (c) (out.chapters ||= []).push(c);
      } else if (id === 'APIC') {
        out.hasCover = true;
        if (wantCover) { const p = picture(d); if (p) return p; }
      } else if (!wantCover) {
        if (id === 'TIT2') out.title = textFrame(d);
        else if (id === 'TPE1') out.artist = textFrame(d);
        else if (id === 'TPE2') out.albumArtist = textFrame(d);
        else if (id === 'TALB') out.album = textFrame(d);
        else if (id === 'TDRC' || id === 'TYER') out.year = (textFrame(d).match(/\d{4}/) || [])[0];
        else if (id === 'TCON') out.genre = textFrame(d);
        else if ((id === 'USLT' || id === 'COMM') && !out.description) {
          const t = stripHtml(longText(d));
          // Algunas descargas traen XML de marcas de anuncios en el comentario.
          if (t && !t.startsWith('<') && !/mediacaster|cuepoint/i.test(t) && /\p{L}{3,}/u.test(t)) out.description = t;
        }
      }
    }
    return wantCover ? null : out;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readTags: (f) => parse(f, false), readCover: (f) => parse(f, true) };
