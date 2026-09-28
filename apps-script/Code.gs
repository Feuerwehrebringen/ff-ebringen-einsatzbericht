/**
 * Einsatzbericht Erfassung – Freiwillige Feuerwehr Ebringen
 * Google Apps Script als Backend (JSON-API). Das Formular liegt auf GitHub Pages (Ordner docs/).
 *
 * - Liefert Kameraden und Auswahllisten aus einem Google Spreadsheet
 * - Erzeugt beim Absenden ein PDF und verschickt es per Mail
 * - Protokolliert jeden Bericht im Tabellenblatt "Berichte"
 *
 * Vertrauliche Einstellungen stehen NICHT im Code, sondern in den Skripteigenschaften
 * (Projekteinstellungen → Skripteigenschaften):
 *   ACCESS_CODE       Zugangscode für die Kameraden (Pflicht)
 *   MAIL_TO           Empfänger jedes Berichts, mit Komma getrennt (Pflicht)
 *   MAIL_ATEMSCHUTZ   Zusätzlicher Empfänger bei angehaktem Atemschutz (optional)
 *   SPREADSHEET_ID    Nur nötig, wenn das Script nicht im Spreadsheet liegt
 */

const CONFIG = {
  SENDER_NAME: 'Feuerwehr Ebringen',
  // Das Logo liegt als Base64-Data-URI in der Projektdatei "Logo" (Logo.html).

  SHEET_SETTINGS: 'Einstellungen',
  SHEET_CREW: 'Mannschaft',
  SHEET_REPORTS: 'Berichte',

  MAX_FIELD_LENGTH: 5000,

  // Bilder (werden im Browser verkleinert)
  MAX_IMAGES: 8,
  MAX_IMAGE_CHARS: 1500000
};

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function prop_(name) {
  return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

/** Prüft den Zugangscode. Ohne gesetzten ACCESS_CODE wird alles abgelehnt. */
function checkCode_(code) {
  const expected = prop_('ACCESS_CODE');
  if (!expected) throw new Error('Skripteigenschaft ACCESS_CODE ist nicht gesetzt.');
  if (String(code || '') !== expected) {
    Utilities.sleep(1500); // bremst Ausprobieren
    throw new Error('Zugangscode falsch.');
  }
}

/** Erreichbarkeitstest. Gibt keine Daten heraus. */
function doGet() {
  return json_({ ok: true, service: 'Einsatzbericht API' });
}

/**
 * Das Frontend sendet JSON als text/plain (vermeidet CORS-Preflight):
 *   { action: 'data',   code }
 *   { action: 'submit', code, report: {...} }
 */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkCode_(body.code);
    if (body.action === 'data') return json_({ ok: true, data: getInitialData() });
    if (body.action === 'submit') return json_(submitReport(body.report));
    throw new Error('Unbekannte Aktion.');
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ------------------------------------------------------------------ */
/*  Logo                                                               */
/* ------------------------------------------------------------------ */

/** Liest das Logo aus der Projektdatei "Logo" (Data-URI). Ohne Logo läuft die App weiter. */
function getLogoDataUri_() {
  try {
    const uri = HtmlService.createHtmlOutputFromFile('Logo').getContent().trim();
    return /^data:image\/[a-z+.-]+;base64,/i.test(uri) ? uri : '';
  } catch (err) {
    console.warn('Logo konnte nicht geladen werden: ' + err);
    return '';
  }
}

function getLogoBlob_() {
  const uri = getLogoDataUri_();
  if (!uri) return null;
  const m = uri.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
  if (!m) return null;
  return Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'logo');
}

