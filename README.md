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

## Accountmenu (voor gebruikers)

Rechtsboven in de app staat de avatar met de voornaam van de gebruiker (bij geen naam: het begin
van het e-mailadres, of "Gast" bij een anoniem profiel). Tikken opent het accountmenu:

- **Kop:** naam, e-mailadres (of "Anoniem profiel · alleen op dit apparaat") en de link **Mijn profiel**.
- **Account aanmaken** (alleen voor anonieme gebruikers, en alleen als "Nieuwe accounts" aan staat).
- **Mijn voorkeuren**, **Instellingen**, **Lichte/Donkere weergave**, **Mijn gegevens downloaden**,
  **Hoe werkt Balanza**.
- **Reset app — begin opnieuw** (met bevestiging) en **Uitloggen** (alleen als je bent ingelogd).

Het menu sluit met Escape of door ernaast te tikken. De knoppen "Reset app" en "Uitloggen" staan
daarom niet meer onderaan het startscherm.

**Mijn profiel:** grote avatar, naam, e-mailadres, aantallen (gerechten, weken planning, gedeelde
lijsten), sinds wanneer je lid bent, en de naam wijzigen. Anonieme gebruikers krijgen een uitnodiging
om een account aan te maken.

**Instellingen:**

| Onderdeel | Wat het doet |
| --- | --- |
| Weergave | Donker of licht thema (wordt onthouden). |
| Wachtwoord wijzigen | Vraagt het huidige wachtwoord. Daarna ben je op alle andere apparaten uitgelogd; dit apparaat blijft ingelogd. |
| E-mailadres wijzigen | Vraagt het wachtwoord. Alle gegevens blijven van hetzelfde account; andere apparaten worden uitgelogd. |
| Uitloggen op andere apparaten | Beëindigt alle andere sessies; dit apparaat blijft ingelogd. |
| Mijn gegevens downloaden | Een JSON-bestand met voorkeuren, gerechten, planning en gedeelde lijsten (nooit met wachtwoordgegevens). Werkt ook anoniem. |
| Reset app | Wist gerechten, voorkeuren en planning; het account blijft. |
| Account verwijderen | Vraagt het wachtwoord en het woord `VERWIJDEREN`. Wist het account, alle gegevens en de gedeelde lijsten definitief. |

Alles wat een wachtwoord controleert (wijzigen, e-mailadres, verwijderen) is begrensd tot 20
pogingen per uur per IP-adres. Een verkeerd wachtwoord geeft een melding in het formulier en logt
je niet uit. Een resetlink hoort bij één account: is een e-mailadres gewijzigd en later aan iemand
anders gegeven, dan werkt een oude resetlink daar niet op.

Voor beheerders staan deze acties in het logboek (Activiteit) met duidelijke namen: wachtwoord
gewijzigd, e-mailadres gewijzigd, op andere apparaten uitgelogd, account zelf verwijderd en gegevens gedownload.

## Beheer (admin)

Op `/admin` staat de beheerconsole. Je logt in met `ADMIN_PASSWORD`. Kies er een van
minstens 12 tekens: een korter wachtwoord werkt wel, maar het overzicht en het tabblad
Systeem tonen dan een aandachtspunt. Is er helemaal geen wachtwoord ingesteld, dan kun je
niet inloggen. Na 10 mislukte pogingen vanaf één IP-adres in 15 minuten wordt dat
adres tijdelijk geweigerd. De sessie blijft alleen in het browsertabblad bewaard.
Het wachtwoord wijzig je in de omgevingsvariabelen van je host (bijvoorbeeld Render).

Alle wijzigingen gelden direct, zonder herstart.

| Tabblad | Wat je er doet |
| --- | --- |
| **Overzicht** | Kengetallen (gebruikers, actief, nieuw, generaties tegen de daglimiet, fouten, reactietijd, inloggen), grafieken van de laatste 14 dagen, laatste fouten, welke onderdelen aan staan, aandachtspunten. |
| **Gebruikers** | Zoeken, filteren, sorteren en bladeren; gebruikers aanmaken, wijzigen, blokkeren, exporteren, wissen en verwijderen, ook meerdere tegelijk. |
| **Activiteit** | Het verzoeklogboek met zoeken en filters (soort, uitkomst, actie, gebruiker, IP, datum, minimale duur) en CSV-export. |
| **Gedeelde lijsten** | Alle gedeelde boodschappenlijsten bekijken, verwijderen, en verlopen lijsten opruimen. |
| **Instellingen** | Inloggen verplicht, onderdelen aan/uit, limieten, onderhoudsmodus en een mededeling aan alle gebruikers. |
| **Auditlog** | Wie deed wat, wanneer en vanaf welk IP-adres. Bij instellingen staat wat er veranderde (van, naar). Wachtwoorden komen hier nooit in. |
| **Systeem** | Gezondheidscontroles (opslag, AI-sleutel, beheerderswachtwoord, sessiegeheim, optionele koppelingen), serverinfo en de geldende limieten. |

### Inloggen verplicht

- **Uit (standaard):** de app werkt zonder account; elke browser krijgt een anoniem profiel
  (ID met prefix `anon_`). Accounts blijven afgeschermd: alleen `anon_`-ID's worden zonder
  inlog geaccepteerd. Wie al is ingelogd, blijft gewoon zijn eigen account gebruiken.
- **Aan:** bezoekers moeten een account aanmaken of inloggen. Anonieme gebruikers zien het
  inlogscherm; bij het aanmaken van een account kunnen ze hun bestaande gegevens meenemen
  (zie "Anoniem omzetten naar een account"). De console vraagt hier eerst om bevestiging.
- Kan de instelling door een opslagfout niet worden gelezen, dan geldt veilig: inloggen verplicht.

