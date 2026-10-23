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

**Startscherm (v2):** rustig en op ongeveer één scherm, met één hoofdknop.
- **Vandaag**: de eerstvolgende maaltijd groot als foto (zonder foto: kleurvlak van het moment met een groot icoon), met
  "Vanavond/Straks/Nu – diner". Daaronder een kcal-balk opgebouwd uit de maaltijden van vandaag (elk in de kleur van zijn moment,
  lichter tot hij gekookt is), eiwit/koolhydraten/vet als drie meters (270°, lopen één keer vol bij openen; boven 110% van je doel kleurt de meter rood met "+x") en de overige maaltijden als rustige lijst.
  Niets gepland: een kleine illustratie, een vraag die past bij het tijdstip en één knop *Plan vandaag* (of *Maak mijn eerste gerechten*).
- **Je week**: zeven dagen met datum en drie stipjes (ontbijt, lunch, diner in hun kleur); vandaag is gevuld, ✓ als alles gekookt is.
  Tik op een dag om hem te plannen; *Hele week* rechtsboven.
- Koppen op Start zijn rustige titels ("Je week", "Voor jou", "Laatst gemaakt") in plaats van labels in hoofdletters.
- **Voor jou**: berichten over ideeën, "gekookt?", mijlpalen, conceptweek, terugblik, je reis en het seizoen op één plek,
  één tegelijk met een knop *1 van N ›*. Staat *Plan vandaag* er al, dan zijn de knoppen hier rustiger.
- **Recente gerechten**: horizontale rij, met foto als die er is.
- Boodschappenlijst, Gerecht van foto, Community, Hoe werkt Balanza, Volgende week, Snel genereren en Tip van de dag staan
  standaard uit (ze zitten al in de tabbalk of het menu) en zijn terug te zetten via *Startscherm aanpassen*. Bestaande
  eigen indelingen beginnen één keer opnieuw vanaf deze standaard (`homeLayout.v = 2`).
- Uitleg onder kaarten (zoals bij Gerecht van foto en Restjes) staat er alleen de eerste 3 dagen dat je hem ziet.
- Restjes in de planner zijn ingeklapt tot één regel ("Op te maken: spinazie · 1 gerecht past ›").
- Wissen van het chatgesprek en de smaakgeschiedenis gaat zonder vraag, met *Ongedaan maken* in de melding.
- Inplannen en "gekookt" geven een melding met een groen vinkje (en een korte tik op telefoons die dat ondersteunen).

**Privacy (AVG):**
- **Privacyverklaring** op `/privacy` (ook gelinkt vanaf de welkomstpagina en in de app): welke gegevens, waarvoor, grondslag,
  verwerkers (Anthropic, Render, database, Resend, Mollie, Google/Apple, pushdiensten, Unsplash, ipapi.co, GitHub), bewaartermijnen
  en rechten. Bedrijfsnaam, adres, KvK en e-mail vul je in bij *Admin → Instellingen → Privacy*; zolang die leeg zijn staat er een
  rode placeholder en meldt *Systeem* een aandachtspunt.
- **Toestemming in de app:** bij het openen (na inloggen of registreren) vraagt Balanza akkoord met de verklaring én uitdrukkelijke
  toestemming voor gezondheidsgegevens (AVG art. 9: gewicht, lengte, allergieën, dieetwensen). Opgeslagen in `consent/<uid>`
  (versie, tijdstip, IP; endpoint `/api/consent`). Bij een nieuwe versie (*Nieuwe versie* in de admin) vraagt de app het opnieuw.
- **Ook zonder toestemming bruikbaar:** het akkoord met de privacyverklaring is nodig, de toestemming voor gezondheidsgegevens
  niet. Zonder die toestemming (`consent.health = false`) vraagt Balanza niet naar lengte, gewicht en leeftijd (geen dagdoel, gemiddelde
  porties), zijn gezondheidsfilters (lactose-, glutenvrij e.d.), "Anders gegeten / Wat past nog?", water en gewicht bijhouden uit,
  en heet de uitsluitingslijst "dingen die je niet lust". De server slaat die velden dan ook niet op (`stripHealthData`).
  Op die plekken staat een korte uitleg met *Toestemming geven*.
- **Intrekken:** *Instellingen → Privacy → Toestemming gezondheidsgegevens intrekken* wist lengte, gewicht, leeftijd,
  gezondheidsfilters, water, "anders gegeten" en het gewichtsverloop (ook op de server); Balanza werkt daarna verder zonder
  persoonlijke afstemming. *Persoonlijke afstemming aanzetten* geeft de toestemming weer.
  De admin ziet per gebruiker of en wanneer er akkoord is gegeven. Bij het verwijderen van een account gaat het toestemmingsrecord mee.
- Laat de tekst nog even controleren door iemand met juridische kennis; dit is een redelijke basis, geen juridisch advies.

**Geen dubbele gerechten:** bij elk genereren krijgt de AI de namen van je bestaande gerechten mee (max. 60) met de opdracht
niets te maken dat erop lijkt. Daarna vergelijkt de app elk nieuw gerecht met je lijst (zelfde maaltijdmoment; naam en
hoofdingrediënten, met woorddelen zoals "rijst" in "zilvervliesrijst"). Lijkt het erop, dan staat het in het resultaatscherm als
"Lijkt op … dat je al hebt, dus niet bewaard"; met "Toch bewaren" houd je het. Bij automatisch aanvullen (week vullen, achtergrond,
hervatte opdrachten) worden lijkende gerechten stil overgeslagen en gebruikt Balanza je bestaande gerecht. Foto-gerechten en
community-recepten worden niet tegengehouden (die kies je bewust).

**Vlees, gevogelte en vis uitsluiten** (`prefs.proteinOut`): onder *Voedingsstijl, gezond & uitsluitingen* (en in de wizard) staan
Vlees (varken, rund, kalf, lam en geit, wild), Gevogelte (kip, kalkoen, eend en gans) en Vis (witvis, vette vis, schaal- en
schelpdieren). Standaard staat alles aan; tik weg wat je niet eet, of gebruik "Geen vlees/gevogelte/vis" per groep. Niet zichtbaar
bij vegetarisch of veganistisch. Het is een harde regel: de prompt krijgt "EET DIT NIET", de NEVO-lijst wordt gefilterd en elk
gerecht wordt gecontroleerd (met herstelronde), net als de gezondheidsfilters. Bestaande gerechten met iets wat je niet eet, plant
Balanza niet meer automatisch in (planner, conceptweek), en community-suggesties houden er rekening mee. Admin kan het aanpassen.
*Wat wil je niet eten?* bevat geen vlees, vis, lactose of gluten meer (die hebben een eigen plek). Oude of zelf getypte termen
zoals "Vis", "Varkensvlees", "kip", "Lactose" of "Gluten" worden bij het openen van de app (en bij typen) automatisch verplaatst
naar *Vlees, gevogelte en vis* of *Gezond eten*; de server telt oude termen in `exclude` voor de zekerheid ook nog mee.

**Nieuwe berichten in de chat:** de chatknop toont een rood getal met het aantal ongelezen berichten (en pulseert twee keer),
en bovenaan Start staat een kaart "Nieuw bericht van Balanza" met het begin van het bericht en *Lees*. Antwoorden op ideeën
(inbox) komen ook als bericht in de chat; meldingen daarover openen direct de chat (`/?open=chat`). Ongelezen wordt bepaald met
een tijdstempel per bericht (`balanza_chat_seen_at`), zodat het ook klopt als het gesprek langer is dan 50 berichten.