function blobToDataUri_(blob) {
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** Zur Kontrolle im Editor ausführen. */
function testLogo() {
  const blob = getLogoBlob_();
  if (!blob) throw new Error('Kein gültiges Logo in der Projektdatei "Logo" gefunden.');
  console.log('Logo OK: ' + blob.getContentType() + ', ' + Math.round(blob.getBytes().length / 1024) + ' KB');
}

/** Auswahllisten und Kameraden für das Formular. */
function getInitialData() {
  const ss = getSpreadsheet_();
  const settings = getSheet_(ss, CONFIG.SHEET_SETTINGS);
  const crew = getCrew_(getSheet_(ss, CONFIG.SHEET_CREW));

  const leaders = crew.filter(function (c) { return c.leader; });

  return {
    einsatzarten: readColumn_(settings, 'Einsatzarten'),
    orte: readColumn_(settings, 'Orte'),
    fahrzeuge: readColumn_(settings, 'Fahrzeuge'),
    funktionen: readColumn_(settings, 'Funktionen'),
    stichworte: readColumn_(settings, 'Stichworte'),
    kameraden: crew.map(function (c) { return c.name; }),
    einsatzleiter: (leaders.length ? leaders : crew).map(function (c) { return c.name; })
  };
}

/** Erzeugt PDF, verschickt die Mail und protokolliert den Bericht. */
function submitReport(raw) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const r = sanitizeReport_(raw);
    const logo = getLogoBlob_();
    const pdf = buildPdf_(r, logo);

    const mail = {
      to: buildRecipients_(r),
      subject: buildSubject_(r),
      body: buildMailText_(r),
      htmlBody: buildMailHtml_(r, !!logo),
      name: CONFIG.SENDER_NAME,
      attachments: [pdf]
    };
    if (logo) mail.inlineImages = { logo: logo };
    MailApp.sendEmail(mail);

    let warning = '';
    try {
      logReport_(r);
    } catch (err) {
      console.error('Protokollierung fehlgeschlagen: ' + err);
      warning = 'Der Bericht wurde versendet, konnte aber nicht im Tabellenblatt "Berichte" protokolliert werden.';
    }

    return { ok: true, warning: warning, filename: pdf.getName() };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/*  Spreadsheet                                                        */
/* ------------------------------------------------------------------ */

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Kein Spreadsheet verknüpft. Bitte setupSpreadsheet() ausführen oder die Script-Property SPREADSHEET_ID setzen.');
}

function getSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Tabellenblatt "' + name + '" nicht gefunden.');
  return sheet;
}

function normalize_(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function isYes_(v) {
  return v === true || ['ja', 'x', 'true', '1', 'yes', 'j'].indexOf(normalize_(v)) !== -1;
}

/** Liest alle Werte unterhalb einer Spaltenüberschrift (Zeile 1). */
function readColumn_(sheet, header) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (!lastCol || lastRow < 2) return [];
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normalize_);
  const idx = headers.indexOf(normalize_(header));
  if (idx < 0) return [];
  return sheet.getRange(2, idx + 1, lastRow - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(Boolean);
}

/** Tabellenblatt "Mannschaft": Spalten Nachname | Vorname | Einsatzleiter | Aktiv */
function getCrew_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0].map(normalize_);
  const iLast = h.indexOf('nachname');
  const iFirst = h.indexOf('vorname');
  const iLead = h.indexOf('einsatzleiter');
  const iActive = h.indexOf('aktiv');
  if (iLast < 0 || iFirst < 0) {
    throw new Error('Im Blatt "' + CONFIG.SHEET_CREW + '" fehlen die Spalten "Nachname" und "Vorname".');
  }

  return values.slice(1)
    .map(function (row) {
      const last = String(row[iLast] || '').trim();
      const first = String(row[iFirst] || '').trim();
      return {
        last: last,
        first: first,
        name: [last, first].filter(Boolean).join(', '),
        leader: iLead >= 0 && isYes_(row[iLead]),
        active: iActive < 0 || String(row[iActive]).trim() === '' || isYes_(row[iActive])
      };
    })
    .filter(function (c) { return c.name && c.active; })
    .sort(function (a, b) {
      return a.last.localeCompare(b.last, 'de') || a.first.localeCompare(b.first, 'de');
    });
}

