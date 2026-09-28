# Einsatzbericht Erfassung – Freiwillige Feuerwehr Ebringen

Das Formular läuft als statische Seite auf **GitHub Pages**. **Google Apps Script** dient als Backend: liest Kameraden und Auswahllisten aus einem Google Spreadsheet, erzeugt das PDF und verschickt die Mail.

```
Kamerad (Handy/PC)
   │  https://<user>.github.io/<repo>/        ← docs/ (GitHub Pages)
   ▼
Formular  ──fetch (JSON, mit Zugangscode)──▶  Google Apps Script Web-App  ← apps-script/
                                                 ├─ Google Spreadsheet (Kameraden, Listen, Protokoll)
                                                 └─ PDF + Mail (Feuerwehr Ebringen)
```

## Funktionen

- Formular für Basisdaten, Ort & Fahrzeuge, externe Behörden, Mannschaft und Berichtstexte
- Kameraden nach Nachname sortiert, Auswahllisten aus dem Spreadsheet
- **Überörtliche Hilfe:** Bei „Einsatz auf Gemarkung Ebringen: Nein“ entfällt der Einsatzleiter
- **Bereitschaft Gerätehaus:** Funktion „Bereitschaft“ oder Fahrzeug „Gerätehaus“ → eigene Tabelle im PDF
- **Bilder:** bis zu 8 Fotos, im PDF eingebettet
- **Logo** in Formular, PDF und Mail
- **Zugangscode:** Ohne Code liefert das Backend keine Daten und nimmt keine Berichte an
- Mail an mehrere Empfänger, bei angehaktem Atemschutz zusätzlich an die Atemschutz-Adresse
- Protokoll aller Berichte im Tabellenblatt „Berichte“

## Projektstruktur

```
.
├── README.md
├── .gitignore
├── .clasp.json.example      Vorlage für clasp (optional)
├── docs/                    Frontend → GitHub Pages
│   ├── index.html
│   ├── config.js            hier die Web-App-URL eintragen
│   └── logo.png
└── apps-script/             Backend → Google Apps Script
    ├── Code.gs
    ├── Logo.html            Logo als Base64-Data-URI (für PDF und Mail)
    └── appsscript.json
```

## Wichtig: Repository muss öffentlich sein

GitHub Pages ist mit einem kostenlosen Konto nur für **öffentliche** Repositories verfügbar. Deshalb steht **nichts Vertrauliches im Repository**:

| Was | Wo |
|---|---|
| Empfänger-Adressen, Zugangscode | Skripteigenschaften in Apps Script |
| Kameraden, Fahrzeuge, Orte, Berichte | Google Spreadsheet |
| Web-App-URL | `docs/config.js` (öffentlich sichtbar, aber nur mit Zugangscode nutzbar) |

Niemals Adressen, Codes oder Namen in den Code schreiben.

## Einrichtung

### 1. Spreadsheet
Blätter **Einstellungen**, **Mannschaft**, **Berichte** anlegen (oder mit `setupSpreadsheet` erzeugen lassen). Zeile 1 sind die Überschriften:

- **Einstellungen:** `Einsatzarten` | `Orte` | `Fahrzeuge` | `Funktionen` | `Stichworte` (in *Funktionen* den Eintrag `Bereitschaft` ergänzen)
- **Mannschaft:** `Nachname` | `Vorname` | `Einsatzleiter` | `Aktiv` (`Einsatzleiter = ja` für Einsatzleiter, `Aktiv = nein` blendet aus)
- **Berichte:** wird automatisch befüllt

### 2. Apps Script (Backend)
1. Im Spreadsheet **Erweiterungen → Apps Script**.
2. Dateien aus `apps-script/` anlegen: `Code.gs`, `Logo` (HTML, Name ohne Endung) und `appsscript.json` (Manifest in den Projekteinstellungen einblenden).
3. **Projekteinstellungen → Skripteigenschaften** anlegen:

   | Eigenschaft | Wert |
   |---|---|
   | `ACCESS_CODE` | frei gewählter Zugangscode |
   | `MAIL_TO` | Empfänger, mit Komma getrennt |
   | `MAIL_ATEMSCHUTZ` | Adresse für angehakten Atemschutz |

4. `setupSpreadsheet` und `testLogo` einmal ausführen (Berechtigungen bestätigen).
5. **Bereitstellen → Neue Bereitstellung → Web-App**: Ausführen als *Ich*, Zugriff *Jeder*. Die URL (endet auf `/exec`) kopieren.

### 3. Frontend
1. In `docs/config.js` die Web-App-URL bei `API_URL` eintragen.
2. GitHub: **Settings → Pages → Source: Deploy from a branch → Branch `main`, Ordner `/docs` → Save**.
3. Nach ca. einer Minute ist die Seite unter `https://<user>.github.io/<repo>/` erreichbar. Diesen Link und den Zugangscode an die Kameraden geben.

## Änderungen einspielen

- **Frontend (`docs/`):** Datei auf GitHub ändern und committen. Die Seite aktualisiert sich automatisch.
- **Backend (`apps-script/`):** Im Editor ändern, dann **Bereitstellen → Bereitstellungen verwalten → Stift → Neue Version → Bereitstellen**. Die URL bleibt gleich.

## clasp (optional)

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # scriptId eintragen
clasp push
```

## Hinweise

- **Zugangscode ändern:** Skripteigenschaft `ACCESS_CODE` neu setzen. Die Kameraden werden dann beim nächsten Öffnen nach dem neuen Code gefragt.
- **Absender:** Der Name „Feuerwehr Ebringen“ wird gesetzt, die Adresse ist aber das Google-Konto, unter dem die Web-App bereitgestellt wurde.
- **Mail-Limit:** Ein normales Google-Konto darf ca. 100 Mails pro Tag über Apps Script versenden.
- **Logo wechseln:** `docs/logo.png` ersetzen und in `apps-script/Logo.html` die Data-URI (`data:image/png;base64,…`) austauschen.
- **Schutz:** Der Zugangscode wird auf dem Gerät des Kameraden gespeichert. Bei verlorenem Handy den Code ändern.
