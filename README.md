# Balanza — standalone deployment

Losstaande versie van de weekmenu-app. Geen build-stap, geen npm-dependencies
(gebruikt alleen Node's ingebouwde modules) — één server, één API-key.

## Hoe het werkt

- `public/index.html` — de volledige app (ongewijzigd, met een kleine
  compatibiliteitslaag bovenin die `window.claude.use(...)`-aanroepen
  vervangt door gewone `fetch()`-calls naar deze server).
- `server.js` — serveert de app en biedt drie endpoints:
  - `POST /api/generate` — bouwt de AI-prompt zelf op (op basis van ruwe
    voorkeuren die de browser meestuurt, nooit de kant-en-klare prompttekst)
    en stuurt die door naar de Anthropic API met **jouw** API-key, met rate
    limiting en een dagelijks plafond.
  - `GET/POST /api/db` — simpele opslag voor voorkeuren, gerechten en
    planning (per browser, via een anoniem ID in localStorage — geen login).
- `data/store.json` — wordt automatisch aangemaakt; hierin staan alle
  opgeslagen voorkeuren/gerechten/planning én de teller voor het dagplafond.

## Prompt-privacy

De browser stuurt bij het genereren van gerechten alleen ruwe voorkeuren op
(bijv. `{"action":"generate","params":{"goal":"Onderhoud","cuisines":[...]}}`)
naar `server.js` — nooit de volledig samengestelde AI-instructietekst zelf.
Die opbouwlogica (de exacte bewoording, structuur en het JSON-schema dat aan
het model wordt gegeven) staat uitsluitend in `server.js`, dat nooit naar de
browser wordt verstuurd. Wie de Netwerk-tab of de paginabron van de browser
bekijkt, ziet dus alleen losse instellingen — niet de prompt-engineering
zelf.

## Lokaal draaien

```bash
cp .env.example .env
# open .env en vul ANTHROPIC_API_KEY in
node server.js
```

Open daarna `http://localhost:3000` in je browser.

Geen `npm install` nodig — er zijn geen externe dependencies.

## Gerechtfoto's (optioneel)

De app kan een foto bij elk gerecht tonen (in de gerechtenlijst en op het
receptdetailscherm), opgehaald via Unsplash. Dit is optioneel:

1. Maak gratis een Unsplash-developer account op https://unsplash.com/developers
2. Maak een "Application" aan en kopieer de **Access Key**
3. Zet die in `.env` bij `UNSPLASH_ACCESS_KEY=`
4. Herstart de server

Zonder deze sleutel werkt de app gewoon door — dan verschijnen er simpelweg
geen foto's. Foto's worden per gerecht één keer opgehaald en daarna
opgeslagen (in `data/store.json`), dus niet steeds opnieuw aangevraagd.
Unsplash's gratis tier staat 50 aanvragen per uur toe.

## Kostenbeheersing

Twee env-variabelen begrenzen wat de app aan API-kosten kan maken:

- `PER_IP_HOURLY_CAP` (standaard 20) — max. generatie-verzoeken per uur, per IP-adres.
- `DAILY_GENERATE_CAP` (standaard 300) — max. generatie-verzoeken per dag, voor alle gebruikers samen.

Pas deze aan in `.env` op basis van hoeveel mensen je verwacht en welk
kostenniveau je acceptabel vindt. Elke generatie-aanroep kost ruwweg een paar
cent tot een paar dubbeltjes, afhankelijk van hoeveel gerechten er in één
keer worden opgevraagd.

## Blijvende opslag (belangrijk!)

Standaard slaat de server data op in een lokaal bestand
(`data/store.json`). Dat werkt prima op je eigen computer, maar op vrijwel
elk hostingplatform — inclusief Render's gratis laag — wordt het
bestandssysteem **gewist bij elke herstart of redeploy**. Render's gratis
services gaan bovendien na 15 minuten zonder verkeer automatisch "slapen"
en herstarten bij het volgende bezoek — dus zonder verdere actie ben je
vroeg of laat alles kwijt.

De oplossing: verbind de server met een gratis MongoDB Atlas-database, die
wél blijft bestaan. Zonder deze stap werkt de app prima, maar niet-blijvend.

1. Maak een gratis account op https://www.mongodb.com/cloud/atlas/register
2. Maak een nieuw, gratis "M0"-cluster aan (kies een regio bij je gebruikers in de buurt)
3. Ga naar "Database Access" → maak een database-gebruiker aan (naam + wachtwoord)
4. Ga naar "Network Access" → "Add IP Address" → kies "Allow Access from Anywhere" (0.0.0.0/0) — nodig omdat Render's IP-adres kan wisselen
5. Ga naar je cluster → "Connect" → "Drivers" → kopieer de connection string (ziet eruit als `mongodb+srv://gebruiker:wachtwoord@cluster0.xxxxx.mongodb.net/`)
6. Vul je wachtwoord in op de plek van `<password>` in die string
7. Zet die complete string in `.env` (lokaal) of als environment variable op Render, bij `MONGODB_URI`

Zodra `MONGODB_URI` is ingesteld, herkent de server dat automatisch en
gebruikt hij MongoDB in plaats van het lokale bestand — er is verder niets
aan te passen. Zonder `MONGODB_URI` valt de server terug op het lokale
bestand (prima voor snel lokaal testen, niet voor een echte deployment).

## Belangrijk: dit is een eenvoudige, persoonlijke opzet

- **Geen accounts/login.** Elke browser krijgt bij het eerste bezoek een
  anoniem ID (opgeslagen in localStorage). Wist iemand zijn browserdata, dan
  is hij zijn opgeslagen gerechten en planning kwijt. Voor een klein aantal
  bekende gebruikers is dit prima; voor een grotere, publieke uitrol zou je
  echte accounts willen toevoegen.
- **De rate limiter voor IP-adressen is in-memory** en reset bij elke
  herstart van de server (de dagelijkse generatielimiet zelf staat wél veilig
  in MongoDB als je dat hebt ingesteld, en overleeft dus herstarts).

## Progressive Web App (PWA)

De app is een volwaardige PWA: een manifest, iconen en een service worker
zijn al ingebouwd (`public/manifest.json`, `public/sw.js`,
`public/icons/`). Zodra de app **via HTTPS** bereikbaar is (zie hieronder),
kan iedereen hem op zijn telefoon "installeren":

- **Android/Chrome**: browser toont vanzelf een install-prompt, of via het
  menu (⋮) → "App installeren"
- **iPhone/Safari**: deel-icoon → "Zet op beginscherm" (Safari ondersteunt
  geen automatische install-prompt, dit is de iOS-manier om hetzelfde te
  bereiken)

Eenmaal geïnstalleerd opent de app als een losse app-icoon, zonder
browserbalk.

**Belangrijk**: service workers (en dus installeerbaarheid als PWA) werken
alleen over **HTTPS** — op `localhost` werkt het ook zonder HTTPS (voor
lokaal testen), maar zodra je live zet moet het via een `https://`-adres
lopen. Elk van de onderstaande hostingopties (Render, Railway, Fly.io)
regelt HTTPS automatisch voor je.

## Een select groepje laten testen

Voor een kleine testgroep is dit de snelste route:

1. Deploy naar **Render.com** (gratis tier, zie hieronder) — je krijgt een
   `https://jouwapp.onrender.com`-achtige URL.
2. Stuur die link naar je testers. Ze openen hem in hun eigen browser en
   kunnen hem meteen als app installeren (zie hierboven).
3. Iedereen krijgt automatisch zijn eigen, aparte set voorkeuren/gerechten/
   planning — er is geen gedeelde data tussen testers.
4. Stel `MONGODB_URI` in (zie "Blijvende opslag" hierboven) zodat niemands
   data verdwijnt als de server een keer herstart.

## Deployen

Elk platform dat een Node.js-proces kan draaien werkt. Twee simpele opties:

### Render.com (gratis tier, makkelijkst)
1. Zet deze map in een git-repository (GitHub/GitLab).
2. Maak op Render een nieuwe "Web Service", koppel de repo.
3. Build command: `npm install`
4. Start command: `node server.js`
5. Zet de environment variables uit `.env.example` in Render's dashboard
   (Settings → Environment) — vergeet `MONGODB_URI` niet voor blijvende opslag.

### Railway.app / Fly.io
Werken ook prima. Met `MONGODB_URI` ingesteld maakt het niet uit of het
platform zelf een blijvend bestandssysteem heeft — de data staat toch al
in MongoDB, niet lokaal.

### Eigen VPS
```bash
git clone <jouw-repo>
cd weekmenu-app
cp .env.example .env   # vul in
node server.js         # of gebruik pm2/systemd om het als service te draaien
```

## Volgende stappen (optioneel)

- **Echte database**: vervang het JSON-bestand door SQLite of Postgres zodra
  je meer gelijktijdige gebruikers verwacht.
- **Login/accounts**: als je wilt dat mensen hun gegevens ook op een ander
  apparaat terugzien, is een echt account-systeem nodig — nu is alles aan de
  browser gekoppeld.
- **Bring-your-own-key**: als de kosten voor jou te hoog worden bij meer
  gebruikers, kan er een instellingenscherm bij komen waar elke gebruiker
  zijn eigen API-key invult (zie eerdere toelichting in de chat) — dat is
  een grotere aanpassing van zowel de server als de frontend.