### Anoniem omzetten naar een account

Wie de app anoniem gebruikt, kan zichzelf omzetten naar een account en houdt al zijn gegevens:
voorkeuren, opgeslagen gerechten, weekplanning en gedeelde lijsten.

- **In de app:** op het startscherm staat voor anonieme gebruikers de tegel "Account aanmaken"
  (e-mailadres, wachtwoord en herhaling). Na afloop is de gebruiker ingelogd op dat apparaat
  en ziet hij precies wat er is meegenomen. Op een ander apparaat logt hij in met dezelfde gegevens.
- **Als inloggen verplicht is geworden:** kiest iemand op het inlogscherm voor "Account
  aanmaken" en staan er nog gegevens van dit apparaat, dan verschijnt een keuzevakje (standaard
  aan) om die mee te nemen. Inloggen op een bestaand account voegt nooit stilletjes gegevens samen.
- **Hoe het werkt:** een anoniem profiel bewijst zich met zijn ID. Bij het omzetten
  worden de gegevens naar een nieuw account-ID verhuisd (een account-ID werkt nooit als anoniem ID)
  en van het anonieme ID gewist. Gedeelde lijsten blijven bereikbaar via dezelfde link en
  horen daarna bij het account. De notitie van de beheerder gaat mee.
- **Herstelbaar:** onderbreekt de verbinding halverwege, dan kan de gebruiker het gewoon nog
  eens met dezelfde gegevens proberen; dat maakt het af zonder iets dubbel te doen of te overschrijven.
- **Beperkingen:** een geblokkeerd anoniem profiel kan zich niet omzetten. Staat "Nieuwe accounts"
  uit, of de onderhoudsmodus aan, dan is omzetten ook uit. Er geldt een grens van 30 pogingen per uur per IP-adres.
- **In het beheer:** omgezette accounts hebben de aanduiding "eerst anoniem" (met het oude ID op
  de gebruikerspagina), de actie staat in het logboek als "Anoniem omgezet naar account" en telt
  mee als nieuwe registratie.

### Onderdelen aan of uit

Negen onderdelen zijn los te schakelen. Een uitgezet onderdeel verdwijnt uit de app
(de knoppen worden verborgen) en, waar aangegeven, weigert ook de server het.

| Onderdeel | Afgedwongen door | Wat er gebeurt als het uit staat |
| --- | --- | --- |
| Gerechten genereren | server | De knop is uitgeschakeld met een uitleg; de server weigert nieuwe generaties. |
| Kostenschatting | server | De knop 'Schat de kosten' verdwijnt. |
| Tips tijdens het wachten | server | Er worden geen tips opgehaald. |
| Gerechtfoto's | server | Geen foto's; de app vraagt er ook niet meer naar. |
| Lijsten delen | server | De opties voor delen verdwijnen; tekst versturen of kopiëren blijft kunnen. |
| Importeren in Bring! | server | De Bring!-optie verdwijnt (Bring! werkt via een gedeelde lijst). |
| PDF-export | alleen in de app | De PDF-knoppen verdwijnen. |
| Nieuwe accounts | server | Registreren en het omzetten van een anoniem profiel kunnen niet; het inlogscherm legt dat uit. |
| Wachtwoord vergeten | server | De link verdwijnt; de server antwoordt neutraal, zonder e-mail te sturen. |

### Onderhoudsmodus en mededeling

- **Onderhoudsmodus** zet tegelijk uit: genereren, kostenschatting, tips, delen, Bring! en
  registreren. Foto's, PDF en wachtwoord-reset blijven werken. Gebruikers zien bovenin de app
  jouw melding; die kunnen ze niet wegklikken. Het overzicht toont een snelle knop om de modus uit te zetten.
- **Mededeling** is een balk bovenin de app (informatie of waarschuwing). Gebruikers kunnen hem
  per bericht wegklikken, tot ze de app sluiten. Staat er ook onderhoud aan, dan gaat de
  onderhoudsmelding voor. De app haalt de instellingen opnieuw op als iemand terugkomt
  (hooguit één keer per minuut).

### Limieten

Vier limieten beschermen je AI-tegoed en zijn live aan te passen (0 blokkeert helemaal):
generaties per dag en per uur per IP, tip-verzoeken per dag en per uur per IP. De
omgevingsvariabelen `DAILY_GENERATE_CAP`, `PER_IP_HOURLY_CAP`, `DAILY_TIPS_CAP` en
`TIPS_PER_IP_HOURLY` bepalen de beginwaarden.

### Gebruikers beheren

- **Aanmaken:** e-mailadres, optioneel een wachtwoord (laat je het leeg, dan maakt de console
  een sterk wachtwoord dat je één keer te zien krijgt), naam, doel, dieet en een notitie die
  alleen beheerders zien. Optioneel wordt een link gestuurd waarmee de gebruiker zelf een
  wachtwoord kiest; dat mailen werkt alleen met `RESEND_API_KEY`. Zonder mailkoppeling krijg
  je de link om zelf door te geven.
- **Wijzigen:** e-mailadres, naam, notitie, wachtwoord en alle voorkeuren (alleen gewijzigde
  velden worden opgeslagen). Een wachtwoord kun je nooit terugzien, alleen vervangen.
- **Blokkeren:** de gebruiker kan niet meer inloggen en lopende sessies stoppen; de gegevens
  blijven bewaard. Optioneel met een reden (alleen voor jou).
- **Sessies:** een wachtwoord- of e-mailwijziging en 'overal uitloggen' beëindigen alle
  lopende sessies van die gebruiker. Ook bij een verwijderd account blijven oude sessies
  ongeldig.
