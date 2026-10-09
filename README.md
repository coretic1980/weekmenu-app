# Balanza

Nederlandse AI-maaltijdplanner voor fitnessdoelen: macro-gebalanceerde gerechten, weekplanning,
boodschappenlijst, prepdag, kookmodus en PDF-export. Op smartphones werkt de app met een tabbalk
onderin, zoals een native app. De macro's worden berekend met het
Nederlands Voedingsstoffenbestand (NEVO) van het RIVM.

## Projectstructuur

```
index.html                    De volledige app in één bestand (HTML, CSS, JS en ingebouwde NEVO-data)
data/nevo2025_macros.json     NEVO-subset: code, naam, kcal, eiwit, koolhydraten, vet (per 100 g)
scripts/build_nevo_subset.py  Bouwt de subset opnieuw uit het officiële NEVO-bestand
scripts/inject_nevo.py        Zet de subset in het nevo-data-blok van index.html
docs/NEVO-voorwaarden-2025.pdf  Gebruiksvoorwaarden van de NEVO-dataset
NOTICE.md                     Bronvermelding NEVO
CHANGELOG.md                  Wijzigingen
```

`index.html` is bewust één zelfstandig bestand, omdat het als Claude-artifact wordt gepubliceerd.

## Runtime

De app draait op claude.ai als gepubliceerd artifact en gebruikt de artifact-runtime via
`claude.use(...)`:

| Capability  | Waarvoor                                                      |
|-------------|---------------------------------------------------------------|
| `sample`    | Gerechten, varianten, prepdag en tips laten genereren door Claude |
| `db`        | Voorkeuren, opgeslagen gerechten en weekplanningen per gebruiker |
| `user`      | Gebruikers-id voor de privé-opslag onder `data/users/<id>/`     |
| `downloads` | PDF-export opslaan                                            |

Buiten claude.ai geven deze capabilities `null` terug: de app laadt dan wel, maar kan niets
genereren of opslaan. Voor een eigen hosting zijn vervangers nodig (bijv. een eigen API-endpoint
voor generatie en een eigen database). Externe afhankelijkheden: jsPDF (cdnjs) en Google Fonts.

## NEVO-data bijwerken

1. Download de nieuwe dataset via https://nevo-online.rivm.nl/ (akkoord met de voorwaarden).
2. `python3 scripts/build_nevo_subset.py pad/naar/NEVO20xx.zip`
3. `python3 scripts/inject_nevo.py`
4. Pas `NEVO_VERSION` en `NEVO_REFERENCE` in `index.html` en de tekst in `NOTICE.md` aan.

Het ruwe NEVO-bestand zelf hoort niet in de repo (zie `.gitignore`).

## Macroberekening in het kort

- De AI levert per ingrediënt `{tekst, gram, nevo}`; Balanza koppelt `nevo` aan een NEVO-product
  (exacte naam, aliaslijst of woordmatching) en rekent kcal en macro's zelf uit.
- Alleen als alle relevante ingrediënten gematcht zijn, krijgt een gerecht de groene NEVO-badge;
  anders blijft het een gelabelde AI-schatting. Zout, peper en kruiden tellen niet mee.
- Eiwitpoeder staat niet in NEVO en is als aparte, gemarkeerde Balanza-aanvulling toegevoegd.