**Balans-keurmerk:** de score staat overal als keurmerk: een gekartelde zegel met de weegschaal van het Balanza-logo.
Groot (met het getal en "BALANS" erin) op de foto van het uitgelichte gerecht, naast de titel op de receptpagina en in de
gerechtenlijst; klein (zegel + percentage) in regels en labels. Zegelkleur volgt de schaal (groen, geel, oranje, rood).

**Balans-score overal, in kleur:** 75–100% groen, 50–74% geel, 25–49% oranje, 0–24% rood (`balClass()`; admin gebruikt
dezelfde kleuren). Te zien bij: het uitgelichte gerecht en elke maaltijd op Start, de dag als geheel (op de macro's van alles
samen), het weekgemiddelde in *Je week*, de weekplanner (per dag en per gerecht), de dagkaart en snacks in de planner,
suggesties, *Wat past nog?*, *Anders gegeten* (ook de schatting), bibliotheek, favorieten, recente gerechten, community,
het gerechtmenu en de receptpagina. De score is altijd berekend tegen je huidige doel.

**Dagelijks (bij Vandaag op Start):**
- **Gegeten / niet gegeten:** bij elke maaltijd van vandaag staan ✓ en ✕ (bij de grote kaart als "Gegeten" en "Niet gegeten").
  ✓ zet `cooked: true` (bij het diner vraagt Balanza daarna in *Voor jou* of het lekker was); ✕ zet `cooked: false`: de maaltijd
  wordt doorgestreept en telt niet meer mee in je dag (meters, balk, planner). Nog eens tikken zet het terug; de melding heeft
  *Ongedaan maken* en bij ✕ ook *Wat at je wel?* (opent "Anders gegeten" voor die maaltijd).
- **Anders gegeten** (`/api/estimate`): beschrijf of fotografeer wat je at; de AI (assistent-model) schat kcal en macro's, die je kunt
  aanpassen. Met een foto gebruikt de server het hoofdmodel (`ANTHROPIC_MODEL`, kan foto's lezen), alleen tekst gaat via het assistent-model. Fouten staan in het scherm zelf en in de log (soort "estimate"). Kies "In plaats van" een geplande maaltijd of "Extra". Het telt mee in je dag (meters, balk, planner); opgeslagen in
  `plannedWeeks[].extra[dag]` met `who` (in een huishouden ziet ieder alleen zijn eigen). Max 30 schattingen per uur per gebruiker.
- **Uit eten**: restaurantnaam (met eerdere restaurants als suggestie) en optioneel je locatie, afgerond op ±100 m. Balanza onthoudt
  wat je er at (`prefs.places`, max 30) en stelt de volgende keer restaurants binnen 250 m voor, met "Hetzelfde als vorige keer".
  Er wordt geen kaart- of plaatsendienst aangeroepen.
- **Wat past nog?**: wat er van je dagdoel over is, met passende gerechten uit je eigen bibliotheek en simpele snacks (gefilterd op
  voedingsstijl, lactose- en glutenvrij en uitsluitingen). Een snack aantikken legt hem vast als gegeten.
- **Voorbereiding**: bij het diner van vandaag (tot 17:00) een tip als vlees uit de vriezer halen, peulvruchten weken, marineren of
  een lange bereidingstijd. Dezelfde tip komt als **ochtendbericht** (melding `morning-prep`, standaard 08:00, alleen als er iets
  voor te bereiden valt; instelbaar onder Meldingen).
- **Water** (standaard uit): 8 glaasjes om aan te tikken, opgeslagen per dag in `prefs.water`.
- Alles aan/uit onder *Begeleiding*: "Ik at iets anders / Wat past nog?", "Ochtendbericht met voorbereiding", "Water bijhouden".

**Gerecht van foto → "Wat ligt er in huis?"**: een foto van je koelkast of voorraad; Balanza herkent de ingrediënten en maakt er
één gerecht van dat bij je doel past (aangevuld met basisvoorraad).

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
| **Gerechten** | Alle gerechten van alle gebruikers: zoeken, filteren op maaltijd en bron (gegenereerd, van foto, community), sorteren op nieuwste of balans, en per gerecht ingrediënten, macro's en bereiding bekijken (alleen lezen). Ook per gebruiker onder *Gegevens*; bij een huishouden staan de gerechten bij wie het huishouden startte. |
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
   ingelogd bent), en je kunt hem wijzigen via **Wijzigen** op het boodschappenscherm of de kaart "Bring!" bij
   Instellingen (leeg maken verwijdert hem). Alleen https-links worden geaccepteerd; een adres
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

## Macro's berekend met NEVO

Balanza rekent macro's niet alleen uit door de AI te laten schatten: waar mogelijk worden ze berekend met het
**Nederlands Voedingsstoffenbestand (NEVO)** van het RIVM. De AI levert per ingrediënt een object
`{"tekst": "180 g kipfilet", "gram": 180, "nevo": "Kipfilet rauw"}`; Balanza koppelt `nevo` aan een van de
~2.328 NEVO-producten (`nevo/nevo2025_macros.json`) en rekent kcal, eiwit, koolhydraten en vet zelf uit.

- **Volledige match** (alle relevante ingrediënten gekoppeld; zout, peper en kruiden tellen niet mee): het gerecht
  krijgt `macroBron: "nevo"`, een groen label "NEVO-berekend" (in de app en de PDF) en een bronregel op het
  receptscherm. Dit geldt voor genereren, automatisch aanvullen en variaties — en telt óók mee bij het bepalen of
  een gerecht dicht genoeg bij het gekozen doel zit (de Balans-score wordt op de **echte, uitgerekende** macro's
  beoordeeld, niet op wat de AI zelf beweerde).
- **Onvolledige match** (een ingrediënt zonder goede NEVO-match): de AI-schatting blijft staan, duidelijk gelabeld
  als `macroBron: "schatting"`, met welke ingrediënten niet zijn meegeteld.
- **Bestaande gerechten** in "Opgeslagen gerechten" die nog een schatting zijn, kun je met één knop laten
  herberekenen ("Herbereken macro's met NEVO"). Dat stuurt de bestaande ingrediëntregels (ongewijzigd) naar de AI
  om ze naar het NEVO-schema om te zetten, waarna Balanza dezelfde berekening toepast. Dit telt niet mee voor de
  maandelijkse limiet op nieuwe gerechten (er wordt niets nieuws gemaakt), maar de AI-kosten worden wel bijgehouden.

**Bronvermelding en licentie.** Zie `NOTICE.md` en `nevo/NEVO-voorwaarden-2025.pdf`. De NEVO-gegevens zijn
eigendom van het RIVM / de Staat der Nederlanden; het RIVM onderschrijft Balanza niet en berekende waarden zijn
indicatief. Eigen toevoegingen die niet in NEVO zitten (bijv. eiwitpoeder) staan apart in `NEVO_ADDITIONS` in
`server.js`, gemarkeerd als "Balanza-aanvulling".

**Zonder de dataset.** Ontbreekt `nevo/nevo2025_macros.json` (bijv. per ongeluk niet meegedeployd), dan draait de
app gewoon door op AI-schattingen: er verschijnt dan nergens een NEVO-label, en het herberekenen-eindpunt geeft een
duidelijke melding dat NEVO niet beschikbaar is in plaats van de AI toch aan te roepen.

