# Balanza — standalone deployment

Losstaande versie van de weekmenu-app. Geen build-stap, geen npm-dependencies
(gebruikt alleen Node's ingebouwde modules) — één server, één API-key.

## Hoe het werkt

- `public/index.html` — de volledige app (ongewijzigd, met een kleine
  compatibiliteitslaag bovenin die `window.claude.use(...)`-aanroepen
  vervangt door gewone `fetch()`-calls naar deze server).
- `server.js` — serveert de app en biedt drie endpoints:
  - `POST /api/generate` — stuurt een prompt door naar de Anthropic API met
    **jouw** API-key, met rate limiting en een dagelijks plafond.
  - `GET/POST /api/db` — simpele opslag voor voorkeuren, gerechten en
    planning (per browser, via een anoniem ID in localStorage — geen login).
- `data/store.json` — wordt automatisch aangemaakt; hierin staan alle
  opgeslagen voorkeuren/gerechten/planning én de teller voor het dagplafond.

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

## Belangrijk: dit is een eenvoudige, persoonlijke opzet

- **Geen accounts/login.** Elke browser krijgt bij het eerste bezoek een
  anoniem ID (opgeslagen in localStorage). Wist iemand zijn browserdata, dan
  is hij zijn opgeslagen gerechten en planning kwijt. Voor een klein aantal
  bekende gebruikers is dit prima; voor een grotere, publieke uitrol zou je
  echte accounts willen toevoegen.
- **`data/store.json` is een simpel JSON-bestand,** geen echte database.
  Prima voor persoonlijk gebruik of een kleine test, maar niet gemaakt voor
  veel gelijktijdige gebruikers. Voor meer schaal: vervang de
  `loadStore()`/`saveStore()`-functies in `server.js` door een echte database
  (bijv. SQLite of Postgres) — de rest van de server hoeft niet te veranderen.
- **De rate limiter is in-memory** en reset bij elke herstart van de server.
  Prima voor "voor nu"-gebruik; bij hoge verwachte belasting zou je dit naar
  de database willen verplaatsen zodat het herstarts overleeft.

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
4. Wil je zelf kunnen zien hoeveel de testgroep de app gebruikt? Kijk in
   `data/store.json` op de server — daar staat alles in (let op: bij de
   gratis Render-tier kan dit bestand verdwijnen bij een herstart, zie de
   opmerking daarover verderop).

## Deployen

Elk platform dat een Node.js-proces kan draaien werkt. Twee simpele opties:

### Render.com (gratis tier, makkelijkst)
1. Zet deze map in een git-repository (GitHub/GitLab).
2. Maak op Render een nieuwe "Web Service", koppel de repo.
3. Build command: (leeg laten — geen build nodig)
4. Start command: `node server.js`
5. Zet de environment variables uit `.env.example` in Render's dashboard
   (Settings → Environment).
6. **Let op:** de gratis tier van Render heeft een *ephemeral* filesystem —
   `data/store.json` kan verdwijnen bij een herstart/redeploy. Voor iets
   persistenter: kies een betaald plan met een "Persistent Disk", of
   gebruik Railway/Fly.io met een volume.

### Railway.app / Fly.io (met persistente opslag)
Beide platforms bieden een volume die je aan `/app/data` kunt koppelen, zodat
`store.json` blijft bestaan tussen deploys. Stappen zijn platform-specifiek;
de app zelf heeft geen aanpassingen nodig — alleen de env-variabelen instellen
en een volume mounten op de `data/`-map.

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