/** Einmalig manuell ausführen: legt Tabellenblätter mit Beispieldaten an. */
function setupSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Einsatzbericht FF Ebringen – Daten');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }

  ensureSheet_(ss, CONFIG.SHEET_SETTINGS, [
    ['Einsatzarten', 'Orte', 'Fahrzeuge', 'Funktionen', 'Stichworte'],
    ['Brand', 'Ebringen', 'LF 10', 'Gruppenführer', 'Rauchmelder'],
    ['Technische Hilfeleistung', 'Sonstiger Ort', 'LF 8/6', 'Maschinist', 'Türöffnung'],
    ['Brandsicherheitswache', '', 'MTW', 'Angriffstrupp', 'Sturmschaden'],
    ['Sonstiges', '', 'Gerätehaus', 'Wassertrupp', 'Ölspur'],
    ['', '', '', 'Melder', '']
  ]);

  ensureSheet_(ss, CONFIG.SHEET_CREW, [
    ['Nachname', 'Vorname', 'Einsatzleiter', 'Aktiv'],
    ['Mustermann', 'Max', 'ja', 'ja'],
    ['Beispiel', 'Erika', '', 'ja']
  ]);

  ensureSheet_(ss, CONFIG.SHEET_REPORTS, [REPORT_HEADERS_]);

  console.log('Spreadsheet bereit: ' + ss.getUrl());
}

function ensureSheet_(ss, name, rows) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    const width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    const padded = rows.map(function (r) {
      const copy = r.slice();
      while (copy.length < width) copy.push('');
      return copy;
    });
    sheet.getRange(1, 1, padded.length, width).setValues(padded);
    sheet.getRange(1, 1, 1, width).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

/* ------------------------------------------------------------------ */
/*  Validierung                                                        */
/* ------------------------------------------------------------------ */

function sanitizeReport_(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Ungültige Daten.');

  const s = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); };
  const t = function (v) { return s(v, CONFIG.MAX_FIELD_LENGTH); };

  // Einsatz außerhalb der Gemarkung Ebringen (überörtliche Hilfe): keine Einsatzleitung
  const inEbringen = raw.gemarkung !== 'nein';

  const r = {
    einsatznummer: s(raw.einsatznummer, 50),
    datum: s(raw.datum, 10),
    gemarkung: inEbringen ? 'ja' : 'nein',
    einsatzleiter: inEbringen ? s(raw.einsatzleiter, 100) : '',
    alarmzeit: s(raw.alarmzeit, 5),
    ende: s(raw.ende, 5),
    einsatzart: s(raw.einsatzart, 100),
    stichwort: s(raw.stichwort, 100),
    ort: s(raw.ort, 100),
    strasse: s(raw.strasse, 150),
    fahrzeuge: (Array.isArray(raw.fahrzeuge) ? raw.fahrzeuge : []).slice(0, 30)
      .map(function (v) { return s(v, 50); }).filter(Boolean),
    rettungsdienst: t(raw.rettungsdienst),
    polizei: t(raw.polizei),
    ansprechPolizei: s(raw.ansprechPolizei, 150),
    ansprechRD: s(raw.ansprechRD, 150),
    ansprechSonstige: s(raw.ansprechSonstige, 150),
    mannschaft: (Array.isArray(raw.mannschaft) ? raw.mannschaft : []).slice(0, 80)
      .map(function (m) {
        return {
          name: s(m && m.name, 100),
          funktion: s(m && m.funktion, 100),
          fahrzeug: s(m && m.fahrzeug, 50),
          atemschutz: !!(m && m.atemschutz === true)
        };
      })
      .filter(function (m) { return m.name; }),
    meldungIls: t(raw.meldungIls),
    lage: t(raw.lage),
    massnahmen: t(raw.massnahmen),
    material: t(raw.material),
    kurzbericht: t(raw.kurzbericht),
    bilder: (Array.isArray(raw.bilder) ? raw.bilder : []).slice(0, CONFIG.MAX_IMAGES)
      .filter(function (uri) {
        return typeof uri === 'string' && uri.length <= CONFIG.MAX_IMAGE_CHARS &&
          /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(uri);
      })
  };

  const missing = [];
  if (!r.einsatznummer) missing.push('Einsatznummer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.datum)) missing.push('Datum');
  if (r.gemarkung === 'ja' && !r.einsatzleiter) missing.push('Einsatzleiter');
  if (!/^\d{2}:\d{2}$/.test(r.alarmzeit)) missing.push('Alarmzeit');
  if (r.ende && !/^\d{2}:\d{2}$/.test(r.ende)) missing.push('Ende (Format)');
  if (!r.einsatzart) missing.push('Einsatzart');
  if (!r.ort) missing.push('Ort');
  if (!r.mannschaft.length) missing.push('mindestens ein Kamerad');
  if (missing.length) throw new Error('Bitte ergänzen: ' + missing.join(', '));

  return r;
}