- **Exporteren, wissen, verwijderen:** een JSON-export van alle gegevens; wissen van gerechten,
  weekplanning of voorkeuren (het account blijft); of definitief verwijderen. Verwijderen vraagt
  dat je het e-mailadres (of het ID) exact intypt.
- **Meerdere tegelijk:** blokkeren, deblokkeren, uitloggen of verwijderen voor maximaal 200
  gebruikers; verwijderen vraagt om het woord `VERWIJDEREN`.

### Logboeken

- Het verzoeklogboek bewaart de laatste 5.000 regels, het auditlog de laatste 3.000; oudere
  regels worden vanzelf opgeruimd. De CSV-export volgt de gekozen filters en is beveiligd
  tegen formule-injectie in spreadsheets.
- De instellingen en de lijst met geblokkeerde accounts staan in de database
  (`settings/app`, `settings/blocked`). Zonder MongoDB gaan ze, net als alle andere
  gegevens, verloren bij een herstart: zie "Blijvende opslag".

## Lokaal draaien

```bash
cp .env.example .env
# open .env en vul ANTHROPIC_API_KEY in
node server.js
```

Open daarna `http://localhost:3000` in je browser.

Geen `npm install` nodig — er zijn geen externe dependencies.

## Delen en exporteren (menu) en "Niet nodig"

**Menu.** Op het boodschappenscherm zit één knop, **Delen en exporteren**, die een menu opent met alle opties:

- *Deel via WhatsApp* — live lijst met een link waarmee jullie samen afvinken (daar kun je de link ook kopiëren)
- *Stuur als tekst via WhatsApp*, *Kopieer als tekst* en (waar het apparaat het kent) *Deel via een andere app…* — een
  gewoon lijstje zonder link of account; alleen wat nog nodig is
- *Importeer in Bring!* en *Exporteer als PDF*

**Niet nodig.** Bij elk product (in de weekweergave én per dag) staat altijd een knop **Niet nodig**; tikken op de regel
of op **Toch nodig** maakt het weer nodig. Uitgesloten producten worden doorgestreept en tellen niet mee bij: de
tekst-opties, de PDF, de kostenschatting, delen (je vrouw ziet ze als "niet nodig"; zie hieronder) en de Bring!-import.
In de dagweergave geldt het voor het hele product (dus ook in het andere gerecht en in de weekweergave). Bovenaan staat
een regel met het aantal en **Alles weer nodig**.

- De keuze wordt per lijst (week of planning) op dit apparaat bewaard (`localStorage`, maximaal 40 lijsten) en overleeft
  dus herstarten. Bij een gedeelde lijst geldt de gedeelde stand; die wordt lokaal gespiegeld, zodat het ook klopt als je
  later stopt met delen. "Alles wissen" wist ook deze keuzes.
- Bij het delen en bijwerken stuurt de app de stand mee. De server neemt die alleen over voor **nieuwe** producten;
  producten die al op de gedeelde lijst staan, houden hun stand, zodat een update nooit overschrijft wat je vrouw net
  afvinkte.

## Boodschappenlijst delen (WhatsApp)

Op het boodschappenscherm staat de knop **Deel via WhatsApp**. Die maakt een momentopname van de
(samengevoegde) lijst op de server en geeft een lange, willekeurige link (`/l/<code>`, 128 bit).
WhatsApp opent met een kant-en-klaar bericht; de link toont een voorbeeldkaart met de titel.

- **Ontvanger:** opent de link (geen account nodig), ziet de lijst per categorie en tikt per product op
  **in mandje** (cirkel of tekst) of **Niet nodig**. Voortgang, filter "Nog te doen" en "Alle vinkjes
  wissen" zitten op de pagina. De vinkjes staan op de server, dus jullie zien elkaars stand (elke
  8 seconden ververst). Zonder bereik in de winkel blijven wijzigingen bewaard en gaan ze mee zodra er
  weer bereik is; de pagina opent ook zonder bereik uit het geheugen van de telefoon.