**De dataset bijwerken.** Download een nieuwere NEVO-versie via https://nevo-online.rivm.nl/ (akkoord met de
voorwaarden) en bouw er met `nevo/build_nevo_subset.py` een nieuwe `nevo2025_macros.json` van. Werk dan ook
`NEVO_VERSION`/`NEVO_REFERENCE` in `server.js` en de tekst in `NOTICE.md` bij.

## Onderdelen per abonnement vrijgeven (Plus)

Naast helemaal aan of uit voor iedereen, kun je vijf onderdelen ook specifiek aan **Plus** koppelen: Kostenschatting,
Bring!-import, Boodschappenlijst delen, PDF-export en Gerechtfoto's. Beheer → Instellingen → Onderdelen toont bij
deze vijf een extra keuzelijst naast de aan/uit-schakelaar: "Iedereen" of "Alleen Plus".

- **Twee lagen.** Het algehele aan/uit blijft de basis: staat een onderdeel wereldwijd uit, dan blijft het uit voor
  iedereen, ook voor Plus. "Alleen Plus" is een tweede laag die alleen iets doet zolang het onderdeel wereldwijd
  aan staat.
- **Zonder abonnementen aan:** "Alleen Plus" betekent dan "voor niemand", want zonder abonnementen kan niemand Plus
  hebben. Zet dus eerst abonnementen aan (zie "Betalingen en abonnementen") voordat je dit gebruikt.
- **Wie is bepalend, en wanneer.** Bij Kostenschatting en het delen van een **nieuwe** boodschappenlijst is dat de
  gebruiker die het verzoek doet. Een lijst die al bestond blijft altijd gewoon werken, ook als delen daarna op
  "Alleen Plus" wordt gezet. Bij Bring!-import (dat door Bring's eigen server wordt opgehaald, niet door de
  gebruiker zelf) is de **eigenaar** van de lijst bepalend, en dat wordt elke keer opnieuw gecheckt: zegt iemand
  zijn Plus op, dan stopt Bring!-import voor zijn lijsten meteen; wordt iemand Plus, dan werkt het meteen.
- **Foto's** kennen twee plekken: het ophalen van een foto bij een gerecht, en de foto-proxy die de PDF-export
  gebruikt. Beide zijn gekoppeld aan dezelfde instelling. Een oudere, gecachte pagina die nog geen identiteit
  meestuurt wordt behandeld als gratis, niet geweigerd.
- **PDF-export** heeft geen eigen server-eindpunt (het draait volledig in de browser), dus die instelling werkt
  uitsluitend door de exportknop wel of niet te tonen.

## Openbare marketingpagina

`public/welkom.html`, bereikbaar op **/welkom**, is een aparte, openbare mini-site die uitlegt wat Balanza is, wat
het uniek maakt en wat je ermee kunt. Net als het beheerscherm (`admin.html`) is dit één bestand met een eigen,
vaste navigatiebalk en een router die op basis van de hash (`#/pagina`) wisselt tussen vier pagina's — alleen zonder
wachtwoord, want dit is voor iedereen:

| Pagina | Inhoud |
|---|---|
| `#/home` (standaard) | Hero, korte introductie, een voorproefje van "wat maakt Balanza anders" |
| `#/functies` | Alle functies op een rij (genereren, plannen, boodschappenlijst, prepdag, meldingen, PDF) |
| `#/waarom` | De volledige lijst met wat Balanza onderscheidt (NEVO, Nederlandse workflow, geen advertenties, …) |
| `#/prijzen` | Gratis vs. Plus, met live opgehaalde prijzen |

- Rechtstreeks naar een pagina linken kan met bijv. `/welkom#/prijzen` — een onbekende of foutieve hash valt terug
  op Home, dus een verouderde link breekt niet.
- Alle knoppen (ook het logo) linken naar `/` (de app). Er is geen apart inlogformulier op deze pagina.
- Het prijzenblok haalt de **actuele** prijzen live op via `/api/config` en `/api/billing` (met een wegwerp-anoniem-id,
  puur om de openbare prijsinformatie te lezen — er wordt niets voor die bezoeker opgeslagen). Staan abonnementen uit,
  dan toont de pagina alleen dat Balanza gratis te gebruiken is, zonder kans op een verouderd bedrag.
- Dezelfde lettertypen en kleuren als de app (Fraunces + Public Sans, warme crème/goud-tinten, met NEVO-groen voor
  de macro-differentiator), zodat het voelt als hetzelfde product.
- Pas de tekst gerust aan `public/welkom.html` naar eigen inzicht aan; het is een gewoon, zelfstandig HTML-bestand,
  net als `admin.html` opgebouwd rond een kleine `h()`-helper en een `VIEWS`-object per pagina.

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

**Geplande meldingen.** Naast "je gerechten zijn klaar" stuurt de server drie soorten meldingen, alleen naar wie
meldingen op een toestel heeft aangezet. De gebruiker kiest ze per soort onder *Instellingen → Meldingen* (standaard aan):

- *Plan je week*: op een gekozen dag en tijd (standaard zondag 19:00), alleen als er in de week vanaf de komende
  maandag 3 of meer avonden zonder diner zijn. Tik = de planner op die week.
- *Diner van vandaag*: op een gekozen tijd (standaard 9:00), alleen als er voor vanavond nog geen diner gepland staat.
  Tik = de planner op vandaag.
- *Nieuwe recepten in de community*: hooguit één bundel per dag rond 17:00, met recepten die sinds de vorige keer zijn
  gedeeld en passen bij de gebruiker: zijn voedingsstijl (geen vlees voor een vegetariër), niets uit "wil niet eten",
  zijn maaltijdmomenten en een balans van 80 of meer voor zijn doel. Eigen recepten tellen niet mee.

Wie na de proef geen Plus heeft, krijgt geen planherinneringen (plannen kan dan niet). Tijden zijn Nederlandse tijd. Een
melding gaat binnen 3 uur na het tijdstip weg; wordt dat venster gemist (server stond uit), dan slaat hij die keer over.
De voorkeuren staan per gebruiker in `notify/<uid>` en gaan mee bij exporteren, verwijderen en omzetten naar een account.