/* ------------------------------------------------------------------ */
/*  PDF & Mail                                                         */
/* ------------------------------------------------------------------ */

function escapeHtml_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function multiline_(v) {
  const e = escapeHtml_(v).replace(/\r?\n/g, '<br>');
  return e || '–';
}

/** Bereitschaft im Gerätehaus: Fahrzeug "Gerätehaus" oder Funktion "Bereitschaft". */
function isStandby_(m) {
  return normalize_(m.fahrzeug) === 'gerätehaus' || normalize_(m.funktion) === 'bereitschaft';
}

function splitCrew_(r) {
  return {
    einsatz: r.mannschaft.filter(function (m) { return !isStandby_(m); }),
    bereitschaft: r.mannschaft.filter(isStandby_)
  };
}

function leaderText_(r) {
  return r.gemarkung === 'ja' ? r.einsatzleiter : 'entfällt (Einsatz außerhalb der Gemarkung Ebringen)';
}

function formatDate_(iso) {
  return iso.split('-').reverse().join('.');
}

function buildFileName_(r) {
  const nr = r.einsatznummer.replace(/[^\wäöüÄÖÜß-]+/g, '_');
  return 'Einsatzbericht_' + nr + '_' + r.datum + '.pdf';
}

function buildRecipients_(r) {
  const list = prop_('MAIL_TO').split(',')
    .map(function (a) { return a.trim(); })
    .filter(Boolean);
  if (!list.length) throw new Error('Skripteigenschaft MAIL_TO ist nicht gesetzt.');

  const atemschutzMail = prop_('MAIL_ATEMSCHUTZ');
  const atemschutz = r.mannschaft.some(function (m) { return m.atemschutz; });
  if (atemschutz && atemschutzMail && list.indexOf(atemschutzMail) === -1) list.push(atemschutzMail);
  return list.join(',');
}

function buildSubject_(r) {
  const parts = ['Einsatzbericht', r.einsatznummer];
  if (r.stichwort) parts.push(r.stichwort);
  return parts.join(' – ') + ' (' + formatDate_(r.datum) + ')';
}

function buildMailText_(r) {
  const c = splitCrew_(r);
  return [
    'Neuer Einsatzbericht der Freiwilligen Feuerwehr Ebringen',
    '',
    'Einsatznummer: ' + r.einsatznummer,
    'Datum: ' + formatDate_(r.datum),
    'Einsatzart: ' + r.einsatzart + (r.stichwort ? ' (' + r.stichwort + ')' : ''),
    'Einsatzort: ' + [r.strasse, r.ort].filter(Boolean).join(', '),
    'Einsatzleiter: ' + leaderText_(r),
    'Mannschaft im Einsatz: ' + c.einsatz.length,
    c.bereitschaft.length ? 'Bereitschaft Gerätehaus: ' + c.bereitschaft.length : '',
    '',
    'Der vollständige Bericht liegt als PDF an.' + (r.bilder.length ? ' Bilder: ' + r.bilder.length : '')
  ].join('\n');
}