- **Aanpassingen gaan vanzelf mee:** wijzig je het plan (gerecht erbij of eraf, andere porties), dan werkt
  de app de gedeelde lijst na ongeveer 5 seconden rust op de achtergrond bij (alleen terwijl de app openstaat,
  ook buiten het boodschappenscherm; dezelfde link, alle vinkjes blijven staan). De ontvanger ziet dat in het
  product zelf: **Nieuw** of **Aangepast**, bij een aangepast product ook wat het eerst was ("was: 250 g
  zalmfilet") en hoe lang geleden ("zojuist", "15 min geleden"). Bovenaan staat een melding met wat er
  aangepast is en wat niet meer nodig is. Een markering blijft 12 uur staan, of tot het product is aangetikt
  of op **Oké** is gedrukt; wijzigt het product opnieuw, dan komt de markering terug (met de oorspronkelijke
  "was"). Wat er veranderd is bepaalt de server, dus je ziet het ook als je de link pas daarna opent. Bij de
  maker staat dezelfde markering 5 minuten. Bestaat de gedeelde lijst niet meer, dan maakt de app er nooit
  stilletjes een nieuwe voor aan.
- **Maker:** werkt met dezelfde lijst, live, in de app (bij "Per week"): vinkjes van de ander verschijnen
  vanzelf en jouw eigen tikken (ook **Niet nodig**) gaan naar de ander. Zonder bereik wachten jouw tikken en
  gaan ze later mee. Onder de knop staat de stand ("3 in mandje · 1 niet nodig · 1 nog te doen"). Wijkt de
  lijst in de app af van wat gedeeld is (bijvoorbeeld door een aangepast plan), dan verschijnt **Bijwerken**:
  dezelfde link wordt bijgewerkt en alle vinkjes blijven staan. Producten die nog niet gedeeld zijn, vink je
  lokaal af. Bij **Stoppen** blijft wat jullie hadden afgevinkt in je eigen lijst staan. In de weergave "Per dag"
  worden vinkjes niet gedeeld (daar staat een korte uitleg). Overal geldt: bij twee tikken op hetzelfde
  product tegelijk wint de laatste.
- **Beveiliging:** wie de link heeft, kan de lijst zien en afvinken (dat is de bedoeling); alleen de maker
  kan de inhoud bijwerken of het delen stoppen. In de lijst staat nooit een naam of e-mailadres. De pagina
  is `noindex` en stuurt geen referrer mee.
- **Limieten:** maximaal 300 producten per lijst, 20 lijsten per persoon (de oudste vervalt), 30 nieuwe
  lijsten en 300 bijwerkingen per uur per IP-adres. Lijsten verlopen 30 dagen na de laatste wijziging.
- **Opslag:** de lijsten staan in dezelfde database als de rest (`lists/<code>`). Zonder `MONGODB_URI` gaan
  ze verloren bij een herstart van de server; met MongoDB blijven ze bewaard.

## Importeren in Bring!

Op het boodschappenscherm staat de knop **Importeer in Bring!**. Dit gebruikt de officiële "web-to-app"-import
van Bring! (zie de Bring! Import Developer Guide):

0. **De eerste keer** vraagt de app om de link van jouw eigen Bring!-lijst. Zonder die link kun je niet verder. De
   link staat niet in de code: hij wordt bij jouw voorkeuren bewaard (dus ook op je andere apparaten, als je
   ingelogd bent), en je kunt hem wijzigen via **Wijzigen** op het boodschappenscherm of het veld "Link naar je
   Bring!-lijst" bij Voorkeuren (leeg maken verwijdert hem). Alleen https-links worden geaccepteerd; een adres
   waar geen "bring" in voorkomt krijgt eerst een waarschuwing ("Toch opslaan"). Op het boodschappenscherm staat
   daarna een regel "Jouw Bring!-lijst" met **Openen**. Let op: die link is voor jou; de import zelf kiest de lijst
   in de Bring!-app (zie onder).
1. De app zet je lijst online onder dezelfde geheime link als bij delen (bestaat die al, dan wordt hij bijgewerkt).
2. Je tikt op **Open in Bring!**. Dat opent `https://api.getbring.com/rest/bringrecipes/deeplink?url=<pagina>&source=web`.
3. Bring! haalt de pagina zelf op en opent de app om de producten te importeren. Doe dit dus op het apparaat
   waar Bring! op staat. De app moet op een openbaar bereikbaar https-adres draaien (dus niet op localhost).

- **Pagina's die Bring! ophaalt:** `/l/<code>/bring` (HTML met schema.org-markup, `itemprop="ingredients recipeIngredient"`,
  het formaat dat Bring! aanraadt) en `/l/<code>/bring.json` (JSON-bestand met `items` van `{ itemId, spec }`; door
  Bring! "niet aanbevolen" genoemd, maar eenduidig). Werkt de eerste niet goed in Bring!, dan is er **Andere methode**.
- **Alleen wat nog gekocht moet worden:** producten die al in het mandje liggen of op "niet nodig" staan, blijven weg
  (actueel op het moment dat Bring! de pagina ophaalt). Met `?alle=1` achter het adres komt alles mee.
- **Naam en hoeveelheid** worden apart doorgegeven ("250 g" + "zalmfilet"); "2x uien" wordt "2 uien".
- **Import-adres van Bring!:** dit staat niet in de app. De server geeft het door via `/api/config`; standaard het
  openbare adres uit de Bring! Import Developer Guide, te overschrijven met de omgevingsvariabele
  `BRING_IMPORT_ENDPOINT` (zie `.env.example`).
- **CORS:** `bring.json` mag alleen door `*.getbring.com` vanuit een browser worden opgehaald.
- **Beperking:** Bring! staat via deze import alleen toe dat jij het in de app bevestigt. In de documentatie is geen
  manier om zonder de app rechtstreeks in een bepaalde (gedeelde) Bring!-lijst te schrijven. Welke lijst het wordt,
  bepaal je in de Bring!-app.

## Wachtcarrousel met tips

Tijdens het genereren toont het startscherm een carrousel met weetjes en tips
(elke 8 seconden een nieuwe).

- De tips worden in pakketjes van 8 door de AI geschreven (`POST /api/tips`),
  afgestemd op het gekozen doel en de voedingsstijl, en steeds over andere
  onderwerpen. Al getoonde tips worden onthouden en niet herhaald.
- Er wordt alleen om nieuwe tips gevraagd terwijl de carrousel in beeld is:
  ongeveer één klein verzoek per minuut, met een maximum van 10 pakketjes per keer.
- Lukt het ophalen niet (of duurt het te lang), dan valt de carrousel terug op een
  handgeschreven lijst van 36 tips; de app blijft gewoon werken.
- Tips hebben een eigen, ruimere limiet (`TIPS_PER_IP_HOURLY`, `DAILY_TIPS_CAP`) en tellen
  niet mee voor de generatielimiet. Met `ANTHROPIC_TIPS_MODEL` kun je een ander model kiezen.
- Op de kaart staat "Algemene informatie, geen medisch advies". Let op: tips die het model schrijft kunnen
  fouten bevatten; de kaart zegt niet dat ze door een model zijn geschreven.

## Kosten, tokens en de maandlimiet

Voordat je een prijs kiest wil je weten wat een gerecht je kost, en wie er veel gebruikt. Daarvoor legt de server
van elke AI-aanroep het aantal tokens vast en rekent de kosten uit. Bovendien kun je het aantal **nieuwe gerechten
per gebruiker per maand** begrenzen. Dat is de basis voor een gratis en een betaald niveau.