De server kijkt elke 5 minuten zelf. **Kan je server slapen** (bijv. Render's gratis laag), zet dan `CRON_SECRET`
(minstens 16 tekens) en laat een externe cron (bijv. cron-job.org of een Render Cron Job) elke 5 à 15 minuten aanroepen:

```
curl -X POST https://jouw-domein.nl/api/cron/notify -H "Authorization: Bearer $CRON_SECRET"
```

Dubbel versturen kan niet: per gebruiker wordt per dag bijgehouden wat al verstuurd is. De beheerconsole toont onder
*Overzicht → Meldingen* hoeveel er de afgelopen 7 dagen per soort zijn afgeleverd, en onder *Systeem* of de cron is ingesteld.

**Testmelding**: onder *Instellingen → Meldingen* staat (als meldingen aan zijn) *Stuur een testmelding*. Die gaat meteen naar alle
toestellen van de gebruiker en toont wat de pushdienst antwoordde (bijv. `Apple zei: 403 (BadJwtToken)`); weigeringen staan ook in de log.
De VAPID-`sub` is altijd een echte https-URL (`VAPID_SUBJECT`, anders `PUBLIC_BASE_URL` of `RENDER_EXTERNAL_HOSTNAME`), omdat Apple
een nep-adres weigert.

**Teller op het app-icoon**: elke melding telt één op bij het icoon (Badging API; iPhone vanaf iOS 16.4 op het beginscherm, Chrome/Edge).
Open je de app, dan toont de teller alleen nog ongelezen chatberichten en antwoorden op ideeën, of verdwijnt hij.

**Zichtbaar voor gebruikers.** Zodra abonnementen aan staan, ziet een gebruiker altijd welk plan hij heeft: een klein label
("Gratis" of "Plus") naast de avatar rechtsboven en in het accountmenu. Vanuit het accountmenu, de Plus-kaart in Mijn profiel
en de limietmelding op het generatiescherm gaat een link "Abonnement vergelijken" naar een pagina met Gratis en Plus naast
elkaar. Staan abonnementen uit, dan is dit label en die pagina nergens te zien.

**Testen na het deployen**: dit is geprobeerd met nagebootste AI- en pushdiensten, niet op een echte telefoon. Doe daarom
eenmaal een echte proef: zet meldingen aan, start een generatie, ga naar de beginschermknop of een andere app, en wacht
tot de melding komt. Doe dat ook op een iPhone met de app op het beginscherm.

## Begeleiding: terugkomen en blijven

Zes onderdelen die gebruikers terugbrengen. De gebruiker zet elk onderdeel zelf aan of uit onder
**Instellingen → Begeleiding** (standaard aan). Bij de onderdelen met een melding gaat die melding mee aan of uit.

| Onderdeel | Wat het doet |
|---|---|
| **Week alvast klaarzetten** | Op de dag van "Plan je week" (standaard zondag 19:00) vult de server de lege hoofdmaaltijden van volgende week met de eigen gerechten van de gebruiker: favorieten vaker, geen "niet lekker", niet twee dagen achter elkaar hetzelfde, restjes eerst. Dat is een **voorstel** (`draft` op de week): in de planner staat "Week goedkeuren" of "Voorstel weghalen" (met ongedaan maken). Melding: "Je week staat klaar". Kost geen AI. Op vrijdag t/m zondag staat op Start ook "Volgende week alvast klaarzetten?". Heeft iemand per maaltijdmoment minder dan 2 gerechten, dan blijft het bij de gewone herinnering. |
| **Na het eten** | Vanaf 17:00 (en de ochtend erna) vraagt een kaart op Start: gekookt, lekker of niet lekker? Optioneel een melding (standaard 20:30). "Lekker" maakt het een favoriet (vaker ingepland), "niet lekker" haalt het uit automatisch plannen. Klaar in de kookmodus telt als gekookt. Opgeslagen op het plan-item (`cooked`, `rated`). |
| **Weekterugblik** | Maandag t/m woensdag een kaart (en maandag 10:00 een melding) met de vorige week: maaltijden, gekookt, gemiddelde Balans, macroverdeling tegenover het doel en het gerecht van de week. In de laatste 2 dagen van de proef: "Je proefweek in cijfers" (kaart en melding om 18:00). |
| **Samen plannen** | In *Mijn profiel*: iemand uitnodigen via een link (7 dagen geldig, `/?join=…`). Leden van een huishouden delen gerechten en weekplanning (en dus de boodschappenlijst); voorkeuren, meldingen, abonnement en verbruik blijven per persoon. De gedeelde gegevens staan bij wie het startte; de server stuurt `dishes` en `plannedWeeks` door. Eigen gegevens van een lid blijven bewaard. Vertrekken of stoppen geeft iedereen een kopie. Alleen met een account, maximaal 6 personen. De app haalt de gedeelde stand op als hij weer in beeld komt en elke minuut; tegelijk hetzelfde wijzigen: de laatste wint. Een account verwijderen haalt iemand uit het huishouden. |
| **Restjes opmaken** | In de planner: "Op te maken". Restjes blijven 10 dagen staan (`prefs.leftovers`). Balanza stelt voor wat er van verpakkingen overblijft (bijv. 1 bak kwark van 500 g voor 150 g), toont gerechten die de restjes gebruiken, zet die bij automatisch invullen eerst en kan nieuwe gerechten maken met de wens "Restjes opmaken". De boodschappenlijst toont ook "± 350 g over". |
| **Seizoen en feestdagen** | Een tegel op Start met groente en fruit van de maand, en in de aanloop naar Sinterklaas, Kerst, Pasen, Koningsdag, Moeder- en Vaderdag, Halloween en het barbecueseizoen een knop om daarvoor gerechten te maken. De server geeft dit door via `/api/config` (`season`) en voegt een zachte seizoensvoorkeur toe aan de opdracht voor de AI. |
| **Voedingsnieuws** | Hooguit één bericht per dag onder *Voor jou*: kop, bron en een link naar het artikel (geen eigen samenvatting). Bronnen: Voedingscentrum (alle berichten), RIVM en WUR (alleen over voeding, alleen Nederlandstalig). De server haalt `/api/news` elke 6 uur opnieuw op (RSS, met de nieuwspagina van het Voedingscentrum als terugval) en bewaart het in `news/cache`. Vegetariërs zien geen berichten over vlees of vis, minderjarigen niets over alcohol. Beheer: *Instellingen → Voedingsnieuws* (bronnen aan/uit, status, nu ophalen, eigen bericht of tip van de week). |
| **Automatisch plannen** | Eén keer instellen (Instellingen → Automatisch plannen, of vanuit de planner): welke maaltijden (ontbijt, lunch, diner, snack), welke dagen, en wanneer (standaard elke zaterdag 09:00). De server zet dan elke week de volgende week klaar met eigen gerechten, ook als de app dicht is (`autoplan/<uid>`, in de meldingsronde; `GET/POST /api/autoplan`, met `run: true` voor nu meteen). Regels: een gerecht hooguit één keer per 28 dagen; favorieten na 10 dagen en hooguit 40% per maaltijdsoort per week; duimpje omlaag en uitgesloten eiwitten nooit; wat al gepland staat blijft staan; niet-gegeten maaltijden tellen niet mee. Te weinig keus: het langst geleden gerecht (minstens 7 dagen). Blijft er dan nog iets leeg en staat *Te weinig gerechten? Maak er nieuwe bij* aan (standaard), dan maakt de server nieuwe gerechten (zelfde AI-opdracht als aanvullen op de achtergrond, max 7 per soort, telt mee voor dag- en maandlimiet, gaat nooit over de maandlimiet heen) en vult opnieuw; die gerechten komen in je eigen lijst en zijn in de carrousel gemarkeerd als *Nieuw gerecht*. Het resultaat is een voorstel; met de melding of via Start/planner open je een carrousel om per maaltijd te wisselen of weg te halen en de week goed te keuren. Staat dit aan, dan slaat de oude zondagse weekherinnering zichzelf over. |
| **Tips over instellingen** | Om de dag (op de dagen dat Balanza een gesprekje begint) een tip in de chat over iets wat de gebruiker nog niet gebruikt: automatisch plannen, meldingen, startscherm aanpassen, foto van koelkast/recept, vlees- en vissoorten uitsluiten, licht/donker thema, samen plannen, restjes, water, Anders gegeten, voedingsnieuws, begeleiding. Met een knop om het meteen te proberen en "Niet nodig". Geprobeerd of "niet nodig" komt niet terug; alleen getoond komt na twee weken nog eens. Uit te zetten bij Begeleiding ("Tips over wat je kunt instellen"). |
| **Beheer vanuit de app (single sign-on)** | In het beheer geef je een gebruiker met een account *Beheertoegang* (Gebruikers → gebruiker → Beheertoegang; overzicht onder Instellingen → Toegang). Die ziet in de app bij Instellingen het blok *Beheer* → *Open beheeromgeving*. De app vraagt met de eigen sessie een eenmalige code (60 s, `POST /api/admin/sso`), het beheer wisselt die in voor een beheersessie van 8 uur (`POST /api/admin/sso/exchange`). Intrekken of blokkeren beëindigt een open sessie meteen; bij account verwijderen vervalt de toegang. Het auditlog toont per actie *Door* (e-mailadres of "wachtwoord"). Het beheerderswachtwoord blijft gewoon werken. |
| **Fouten naar GitHub** | In Beheer → Overzicht (Laatste fouten) en Activiteit staat bij elke fout de knop *Naar GitHub*. Die maakt een issue met de labels `fout` en `nieuw` (via `GITHUB_TOKEN`, dezelfde token als voor de ideeën). Gelijke fouten (zelfde soort, actie en melding; getallen tellen niet mee) delen één issue: nog eens melden zet er een reactie bij met hoe vaak het in 7 dagen voorkwam, en heropent het. In het issue staan nooit e-mailadressen, IP-adressen, gebruikers-id's of sleutels. Een geplande Claude-taak bekijkt elk uur nieuwe `fout`-issues, zoekt de oorzaak, zet een voorstel klaar als pull request en labelt het issue `onderzocht`; jij beoordeelt en voegt samen. |
| **Snel toevoegen** | Knop *＋ Toevoegen* op Start en *＋ Snel iets toevoegen* per dag in de planner. Zoekt direct in de app in de NEVO-productenlijst (`GET /api/foods`, ~45 kB gzip, één keer geladen en bewaard; gratis voor iedereen, zoals de NEVO-voorwaarden eisen) met standaardporties (Balanza-aanvulling, `FOOD_PORTIONS`). Een hele zin ("2 eieren, 2 sneetjes volkoren brood met 30 g kaas") wordt in de app ontleed; alleen wat niet te vinden is gaat naar de AI-schatting (`/api/estimate`). Streepjescode via de camera (BarcodeDetector, op iPhone de open-source ZXing-lezer) of door het nummer in te tikken; gegevens van Open Food Facts (`GET /api/foods/barcode/<ean>`, 30 dagen bewaard, ODbL). Eigen producten (per 100 g) in `prefs.myFoods`. Live kcal, macro's, Balans en "past nog". Toevoegen als extra bij een dag (telt mee, alleen met toestemming gezondheidsgegevens) of inplannen als maaltijd (wordt bewaard als gerecht). "Mijn maaltijden" en "Vaak en laatst" voor herhalen in één tik. |
| **Geslacht wijzigen** | `genderChanged(oud)` (vanuit Mijn voorkeuren): overzicht van wat meeging (dagdoel via Mifflin, gezond vetpercentage, geschat vetpercentage via Navy), herkeuring van het doelgewicht (`wgCheck`), hint om de heup te meten (vrouw), cyclusgegevens wissen bij een niet-vrouwelijk profiel en de cyclus aanbieden bij vrouw. Macro's en trainingsschema volgen het doel en blijven gelijk. |
| **Cyclus en overgang** | Alleen voor vrouwen (`prefs.gender === "Vrouw"`), 18+, met gezondheidstoestemming (`cycleAllowed`). `prefs.cycle = { mode: cyclus|overgang, start, len, dur, hist }`; `cyclePhase()` (menstruatie, folliculair, eisprong, luteaal). Luteaal: dagdoel +150 kcal (`cycleKcalExtra` in `dailyKcalTarget`); rond de menstruatie een vochtnotitie bij het wegen; menstruatie: ijzertips; overgang: eiwit, calcium, vitamine D, kracht. Chip in *Jouw doel*, blad `openCycleSheet` met fasebalk en *begonnen* (leert de cycluslengte uit `hist`). Wordt gewist bij intrekken van toestemming (client en `stripHealthData`); gaat niet naar de AI. |
| **Producten met merk en winkel** | Open Food Facts (ODbL) via de server: `GET /api/foods/barcode/<ean>` en `GET /api/foods/search?q=` (NL-producten, 7 dagen bewaard, `offFood`/`offStores` normaliseren merk en supermarkt). In Snel toevoegen staat onder de NEVO-resultaten het blok *In de winkel* (na 450 ms, vanaf 3 tekens); gekozen of gescande producten worden eigen producten met `brand` en `stores`, zichtbaar in de zoekresultaten. |
| **Gerecht aanpassen** | Eigen scherm `editdish` (`renderEditDish`, `openEditDish(item, terug)`): alleen de ingrediënten (per portie), elk met losse velden hoeveelheid, eenheid (`ED_UNITS`, keuzelijst) en product (zoeken in NEVO via `qaSearch`); `edParse`/`edLine` zetten regels om. Bereiding en naam blijven gelijk (kopie krijgt "(aangepast)"). Live doorrekenen via `POST /api/nevo/calc` (geen AI): `nevoNormalizeIngredients` + `nevoPieceToGram` (stuks → gram, `NEVO_PIECE_G`) + `nevoCalculate`; per regel herkend NEVO-product of hint. Opslaan: volledig gedekt → NEVO; anders AI-actie `nevo-recalc` voor dit gerecht; zonder AI de herkende NEVO-som (≥60% gedekt) of de oude macro's. Herberekent kh/eiwit/vet %, Balans, slots in de planning (naam, balans) en bewaart (`updateStoredDishesInDb`), of als kopie. Te openen vanuit gerechten (actieblad), recept (`#recipeEditBtn`), planner (slotmenu) en je dag op Start (`#msEdit`). |
| **Meerdere dagen tegelijk inplannen** | `openMultiPlan(item, { preDays, skipKey })`: dagen in de komende 14 dagen (snelkeuze Vandaag, Werkdagen, Weekend, 7 dagen, 2 weken) × momenten (Ontbijt, Lunch, Diner, Snack; snack op de eerste vrije snackplek). Stippen per dag: vrij, bezet, dit gerecht. Standaard alleen lege plekken, optioneel vervangen; samenvatting vooraf, één undo voor alles. Te openen vanuit gerechten (Inplannen in het actieblad, of selectie van 1), het recept (`#recipePlanBtn`), de planner (slotmenu *Ook op andere dagen*) en het maaltijdblad op Start (`#msRepeat`). |
| **Weetjes en avondsnack** | Weetjes (`WEETJES`, 17 stellingen met antwoord en uitleg, gekoppeld aan doelen en check-in-context): dagelijks één onderaan *Jouw doel* (`renderWeetjeStrip`), alle als veegbare kaarten (`openWeetjes`); antwoorden in `prefs.weetjes = { id: 1|0 }`. Check-in met *Honger of trek in de avond* (of 2+ hongerdagen) toont `renderAvondsnackPicker`: eiwitrijke snacks (`AVONDSNACKS`, NEVO-waarden, vegan-filter), `planAvondsnack` zet er één in *Snack na diner* van vandaag t/m zondag (alleen lege plekken, met ongedaan maken). |
| **Doelplan per doel** | Op Start compact (`renderGoalHome`): aanpak als chips, drie meters per doel (`gpMeters`, ringen), een melding bij stilstand (`gpAlert`) en hooguit drie acties die nu aan de beurt zijn (`gpTodos`: wegen, check-in, meten, bewegen); details in het venster *Jouw voortgang* (`openGoalProgress`, ververst na elke actie via `refreshGoalSheet` in `render`). Weetje van de dag is een eigen tegel (`weetje`). Volledige kaart (`renderGoalCard`, ook in Jouw reis): `goalKey()` (onderhoud, afvallen, cutting, spier, atleet uit `prefs.goal`) kiest de aanpak uit `GP` (voeding, macro's, sport, beweging, wat je meet, beweegdoel in min/week) en de voortgang: afvallen/cutting → doelgewicht + kracht; spier → kracht (`strengthProgress`, Epley uit `training.log`, stilstand = 3 weken niets erbij) + optioneel doelgewicht + omtrekken; atleet → trainingen 4 weken; onderhoud → Balans + stabiel gewicht (±2 kg). Beweging: `prefs.moveLog = { datum: min }` plus afgevinkte trainingen. Doel wijzigen roept `goalChanged(oud)`: overzicht van wat meeging en wat te checken; een doelgewicht dat niet past (`wgFitsGoal`) stopt en telt niet mee voor het dagdoel. Een nieuw doelgewicht zet het doel de goede kant op (`goalForWeightGoal`); bestaande accounts eenmalig via `weightGoal.goalSync`. Check-in krijgt een tip per doel (`ciGoalInsight`). |
| **Doelgewicht** | `prefs.weightGoal = { target, start, startWeek, pace, hide, ms, reachedAt }`, in te stellen op Start (tegel *Jouw doel*, standaard zichtbaar), in Mijn voorkeuren en in de wizard. Tempo rustig/normaal/stevig: afvallen 0,25/0,5/0,75 kg per week, aankomen 0,15/0,25/0,4 (hooguit 1% van het gewicht). Het dagdoel volgt het tempo (± 7.700 kcal per kilo), maar nooit meer dan 25% onder onderhoud en nooit onder 1.200 (vrouw) / 1.500 (man) / 1.350 kcal; aankomen hooguit +15%. Wegingen als weekgemiddelde in `journey.log` (`m: "gewicht"`). Na 3 wegingen een trend (lineair) met verwachte datum en "op schema / sneller / iets langzamer"; mijlpalen bij 25/50/75/100% (bij 100% de vraag om over te stappen op Onderhoud). *Cijfers verbergen* toont alleen procenten. Geen doel met BMI onder 18,5, niet voor minderjarigen, alleen met toestemming voor gezondheidsgegevens (intrekken wist het doel). Eén weging per week op een vast weegmoment (`weighDay`/`weighTime`, standaard maandag 07:30; nuchter, na het plassen); opnieuw invullen verbetert die week. Op het weegmoment de melding "Tijd om te wegen" (`weighIn`) als er die week nog niet gewogen is. **Stilstand**: na 3+ weken en een vlakke of verkeerde trend over de laatste 4 weken een tip in de tegel (één per week, *Niet nu*): kijkt naar de laatste 14 dagen (afvinken, dagen boven dagdoel, eiwit, Balans, extra's in het weekend) en anders een beweegtip; vanaf 6 weken het advies om met een diëtist of huisarts te praten. Knop *Persoonlijke tip van Balanza* stuurt de cijfers naar de assistent; één keer per week ook een gesprekje via de chat. Uit te zetten bij Begeleiding (`goaltips`). Bij het instellen: uitleg *Waarom het tijd nodig heeft*. **Omtrekken**: middel, nek, heup (en optioneel borst, bovenarm, bovenbeen) eens per 4 weken in `journey.log` (`m: "middel"` enz.), met meetinstructies en verschil sinds de eerste meting. Geschat vetpercentage met de Navy-methode (nek, middel, heup bij vrouwen, lengte; alleen bij Man/Vrouw), naast de gezonde marge per leeftijd (Gallagher 2000) en de verhouding middel/lengte (< 0,5 gezond). De doelcheck gebruikt dit als de metingen ≤ 6 weken oud zijn: aankomen boven BMI-grens mag als het geschatte vetpercentage gezond blijft (± helft van de toename als vet), afvallen niet onder het gezonde minimum (± driekwart van het verlies als vet). Intrekken van toestemming wist ook de omtrekken. **Wekelijkse check-in** (na de eerste weging van de week, of via *Check-in* in de tegel): motivatie (1–5), dagen met veel honger (afgelopen 7 dagen), wat goed ging, wat lastig was en een notitie, in `journey.checkins` (laatste 26). Per hongerdag kijkt Balanza naar die dag (kcal t.o.v. dagdoel, eiwit, overgeslagen ontbijt/lunch, veel koolhydraten) en geeft een tip; daarnaast tips per lastig punt en een motivatietekst met je voortgang. *Bespreek met Balanza* stuurt het samen met je doel naar de assistent. Wordt gewist bij intrekken van toestemming. |
| **Verbruik per training** | `trKcal(t, s)`: rustverbruik via Katch-McArdle (met vetpercentage uit omtrekken) of Mifflin-St Jeor; kracht 5 MET, warming-up 3,5, afkoelen 2,5, intervallen 8 (× rustverbruik per minuut); cardio via hartslag (midden van `trHeartZone`), gewicht, leeftijd en geslacht (Keytel e.a. 2005). Zichtbaar in de kop van de training, als blok met uitleg, en in het weekoverzicht. Alleen met gewicht en gezondheidstoestemming. |
| **Trainingsblokken en duur** | Elke 8 weken (`TR_BLOCK_WEEKS`) wisselen oefeningen naar een alternatief voor dezelfde spieren (`EX_ALT`, `trSwapItem`, `trBlock` + `training.shift` voor *Nu andere oefeningen*); per blok bouwt de dosering opnieuw op en is de eerste week een techniekweek. Krachtdag ≥ 60 min (`trFill`): warming-up 10 min, oefeningen (± 2,5 min per set incl. rust; te kort → een set extra), 10 min cardio naar keuze, afkoelen 5 min. Cardiodag: 5 min inlopen, 30–45 min cardio (bouwt per blok op), 10 min afkoelen en rekken. Hartslagzone 130–140, vanaf 55 jaar ± 68–75% van 220 − leeftijd (`trHeartZone`). |
| **Groepslessen** | `GROUP_CLASSES` (Les Mills, pilates reformer, mat-pilates, yoga, overig) met soort en MET. Loggen via *+ Groepsles* in de tegel Training of *Ik deed een groepsles* in een training (`openClassSheet(datum)`): `training.classes[datum] = { id, min, w, autoDone }`. Kracht (BODYPUMP, TONE) telt als de geplande krachtdag, cardio/hiit als cardiodag (`gcMatches`; dan automatisch afgevinkt, bij weghalen weer open); core (CORE, reformer, pilates) en herstel (yoga, BODYBALANCE) tellen als beweging. Verbruik: MET × BMR/1440 × minuten (`gcKcal`). BODYPUMP: gewicht per nummer (`PUMP_TRACKS`), vorige keer als placeholder (`lastPumpWeights`). Telt mee in *Bewegen deze week* en staat in het weekoverzicht. |
| **Winkelproducten (eigen kopie Open Food Facts)** | De server haalt wekelijks de CSV-export van Open Food Facts op (`OFF_DUMP_URL`, standaard `static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz`, ± 0,9 GB), streamt en filtert op `countries_tags` = `en:netherlands`, en bewaart compacte records gezipt in MongoDB-collectie `offnl` (stukken van 6 MB, meta in `offnl/meta`; zonder MongoDB in `data/offnl.json.gz`). Zoeken (`offnlSearch`) gebeurt in het geheugen: per zoekwoord (ook enkelvoud/meervoud via `nlWordForms` en binnen samenstellingen) een score, daarna populariteit (`unique_scans_n`). `/api/foods/search` en `/api/foods/barcode` kijken eerst in de kopie en vallen terug op de live zoekdienst. Verversen: bij opstarten zonder kopie, anders 's nachts als hij ouder is dan 7 dagen (`offnlEnsure`, elk uur); handmatig via `POST /api/admin/offnl`, status via `GET /api/admin/offnl`. `OFFNL_DISABLE=1` zet het uit. Productfoto's: alleen het pad (`/images/products/…`, 200 px) wordt bewaard (`offImgPath`) en geserveerd via `GET /api/foods/img/<pad>` (proxy naar images.openfoodfacts.org; eenmaal opgehaalde foto's blijvend in MongoDB-collectie `offimg`, max. 20.000 ≈ 250 MB; plus klein geheugencache en 30 dagen browsercache); in Snel toevoegen als miniatuur (`qaThumb`), bronvermelding "foto's CC BY-SA". Snel toevoegen heeft een vaste actiebalk onderin (`qa-dock`: totaal, dag/moment, knop), die verdwijnt zodra de echte knop in beeld is of het toetsenbord open staat. Licentie: ODbL, bronvermelding in de app. |
| **Trainingsschema** | Optioneel, tegel *Training* op Start (standaard onder *Jouw doel*). `prefs.training = { on, place: thuis|sportschool, days: [0–6], level: beginner|gevorderd, startWeek (startdatum), done: [datums] }`. Vaste schema's (`PLANS`) per plek en focus; de focus volgt het doel (doelgewicht omlaag/omhoog, of Vetverlies/Cutting → afvallen, Spieropbouw → spier, Atleet → conditie, anders fit). Trainingen (met beschrijvende namen per spiergroep, zoals *Benen, borst en rug*) wisselen om de beurt over de gekozen dagen; opbouw: elke 2 weken een herhaling of 5 sec/min erbij, na 4 weken een set erbij, elke 6e week een herstelweek; gevorderd start een stap verder. Oefeningen met uitleg (`EX`) en een uitlegfilmpje (`EX_VIDEO`, YouTube-id's): de speler (youtube-nocookie.com) laadt pas na een tik op *Bekijk hoe het moet*; daaronder altijd een link naar YouTube (zonder id een zoeklink). In de tegel zijn de trainingsdagen aan te tikken (opent die training) en *Weekoverzicht* (`openTrainingWeek(offset)`) toont alle trainingen per week met de oefeningen, bladeren tot 8 weken vooruit; vanuit een training terug naar het weekoverzicht. Een training is op elke dag af te vinken. In de planner (week en dag) een regel *Training*, afvinken in de tegel of in de training. Intensiteit: elke set tot spierfalen (technisch falen: de laatste nette herhaling), ook bij zware vrije oefeningen; beginners de eerste 4 weken techniek eerst (1–2 in reserve). Per set gewicht en herhalingen (of seconden) in `training.log[oefening] = [{ d, sets: [{ kg, r }] }]`; dubbele progressie: alle sets op de bovenkant → +2,5 kg (onder 20 kg +1 kg), meer dan de bovenkant → te licht (bij +4 of meer een dubbele stap), anders zelfde gewicht en 1 herhaling meer. Live waarschuwing als je meer dan de bovenkant invult. Reeks: weken op rij alle trainingen gedaan. Geen AI, gratis. |
| **Terugkomen na een lege week** | Staat er voor de rest van de week (bijna) niets, dan is *Vul mijn week* de hoofdknop op Start (als voorstel om te wisselen en goed te keuren). De weekstrook toont vanaf twee weken "Xe week op rij dat je plant". Zodra er iets gepland staat, vraagt Balanza één keer of meldingen aan mogen (op iPhone in Safari eerst: zet op beginscherm). |

### Jouw reis (motivatie op weg naar je doel)

Gebaseerd op wat in gedragspsychologie werkt: zelf kiezen, kleine successen, zichtbare vooruitgang en identiteit
("je bent iemand die zelf kookt"), zonder schuld of reeksen die breken. Alles staat in `prefs.journey`; geen extra meldingen.

- **Waarom en tempo**: in de wizard (stap Doel) en op het scherm *Jouw reis*. De app gebruikt het waarom later in de tekst ("op weg naar meer energie").
- **Fases per doel** (bijv. vetverlies: Wennen → Ritme → Verfijnen → Volhouden), elk met één focus. Tempo rustig/normaal/stevig maakt de fases langer of korter. Een nieuw doel begint een nieuwe reis; mijlpalen blijven gehaald.
- **Weekuitdaging**: elke week drie voorstellen die bij de fase passen (bijv. "Plan 5 avonden vooruit", "Eiwit op je doel"), de gebruiker kiest er één of slaat over. De voortgang wordt uit de planning berekend.
- **Mijlpalen** over gedrag (zelf gekookt, goed geplande weken, uitdagingen, favorieten), één kaartje tegelijk. Een goede week = 4 of meer dagen met een plan.
- **Welkom terug**: na 8+ dagen weg geen verwijt, maar "Zullen we deze week simpel beginnen?" met alleen de diners.
- **Voortgang (optioneel)**: energie, verzadiging, kleding of gewicht, één keer per week, als trend. Bij een gewicht onder een gezond BMI met een afvaldoel adviseert de app Onderhoud en een huisarts of diëtist.
- **Toon** (coachend, zakelijk, luchtig) en **rustige modus** (geen kaartjes of felicitaties op Start).
- De terugblik op maandag laat ook de uitdaging en de fase zien.
- Onder **Instellingen → Begeleiding** staan aparte schakelaars voor Jouw reis, Weekuitdaging, Mijlpalen en Voortgang bijhouden.

### Jongeren (16–25)

- **Leeftijd als bereik** (16–17, 18–25, 26–40, 41+) in de wizard en bij *Jij & je doel*; nooit een geboortedatum.
- **Onder de 18** (bereik 16–17 of leeftijd onder 18): geen afvaldoelen (Vetverlies, Cutting) en geen gewicht bijhouden. De server dwingt dit ook af (`applyAgeRules`) en geeft de AI een extra regel: genoeg energie, eiwit, calcium en ijzer, geen calorietekort, geen dieetproducten. Tips gaan dan niet over afvallen of gewicht.
- **Budgetmodus** (*Budget & tijd*, ook in de wizard): weekbudget €25/35/50/75, optioneel weinig spullen (1 pan) en snel (max 25 min). De AI krijgt een prijs per portie mee; in de boodschappenlijst staat na een kostenschatting of je binnen je budget blijft.
- **Delen als afbeelding**: "Deel je week als afbeelding" in de planner en "Deel als afbeelding" bij een gerecht (1080×1350, voor Instagram, TikTok of WhatsApp; via delen op de telefoon, anders downloaden).
- **Vrienden uitdagen**: bij de weekuitdaging een WhatsApp-bericht met een link naar /welkom.
- De toon van *Jouw reis* staat voor 16–25 standaard op luchtig.

### Inspreken (spraakinvoer)

Een microfoonknop naast het tekstveld van de chat en bij "Wens voor deze keer". De spraakherkenning van de browser zet wat je
zegt (Nederlands) om in tekst in het veld; je controleert en past het aan voordat je verstuurt. Kost geen AI. Toestellen of
browsers zonder spraakherkenning zien geen knop. Aan/uit onder **Instellingen → Begeleiding → Inspreken**. Let op: sommige
browsers (zoals Chrome) laten de spraak door hun eigen dienst omzetten; de browser vraagt eerst toestemming voor de microfoon.

**In de chat, na inspreken:**
- **Vanzelf versturen**: is de herkenning klaar, dan verschijnt "Versturen over 2 tellen" met een balkje; tik je op je tekst
  of begin je te typen, dan wacht hij zodat je kunt corrigeren. "Nu versturen" kan ook. Schakelaar: *Begeleiding → Na inspreken vanzelf versturen*.
- **Plannen via de chat** (`plan_week`): "plan ontbijt en diner voor elke dag, en maak gerechten als ze er niet zijn" plant de
  gevraagde momenten voor elke nog lege dag. Met `generate` maakt de app eerst nieuwe gerechten als er per moment te weinig zijn
  (telt mee voor de maandlimiet) en plant ze daarna in. De chat meldt het resultaat ("Klaar! 4 maaltijden ingepland, met 7 nieuwe
  gerechten") of wat er nog leeg is.

### Balanza-assistent (chat)

Een chatknop rechtsboven in de app. Gebruikers stellen vragen over de app en hun eten, of laten de app aanpassen
("ik wil vegetarisch eten", "zet volgende week klaar", "maak de app donker", "community bovenaan").

- **Vaste lijst acties** (`POST /api/assistant`): doel, voedingsstijl, gezondheidsfilters, uitsluitingen, maaltijdmomenten en aantal,
  keukens, smaken, niveau, kindvriendelijk, budgetmodus, begeleiding, Jouw reis (tempo, toon, rustige modus), meldingen, thema,
  indeling van Start, navigeren, week klaarzetten, gerechten ontwerpen met een wens (de gebruiker start zelf) en restjes.
  De server controleert elke actie; onbekende acties of waarden buiten de kaders vallen weg.
- **De gebruiker bevestigt** elk voorstel met *Doen* en kan het daarna in dezelfde sessie *ongedaan maken*.
- **Vaste kaders**: macroverdeling per doel, Balans-controle, NEVO, voedingsregels en de regels voor jongeren zijn geen actie.
  Onder de 18 (volgens de opgeslagen voorkeuren) stelt de assistent geen afvaldoel voor. Geen medisch advies.
- **Kosten en limieten**: onderdeel "Balanza-assistent (chat)" in Beheer → Instellingen → Onderdelen (aan/uit, of "Alleen Plus"),
  limiet "Berichten aan de assistent per gebruiker per dag" (standaard 40, `ASSISTANT_DAILY_PER_USER`) en 120 per uur per IP.
  Kosten tellen mee in het verbruik (actie "assistant"). Ander model: `ANTHROPIC_ASSISTANT_MODEL`.
- Het gesprek wordt op het toestel bewaard (per account, de laatste 50 berichten) en is te wissen met *Wissen* in de chat; de server bewaart geen chatgeschiedenis.
- **Openingszinnetje**: hooguit één keer per dag verschijnt na een paar seconden op Start een klein tekstballonnetje bij de
  chatknop (met een stipje op de knop), persoonlijk en op basis van wat er speelt: het diner van vanavond, volgende week
  klaarzetten, restjes, de fase van je reis of het seizoen. Om de paar dagen is het de uitnodiging om een idee te delen.
  Het zinnetje komt meteen ook in het gesprek; de chatknop houdt een stipje tot je de chat opent. Tik = de chat opent met die zin en twee snelle antwoorden; × of 15 seconden = het wolkje verdwijnt. Kost geen AI. Niet tijdens genereren of
  in de rustige modus; uit te zetten onder *Begeleiding → Balanza begint soms een gesprekje*.
- **Ideeën aanvragen**: de welkomsttekst van de chat, een snelle keuze "Ik heb een idee voor Balanza" en een regel onder het
  invoerveld laten zien dat je nieuwe functies via de chat kunt aanvragen.

### Ideeën van gebruikers

Kan de assistent iets niet (de functie bestaat niet, of het valt buiten de kaders), dan zegt hij dat eerlijk, noemt een
alternatief en vraagt: "Wil je hier een idee voor nieuwe functionaliteit van maken?". Daaronder staat een kaart met het
idee (titel en gebruikersverhaal) en de knoppen *Ja, stuur in* en *Nee, laat maar*.

- **Functioneel uitgeschreven**: titel, onderdeel, gebruikersverhaal ("Als gebruiker wil ik …, zodat …"), probleem, voorstel,
  acceptatiecriteria, hoe het zich verhoudt tot de kaders (macrobalans per doel, Balans-score, NEVO, voedingsregels), geschatte
  impact en de oorspronkelijke vraag van de gebruiker. Opgeslagen als `suggestions/<id>`.
- **Beheer → Voorstellen**: filter op Nieuw, Geaccepteerd of Afgewezen. Openen toont het hele voorstel; *Accepteren* of *Afwijzen*
  vult een vriendelijk, motiverend bericht voor (aanpasbaar) en *Versturen* stuurt het naar de gebruiker. Ook *Verwijderen* (zonder
  bericht) en *Opnieuw beoordelen*. Op het Overzicht staat een aandachtspunt bij nieuwe ideeën; besluiten staan in het auditlog.
- **De gebruiker** krijgt het bericht als kaart bovenaan Start (`inbox/<uid>`) en, als meldingen aan staan, een pushmelding.
  Onder *Mijn profiel → Mijn ideeën* staat de stand van zijn ideeën.
- Hooguit 10 ideeën per uur per gebruiker; een gelijk idee dat nog openstaat wordt niet dubbel opgeslagen.
- **GitHub-issues** (optioneel, met `GITHUB_TOKEN`): elk ingestuurd idee wordt een issue in `GITHUB_REPO` (standaard
  `coretic1980/weekmenu-app`) met de labels `idee-van-gebruiker` en `nieuw`. Bij accepteren wordt het label `geaccepteerd`
  (issue blijft open, met een opmerking); bij afwijzen `afgewezen` en wordt het issue gesloten als "not planned". Sluit je een
  geaccepteerd issue als **voltooid**, dan krijgt de indiener binnen ~10 minuten bericht ("Je idee staat live") en wordt de status
  *Live* (label `live`). In de admin staat bij elk voorstel de link naar het issue en een knop "GitHub nu controleren".
  **Er komen nooit namen, e-mailadressen of de letterlijke vraag van de gebruiker in het issue** (de repo is openbaar).
  Lukt het aanmaken niet, dan staat de fout bij het voorstel en probeert de server het later opnieuw.
- Token maken: GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*; Repository access: alleen
  deze repo; Permissions → Repository permissions → **Issues: Read and write** (verder niets). Zet hem als `GITHUB_TOKEN` in je omgeving.

In de beheerconsole staan de nieuwe meldingen bij *Overzicht → Meldingen* en in het logboek (soort "Samen plannen" voor
het huishouden). Bij een gebruiker staat of hij samen plant.

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