function buildMailHtml_(r, withLogo) {
  const e = escapeHtml_;
  const c = splitCrew_(r);
  const line = function (label, value) {
    return '<tr><td style="padding:2px 12px 2px 0;color:#666">' + e(label) + '</td><td style="padding:2px 0">' + e(value) + '</td></tr>';
  };
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">' +
    (withLogo ? '<img src="cid:logo" alt="Freiwillige Feuerwehr Ebringen" style="height:60px;margin-bottom:12px"><br>' : '') +
    '<p style="margin:0 0 10px 0"><b>Neuer Einsatzbericht</b></p>' +
    '<table style="border-collapse:collapse">' +
    line('Einsatznummer', r.einsatznummer) +
    line('Datum', formatDate_(r.datum)) +
    line('Einsatzart', r.einsatzart + (r.stichwort ? ' (' + r.stichwort + ')' : '')) +
    line('Einsatzort', [r.strasse, r.ort].filter(Boolean).join(', ')) +
    line('Einsatzleiter', leaderText_(r)) +
    line('Mannschaft im Einsatz', String(c.einsatz.length)) +
    (c.bereitschaft.length ? line('Bereitschaft Gerätehaus', String(c.bereitschaft.length)) : '') +
    '</table>' +
    '<p style="margin:12px 0 0 0">Der vollständige Bericht liegt als PDF an.</p>' +
    '<p style="margin:16px 0 0 0;color:#888">Freiwillige Feuerwehr Ebringen</p>' +
    '</div>';
}

function buildImagesHtml_(bilder) {
  if (!bilder.length) return '';
  let html = '<h2>Bilder (' + bilder.length + ')</h2><table style="width:100%;border-collapse:collapse">';
  for (let i = 0; i < bilder.length; i += 2) {
    html += '<tr>';
    for (let j = i; j < i + 2; j++) {
      html += '<td style="border:none;padding:4pt;width:50%">' +
        (bilder[j] ? '<img src="' + bilder[j] + '" width="230" alt="Bild ' + (j + 1) + '">' : '') + '</td>';
    }
    html += '</tr>';
  }
  return html + '</table>';
}

function buildPdf_(r, logo) {
  const row = function (label, value) {
    return '<tr><th>' + escapeHtml_(label) + '</th><td>' + multiline_(value) + '</td></tr>';
  };

  const crew = splitCrew_(r);
  const crewRowsOf = function (list) {
    if (!list.length) return '<tr><td colspan="4">–</td></tr>';
    return list.map(function (m) {
      return '<tr><td>' + escapeHtml_(m.name) + '</td><td>' + escapeHtml_(m.funktion || '–') +
        '</td><td>' + escapeHtml_(m.fahrzeug || '–') + '</td><td>' + (m.atemschutz ? 'Ja' : '–') + '</td></tr>';
    }).join('');
  };
  const crewHead = '<tr><th>Name</th><th>Funktion</th><th>Fahrzeug</th><th>Atemschutz</th></tr>';

  const zeit = r.alarmzeit + (r.ende ? ' – ' + r.ende + ' Uhr' : ' Uhr');

  const html =
    '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#222}' +
    'h1{font-size:18pt;margin:0 0 2pt 0;color:#c62828}' +
    'h2{font-size:11pt;margin:14pt 0 4pt 0;padding-bottom:2pt;border-bottom:1.5pt solid #c62828;color:#c62828}' +
    'table{width:100%;border-collapse:collapse}' +
    'th,td{text-align:left;vertical-align:top;padding:3pt 5pt;border-bottom:0.5pt solid #ddd}' +
    'th{width:32%;font-weight:bold;background:#f6f6f6}' +
    '.crew th{width:auto}' +
    '.sub{color:#666;margin-bottom:8pt}' +
    '</style></head><body>' +
    '<table style="width:100%;border-collapse:collapse"><tr>' +
    '<td style="border:none;padding:0;vertical-align:middle">' +
    '<h1>Einsatzbericht</h1>' +
    '<div class="sub">Freiwillige Feuerwehr Ebringen</div></td>' +
    (logo ? '<td style="border:none;padding:0;text-align:right;vertical-align:middle">' +
      '<img src="' + blobToDataUri_(logo) + '" height="44" style="height:44pt" alt="Logo"></td>' : '') +
    '</tr></table>' +

    '<h2>Basisdaten</h2><table>' +
    row('Einsatznummer', r.einsatznummer) +
    row('Datum', formatDate_(r.datum)) +
    row('Zeit', zeit) +
    row('Einsatz auf Gemarkung Ebringen', r.gemarkung === 'ja' ? 'Ja' : 'Nein') +
    row('Einsatzleiter', leaderText_(r)) +
    row('Einsatzart', r.einsatzart) +
    row('Stichwort', r.stichwort) +
    '</table>' +

    '<h2>Ort &amp; Fahrzeuge</h2><table>' +
    row('Ort', r.ort) +
    row('Straße', r.strasse) +
    row('Eingesetzte Fahrzeuge', r.fahrzeuge.join(', ')) +
    '</table>' +

    '<h2>Externe Behörden</h2><table>' +
    row('Rettungsdienst', r.rettungsdienst) +
    row('Polizei', r.polizei) +
    row('Ansprechpartner Polizei', r.ansprechPolizei) +
    row('Ansprechpartner RD', r.ansprechRD) +
    row('Ansprechpartner Sonstige', r.ansprechSonstige) +
    '</table>' +

    '<h2>Mannschaft im Einsatz (' + crew.einsatz.length + ')</h2>' +
    '<table class="crew">' + crewHead + crewRowsOf(crew.einsatz) + '</table>' +

    (crew.bereitschaft.length
      ? '<h2>Bereitschaft Gerätehaus (' + crew.bereitschaft.length + ')</h2>' +
        '<table class="crew">' + crewHead + crewRowsOf(crew.bereitschaft) + '</table>'
      : '') +

    '<h2>Berichte &amp; Lage</h2><table>' +
    row('Meldung ILS', r.meldungIls) +
    row('Lage beim Eintreffen', r.lage) +
    row('Maßnahmen', r.massnahmen) +
    row('Material / Besonderheiten', r.material) +
    row('Kurzbericht', r.kurzbericht) +
    '</table>' +

    buildImagesHtml_(r.bilder) +

    '<div class="sub" style="margin-top:14pt">Erstellt am ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm') + ' Uhr</div>' +
    '</body></html>';

  return Utilities.newBlob(html, 'text/html', 'bericht.html')
    .getAs('application/pdf')
    .setName(buildFileName_(r));
}