**Wat er wordt vastgelegd.** Per verzoek: tokens in en uit, het aantal AI-aanroepen, de kosten in dollars en het aantal
gerechten. Dat staat in het logboek (*Activiteit*, bijv. "2,0k in · 5,0k uit · $0,081 · 7 gerechten") en wordt opgeteld
per gebruiker per maand en per dag per actie. Twee dingen zijn goed om te weten:

- **Herhaalpogingen tellen mee.** Haalt een gerecht de Balans-score niet, dan wordt het tot 3 keer opnieuw gemaakt, en
  elk maaltijdmoment is een eigen aanroep. Eén generatie kan dus 3 tot 12 aanroepen zijn. Het overzicht toont
  "AI-aanroepen per generatie" zodat je dat ziet.
- **Ook mislukte pogingen kosten iets.** Een antwoord dat niet te gebruiken was is wél betaald. Dat staat als fout in
  het logboek mét de kosten, en telt mee bij de kosten per gerecht (maar niet bij de gerechten van de gebruiker).

**In de beheerconsole.** *Overzicht* heeft een kaart "AI-kosten deze maand" en een kaart "AI-kosten en tokens": vandaag,
deze maand, de laatste 30 dagen, de gemiddelde **kosten per gerecht**, de kosten per actie en een grafiek per dag.
Bij elke gebruiker staat onder "Verbruik deze maand" wat hij verbruikte en kostte, zodat je ziet wie de zware
gebruikers zijn.

**De prijs.** De kosten worden berekend met `PRICE_IN_PER_M` en `PRICE_OUT_PER_M` (dollars per miljoen tokens). Standaard
staat dat op de prijs van Claude Sonnet 4.6: **$3 en $15**. Gebruik je een ander model, pas ze dan aan. De tips kunnen een
goedkoper model gebruiken (`ANTHROPIC_TIPS_MODEL`); geef dan de prijs op met `TIPS_PRICE_IN_PER_M` en
`TIPS_PRICE_OUT_PER_M`. Het is een schatting uit de tokens die Anthropic per aanroep meldt: de factuur is leidend.

**De maandlimiet.**

