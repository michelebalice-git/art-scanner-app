# Project Specifications: Art Scanner Web App

## Obiettivo

Creare una web app PWA-like completamente **adattiva (responsive)**. L'utente apre l'app (da smartphone, tablet o desktop), accede alla fotocamera, scatta la foto a un'opera d'arte e ottiene i dettagli (Autore, Titolo). L'intera interfaccia utente (UI) deve essere esclusivamente in lingua inglese. Deve essere predisposto un sistema per generare il QR Code di accesso all'app.

## Flusso Utente

1. Home screen con pulsante "Open Camera". L'interfaccia si adatta fluidamente alla risoluzione (portrait su mobile, landscape su desktop).
2. Viewfinder a tutto schermo (tramite HTML5 `getUserMedia`). Gestione periferiche: fotocamera posteriore su mobile (`facingMode: "environment"`), webcam standard su desktop. Pulsante "Get Info" per scattare.
3. Loader durante l'analisi dell'immagine ("Analyzing artwork...").
4. Schermata Risultati: Mostra l'immagine originale dell'opera (dal DB), Title e Artist. Layout a colonna singola su mobile, a griglia su schermi ampi.
5. Se per Artist o Title esiste una pagina Wikipedia, la stringa è un hyperlink stilizzato che apre un nuovo tab alla pagina Wikipedia in lingua inglese.

## Architettura e Tecnologie

* **Frontend:** Next.js (App Router).
* **Design System:** TailwindCSS (approccio Mobile-First, breakpoint standard `md:`, `lg:`).
* **Database (Mock/Statico):** Script Node.js per estrarre Autore, Titolo e URL immagine dalle pagine:

  * https://www.pkb.ch/en/art-pkb/modern-and-contemporary-art/
  * https://www.pkb.ch/en/art-pkb/reinassance-art-collection/
Output in `art\\\_database.json`. Prevedere logica per scraping da file HTML locali in caso di blocchi lato server.
* **Riconoscimento Immagine (Backend API):** Route API che riceve la foto base64. Chiama OpenAI API (gpt-4o) passando foto e testo di `art\\\_database.json`. Prompt per LLM: "Identify which artwork from this database is in the attached image. Return ONLY a JSON with { artist, title, matchScore }."
* **Integrazione Wikipedia:** API pubbliche Wikipedia (REST API `action=opensearch` o `summary`) lato backend.
* **Generatore QR Code (Utility):** Script Node.js (`generate-qr.js`) con libreria `qrcode`. Accetta stringa URL in input e genera `app-qrcode.png` ad alta risoluzione.

## Regole di Sviluppo

* Lingua dell'app (UI, bottoni, errori, log): esclusivamente Inglese.
* Nessuna allucinazione in Image Matching: se l'API non trova l'opera, restituire l'errore "Artwork not recognized".
* Gestione permessi fotocamera robusta con fallback visivi (es. "Camera access denied. Please enable permissions in your browser settings.").