/* ------------------------------------------------------------------ */
/*  Protokoll                                                          */
/* ------------------------------------------------------------------ */

const REPORT_HEADERS_ = [
  'Zeitstempel', 'Einsatznummer', 'Datum', 'Alarmzeit', 'Ende', 'Einsatzleiter',
  'Einsatzart', 'Stichwort', 'Ort', 'Straße', 'Fahrzeuge', 'Mannschaftsstärke', 'Atemschutzträger',
  'Gemarkung Ebringen', 'Bereitschaft Gerätehaus'
];

// Spalten, die in älteren Versionen des Blattes fehlen können (werden am Ende ergänzt)
const EXTRA_HEADERS_ = ['Gemarkung Ebringen', 'Bereitschaft Gerätehaus'];

function logReport_(r) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SHEET_REPORTS);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_REPORTS);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(REPORT_HEADERS_);
    sheet.getRange(1, 1, 1, REPORT_HEADERS_.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // Spalte nachrüsten, falls das Blatt noch aus einer älteren Version stammt
  let lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normalize_);
  EXTRA_HEADERS_.forEach(function (h) {
    if (headers.indexOf(normalize_(h)) === -1) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(h).setFontWeight('bold');
    }
  });

  const crew = splitCrew_(r);

  sheet.appendRow([
    new Date(), r.einsatznummer, formatDate_(r.datum), r.alarmzeit, r.ende,
    r.gemarkung === 'ja' ? r.einsatzleiter : 'entfällt',
    r.einsatzart, r.stichwort, r.ort, r.strasse, r.fahrzeuge.join(', '),
    crew.einsatz.length,
    crew.einsatz.filter(function (m) { return m.atemschutz; }).length,
    r.gemarkung === 'ja' ? 'Ja' : 'Nein',
    crew.bereitschaft.length
  ]);
}