| Wat | Hoe |
|---|---|
| Algemene limiet | Beheer → Instellingen → Limieten → "Nieuwe gerechten per gebruiker per maand", of `MONTHLY_DISH_CAP` in `.env`. **0 = onbeperkt en dat is de standaard**, dus er verandert niets tot je een getal invult. |
| Eigen limiet | Bij een gebruiker: "Eigen limiet per maand voor deze gebruiker". Gaat voor de algemene. 0 = onbeperkt voor die gebruiker; leeg = de algemene geldt. Zo geef je bijvoorbeeld een betalende gebruiker meer. |
| Wat telt mee | Nieuwe gerechten uit "Genereer gerechten" en "Vul week automatisch in", en een variatie op een gerecht (telt als 1). Prijzen, prepdag, tips, delen en alles met opgeslagen gerechten blijft altijd werken. |
| Op de limiet | De app toont "Nog 3 van 10 nieuwe gerechten deze maand" bij het genereren en in Mijn profiel. Is het op, dan staat de knop uit en staat er vanaf welke datum het weer kan. De server weigert ook zelf (429, `quota_exceeded`). |
| Nieuwe maand | De teller begint op de 1e van de maand weer op 0 (UTC, dus in Nederland rond 01:00 of 02:00 's nachts). |
| Laatste generatie | Zit je onder de limiet, dan mag de generatie die je nu start helemaal af, ook al kom je daardoor erboven (bijv. 14 van 10). Zo krijg je nooit een half resultaat. Lopende opdrachten op de achtergrond tellen mee bij het beoordelen van de volgende. |
| Omzetten naar een account | Het verbruik gaat mee. Je reset de teller dus niet door een account te maken. |

**Bekende grenzen.** Een anoniem profiel is aan dit toestel gebonden: wie zijn browsergegevens wist begint opnieuw. De limiet
per IP-adres per uur (`PER_IP_HOURLY_CAP`) en de daglimiet voor iedereen samen blijven daarom belangrijk. Een gebruiker die
zijn account verwijdert en met een ander e-mailadres opnieuw begint, heeft weer een lege teller. Dit is bedoeld als
kostenbeheersing en als basis voor een betaald niveau, niet als waterdichte beveiliging.

## Betalingen en abonnementen (Balanza Plus)

**Voorbereid en standaard uit.** Zolang je het niet aanzet is er in de app niets van te zien, verandert er niets voor
gebruikers en doet de server niets met Mollie. Het idee: gratis heeft een beperkt aantal nieuwe gerechten per maand
(zie "Kosten, tokens en de maandlimiet"), Plus heeft er meer. Alles wat geen AI kost blijft voor iedereen gratis.

**Zo werkt het voor de gebruiker.** In *Mijn profiel* staat een kaart "Balanza Plus" met de prijzen (per maand of per jaar,
incl. btw), een vinkje om akkoord te gaan met de voorwaarden en de knop "Word Plus". Die stuurt naar de betaalpagina van
Mollie (iDEAL of kaart). Terug in de app wacht Balanza even tot de betaling bevestigd is en meldt "Welkom bij Plus!". Een
abonnee ziet tot wanneer Plus loopt en kan met één knop opzeggen. Plus is alleen voor accounts, niet voor anonieme profielen.

**Zo werkt het achter de schermen.**

1. *Eerste betaling.* De server maakt een Mollie-klant en een betaling met `sequenceType: first`. Daarmee geeft de klant
   toestemming voor vervolgbetalingen (bij iDEAL wordt dat een SEPA-machtiging).
2. *Abonnement.* Is die betaling geslaagd, dan maakt de server bij Mollie een abonnement dat pas na de eerste periode begint,
   want de eerste betaling was al de eerste maand of het eerste jaar.
3. *Webhook.* Mollie meldt elke wijziging aan `/api/billing/webhook`. Zo'n melding bevat **alleen een betaal-id, zonder
   handtekening**. Daarom haalt de server de betaling zelf bij Mollie op en gelooft alleen wat Mollie dan zegt. Een nagemaakte
   melding kan dus nooit Plus geven. Elke betaling wordt bovendien gekoppeld aan de Mollie-klant die wij zelf hebben
   aangemaakt, en het bedrag wordt gecontroleerd. Herhaalde meldingen doen niets dubbel.
4. *Ook zonder webhook.* Komt de gebruiker terug op de app, dan haalt de app zelf de status van een lopende betaling op.

| Situatie | Wat er gebeurt |
|---|---|
| Vervolgbetaling geslaagd | Plus loopt een periode langer. |
| Vervolgbetaling mislukt | Status "past_due": Plus blijft tot het einde van de betaalde periode, de gebruiker ziet een melding en kan opnieuw afsluiten. De app probeert het niet zelf opnieuw. |
| Opzeggen | Het abonnement wordt bij Mollie opgezegd. Plus blijft tot het einde van de betaalde periode. Lukt opzeggen bij Mollie niet, dan blijft alles zoals het was en krijgt de gebruiker een duidelijke fout, zodat hij weet dat hij nog betaalt. |
| Terugboeking of volledige terugbetaling | Het abonnement wordt opgezegd en Plus stopt meteen. Een gedeeltelijke terugbetaling doet niets. |
| Account verwijderen | **Eerst wordt het abonnement bij Mollie opgezegd.** Lukt dat niet, dan wordt het account niet verwijderd (anders blijft er geld worden afgeschreven). Geldt ook als jij als beheerder een gebruiker verwijdert. |
| Betaald maar Mollie faalt bij het aanmaken van het abonnement | De klant heeft betaald en krijgt Plus. De fout wordt vastgelegd en het abonnement wordt alsnog aangemaakt zodra de gebruiker de app opent. |
| Coulance | Plus loopt nog 5 dagen door na het einde van de periode: een incasso kan een paar dagen duren en een betalende klant mag er niet tussenuit vallen. |
| Abonnementen uitzetten | Gebruikers zien niets meer en krijgen de Plus-limiet niet meer. Bestaande abonnementen lopen bij Mollie door en binnenkomende betalingen worden nog verwerkt. |

**Instellen, stap voor stap.**

1. Maak een Mollie-account. Een **testsleutel** (`test_…`) heb je direct; voor echte betalingen moet Mollie je bedrijf
   eerst goedkeuren.
2. Zet in je Mollie-profiel de betaalmethoden aan die herhaald afschrijven ondersteunen. Betalen met iDEAL werkt daarvoor via
   een SEPA-machtiging, dus schakel **SEPA-incasso** ook in.
3. Zet twee variabelen in de omgeving (`.env`, of bij Render onder Environment):
   - `MOLLIE_API_KEY`: je sleutel. Begin met de testsleutel.
   - `PUBLIC_BASE_URL`: het adres van je app, bijvoorbeeld `https://balanza-app.onrender.com`, **zonder slash aan het eind**.
     Dit is bewust een vaste instelling en wordt niet uit het verzoek gehaald: anders kan iemand het adres waar klanten na
     het betalen naartoe gaan of waar Mollie meldingen naartoe stuurt laten wijzen naar een andere site. Mollie kan geen
     `localhost` bereiken, dus lokaal testen vraagt een tunnel.
4. Beheer → **Instellingen → Abonnementen**: controleer de prijzen (standaard €3,99 per maand en €34,99 per jaar), de
   Plus-limiet (standaard 150) en vul de link naar je voorwaarden in. Stel ook de algemene limiet in (Instellingen →
   Limieten), anders heeft Plus geen voordeel. Dit wordt afgedwongen bij het aanzetten.
5. Zet abonnementen aan. **Doorloop eerst zelf een betaling met de testsleutel**: kies Plus, betaal op de testpagina van
   Mollie en kijk of "Welkom bij Plus!" verschijnt en Plus in Beheer bij de gebruiker staat.
6. Pas als je klaar bent voor echt geld: vervang de testsleutel door de live-sleutel. Met een live-sleutel weigert de server
   abonnementen aan te zetten zolang er geen link naar je voorwaarden is ingevuld.

**Handig in Beheer.** Bij een gebruiker staat een kaart "Abonnement": status, tot wanneer betaald, Mollie-klant- en
abonnementsnummer en de betalingshistorie. Daar kun je ook **Plus cadeau geven** voor een aantal dagen (handig voor testers
en de eerste gebruikers; werkt alleen als abonnementen aan staan), een cadeau intrekken en een abonnement opzeggen. Alle
acties staan in het auditlogboek. Onder *Systeem* staat de controle "Betalingen (Mollie)".

**Wat er (nog) niet is.**

- Geen **facturen of bevestigingsmail**. Mollie stuurt een betaalbevestiging alleen als je dat in je profiel aanzet; een
  factuur met btw maak je zelf, of met je boekhoudpakket.
- Geen **proefperiode** en geen kortingscodes. Een tester geef je met "Plus cadeau geven".
- Geen **overstappen** tussen maand en jaar halverwege: zeg op en sluit opnieuw af.
- Het e-mailadres bij Mollie wordt niet bijgewerkt als een gebruiker zijn e-mailadres wijzigt.
- **Verlengingen zijn niet met echt geld getest.** In testmodus kun je een maand niet versnellen. De logica voor verlengen,
  mislukken, opzeggen, terugboeken en verwijderen is getest tegen een nagebootste Mollie die zich gedraagt zoals hun
  documentatie beschrijft, maar niet tegen de echte. Kijk daarom de eerste weken na livegang goed naar het scherm van de eerste
  abonnees en naar Mollie's dashboard.

**Voordat je echt geld vraagt (geen juridisch of fiscaal advies, laat het nalopen).** Algemene voorwaarden en een
privacyverklaring die Mollie (betalingen) en Anthropic (AI) als verwerkers noemen. Consumentenregels voor online abonnementen:
prijzen inclusief btw, duidelijk wat je afsluit, herroepingsrecht en makkelijk opzeggen (zie ACM ConsuWijzer voor de actuele
regels). Btw-afdracht en onder welke onderneming de omzet valt: bespreek dat met je boekhouder. Het akkoord van de klant
(tijdstip, bedrag, link naar de voorwaarden) wordt wel vastgelegd, maar de teksten zelf moet jij aanleveren.

## Genereren op de achtergrond en meldingen

Gerechten maken duurt soms minuten. Ga je in die tijd naar een andere app of gaat je scherm op slot, dan
pauzeert of sluit de telefoon de pagina, en ging het lopende verzoek (en het resultaat) verloren. Daarom
draait genereren nu als een **opdracht op de server**, met drie lagen eromheen:

1. **De server werkt zelfstandig door.** De app stuurt de opdracht (`POST /api/generate` met `async: true`) en krijgt
   meteen een opdrachtnummer terug. Daarna peilt de app (`GET /api/generate/job/<nummer>`) tot het klaar is. Is de pagina
   even weg, dan wacht het resultaat op je: zodra je terugkomt wordt meteen gekeken, zonder op een timer te wachten.
2. **Ook als de pagina helemaal werd afgesloten** onthoudt de app de opdracht (in `localStorage`). Bij het volgende
   opstarten pakt hij hem weer op en voegt de gerechten toe aan je lijst, met een melding.
3. **Een pushmelding** als je gerechten klaar zijn terwijl je weg bent (zie hieronder). Daarnaast houdt de app je scherm
   aan zolang hij bezig is (Screen Wake Lock, waar de browser dat ondersteunt).

Wat je moet weten:

| Onderwerp | Gedrag |
|---|---|
| Bewaartijd | Een klaar resultaat blijft **30 minuten** beschikbaar (`JOB_TTL_MS`), in het geheugen én in de opslag. Met MongoDB overleeft het dus een herstart van de server. |
| Maximale duur | Een opdracht wordt na **10 minuten** opgegeven met een duidelijke melding (`JOB_MAX_RUN_MS`). |
| Dubbel klikken of slecht bereik | Elke opdracht heeft een aanvraagnummer. Wordt hetzelfde verzoek herhaald (bijv. door een wegvallende verbinding), dan krijg je dezelfde opdracht terug en wordt er **niet dubbel betaald**. |
| Limieten | Hoogstens **4 opdrachten tegelijk** per gebruiker. Opdrachten die nog lopen tellen mee voor `DAILY_GENERATE_CAP`, zodat de daglimiet niet met een stapel gelijktijdige opdrachten te omzeilen is. Een mislukte opdracht telt niet mee. |
| Privacy | Een opdracht is alleen op te halen door de gebruiker die hem startte. Het nummer is een willekeurig getal van 128 bit. |
| Omzetten naar een account | Een lopende opdracht (en de aangemelde toestellen) gaan mee naar het nieuwe account. |
| Oudere app of server | Antwoordt de server meteen met een resultaat (zonder `jobId`), dan werkt de app als voorheen. |

### Pushmeldingen (Web Push)

Gebruikers zetten ze zelf aan onder **Instellingen → Meldingen**, of via de knop "Stuur me een melding als het klaar
is" die tijdens het genereren in beeld staat. De melding komt alleen bij een opdracht om gerechten te maken, en
alleen als de gebruiker niet meer meekijkt (niet gepeild in de laatste 20 seconden, `JOB_WATCH_MS`). Wie dus gewoon
in de app blijft wachten krijgt er geen.

- **iPhone en iPad**: meldingen werken alleen als de app **op het beginscherm staat** (deel-icoon → "Zet op beginscherm")
  en vanaf daar geopend wordt, vanaf iOS 16.4. Dat geldt ook in Nederland en de rest van de EU. In Safari zelf ziet de
  gebruiker daar uitleg over.
- **Android, Windows, Mac**: werkt in Chrome, Edge en Firefox, ook zonder de app te installeren.
- De melding is **versleuteld** (RFC 8291) en bevat geen persoonlijke gegevens, alleen "Je gerechten zijn klaar".
  Meer dan 5 toestellen per gebruiker worden niet bewaard (het oudste valt weg). Toestellen die niet meer bestaan
  worden vanzelf opgeruimd. Bij uitloggen wordt het toestel bij het account afgemeld.
- De server verstuurt alleen naar de echte pushdiensten van de browsers (Google, Apple, Mozilla, Microsoft) en nooit
  naar een willekeurig adres.
- Er zijn geen extra pakketten nodig: de versleuteling en ondertekening (VAPID) gebruiken Node's eigen `crypto`.

**Sleutels (VAPID).** Voor het versturen heeft de server een sleutelpaar nodig.

- *Zonder iets in te stellen* maakt de server er één keer zelf een aan en bewaart dat in de database. Met MongoDB
  (zie "Blijvende opslag") blijft het dus bestaan. **Zonder MongoDB verdwijnen de sleutels bij elke herstart**; telefoons
  schrijven zich dan vanzelf opnieuw in zodra de app opent, maar meldingen tussendoor gaan verloren. De beheerconsole
  waarschuwt daarvoor onder **Systeem → Meldingen (Web Push)**.
- *Aanbevolen voor een vaste opzet*: maak zelf een sleutelpaar en zet het in de omgeving. Eenmalig te maken met:

```
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.privateKey.export({format:'jwk'});console.log('VAPID_PUBLIC_KEY='+Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url'));console.log('VAPID_PRIVATE_KEY='+j.d)"
```

  Zet de twee regels in `.env` (of bij Render onder Environment). **Bewaar de privésleutel geheim** en verander hem niet
  zonder reden: bij nieuwe sleutels moet elk toestel zich opnieuw inschrijven (dat gebeurt vanzelf bij de eerstvolgende keer openen).
- `VAPID_SUBJECT` (optioneel) is een `mailto:`-adres of `https://`-adres waarmee pushdiensten je kunnen bereiken.
  Standaard wordt het adres van je site gebruikt.

**In de beheerconsole**: onder *Activiteit* staan de opdrachten (soort "AI") en de verstuurde meldingen (soort "Melding",
met "1 van 1 toestel bereikt", zonder inhoud of sleutels). Onder *Systeem* staat de controle *Meldingen (Web Push)*.

**Zichtbaar voor gebruikers.** Zodra abonnementen aan staan, ziet een gebruiker altijd welk plan hij heeft: een klein label
("Gratis" of "Plus") naast de avatar rechtsboven en in het accountmenu. Vanuit het accountmenu, de Plus-kaart in Mijn profiel
en de limietmelding op het generatiescherm gaat een link "Abonnement vergelijken" naar een pagina met Gratis en Plus naast
elkaar. Staan abonnementen uit, dan is dit label en die pagina nergens te zien.

**Testen na het deployen**: dit is geprobeerd met nagebootste AI- en pushdiensten, niet op een echte telefoon. Doe daarom
eenmaal een echte proef: zet meldingen aan, start een generatie, ga naar de beginschermknop of een andere app, en wacht
tot de melding komt. Doe dat ook op een iPhone met de app op het beginscherm.

## Gerechtfoto's (optioneel)

De app kan een foto bij elk gerecht tonen (in de gerechtenlijst en op het
receptdetailscherm), opgehaald via Unsplash. Dit is optioneel:

1. Maak gratis een Unsplash-developer account op https://unsplash.com/developers
2. Maak een "Application" aan en kopieer de **Access Key**
3. Zet die in `.env` bij `UNSPLASH_ACCESS_KEY=`
4. Herstart de server

Zonder deze sleutel werkt de app gewoon door — dan verschijnen er simpelweg
geen foto's. Foto's worden per gerecht één keer opgehaald en daarna bij het
gerecht opgeslagen, dus niet steeds opnieuw aangevraagd.

**Hoe een foto wordt gekozen**

- Bij elk nieuw gerecht levert de AI een korte Engelse zoekterm
  (`foto_zoekterm`, bijv. "grilled salmon asparagus"). Oudere gerechten zonder
  zoekterm krijgen een zoekterm door hun Nederlandse naam te vertalen.
- De server haalt 15 kandidaten op en beoordeelt ze op beschrijving en tags:
  past het bij het gerecht, is het eten, staat er geen persoon of landschap op?
  Is er geen degelijke match, dan volgt één tweede poging met de kern van de
  zoekterm; daarna geldt liever géén foto dan een verkeerde foto.
- Een tijdelijke storing (bijv. de Unsplash-limiet) wordt niet als "geen foto"
  vastgelegd: er wordt later opnieuw gezocht (na 10 minuten).

**Foto's in de PDF:** de weekmenu-PDF (weekplanning en menu uit ontworpen gerechten) toont bij
elk gerecht met een foto een banner, met de fotograaf erbij (dat vraagt Unsplash). Gerechten waar
nog geen foto aan hangt, worden tijdens het maken van de PDF alsnog opgezocht. De foto's komen
via `GET /api/photo`: dat eindpunt haalt de afbeelding op en geeft die door aan de browser (een
browser mag plaatjes van een andere site niet uitlezen om ze in een PDF te zetten). Het is
streng begrensd: alleen `https://images.unsplash.com`, alleen voor ingelogde (of, als inloggen
uit staat, anonieme) gebruikers, alleen afbeeldingen en maximaal 6 MB. Lukt het ophalen niet,
dan krijg je gewoon de PDF zonder foto's. De PDF wordt hierdoor langer en groter.

**Let op — Unsplash-limiet:** een Unsplash-app in demomodus mag 50 aanvragen
per uur doen. Eén generatie van 28 gerechten met afbeeldingen kost er ongeveer
28 (soms iets meer, bij een tweede poging). Wordt de limiet bereikt, dan wacht
de server 10 minuten en verschijnen de ontbrekende foto's vanzelf zodra je de
gerechten daarna opnieuw bekijkt. Wil je veel foto's per uur, vraag dan bij
Unsplash "Production" aan (5.000 aanvragen per uur).

## Kostenbeheersing

Twee env-variabelen begrenzen wat de app aan API-kosten kan maken (in de beheerconsole
onder Instellingen zijn ze ook live aan te passen, samen met de limieten voor tips):

- `PER_IP_HOURLY_CAP` (standaard 20) — max. generatie-verzoeken per uur, per IP-adres.
- `DAILY_GENERATE_CAP` (standaard 300) — max. generatie-verzoeken per dag, voor alle gebruikers samen.

Opdrachten die op de achtergrond nog lopen tellen mee voor de daglimiet, en één gebruiker kan er hoogstens 4
tegelijk hebben (zie "Genereren op de achtergrond").

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
browserbalk. Op een iPhone zijn pushmeldingen alleen mogelijk voor de app op het beginscherm
(zie "Pushmeldingen").

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
