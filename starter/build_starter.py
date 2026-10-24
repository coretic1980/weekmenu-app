# Bouwt starter/starter_dishes.json: vaste startgerechten voor nieuwe gebruikers.
# 4 profielen (licht, balans, eiwit, sport) x 4 maaltijdmomenten x 5 gerechten.
# Porties zijn de basis (± 2.000 kcal per dag); de server schaalt ze naar het dagdoel en rekent de macro's met NEVO.
# Ingrediënt: "tekst | gram | NEVO-zoekterm" (gram 0 = verwaarloosbaar, zoals kruiden).
# Draaien: python3 starter/build_starter.py
import json, os, re

SRC = r"""
@licht
# Ontbijt
Magere kwark met bessen en lijnzaad | 5 | kwark met bessen
- 200 g magere kwark | 200 | kwark mager
- 100 g blauwe bessen | 100 | blauwe bessen
- 10 g lijnzaad | 10 | lijnzaad
- kaneel naar smaak | 0 |
> Schep de kwark in een kom.
> Verdeel de bessen erover en bestrooi met lijnzaad en kaneel.

Omelet met spinazie en champignons | 10 | omelet spinazie
- 2 eieren | 100 | ei
- 100 g champignons | 100 | champignons
- 50 g spinazie | 50 | spinazie
- 1 snee volkorenbrood | 35 | volkorenbrood
- 5 ml olijfolie | 5 | olijfolie
- peper en zout naar smaak | 0 |
> Bak de champignons 3 minuten in de olie, voeg de spinazie toe en laat slinken.
> Klop de eieren los met peper en zout en giet over de groente. Bak op laag vuur gaar.
> Serveer met de snee volkorenbrood.

Havermout met appel en kaneel | 8 | havermout appel
- 40 g havermout | 40 | havermout
- 200 ml magere melk | 200 | melk mager
- 1 appel (150 g) | 150 | appel
- kaneel naar smaak | 0 |
> Breng de melk met de havermout aan de kook en laat 3 minuten zachtjes koken, al roerend.
> Snijd de appel in blokjes en schep erdoor. Bestrooi met kaneel.

Volkoren crackers met hüttenkäse en radijs | 5 | crackers huttenkase
- 3 volkoren crackers (30 g) | 30 | knackebrod volkoren
- 100 g hüttenkäse | 100 | cottage cheese
- 60 g radijs | 60 | radijs
- 50 g komkommer | 50 | komkommer
- peper naar smaak | 0 |
> Besmeer de crackers met hüttenkäse.
> Beleg met plakjes radijs en komkommer en maak af met peper.

Skyr met aardbeien en muesli | 5 | skyr aardbeien
- 200 g skyr naturel | 200 | skyr
- 125 g aardbeien | 125 | aardbeien
- 20 g muesli zonder toegevoegde suiker | 20 | muesli
> Schep de skyr in een kom.
> Snijd de aardbeien in stukjes en verdeel samen met de muesli over de skyr.

# Lunch
Groentesoep met kip | 25 | groentesoep kip
- 100 g kipfilet | 100 | kipfilet rauw
- 1 ui (100 g) | 100 | ui
- 1 wortel (100 g) | 100 | Wortel rauw gem
- 100 g prei | 100 | prei
- 100 g knolselderij | 100 | Selderij knol- rauw
- 500 ml water met 1/2 groentebouillontablet | 0 |
- 1 snee volkorenbrood | 35 | volkorenbrood
> Snijd de groente en de kip in blokjes.
> Breng het water met de bouillon aan de kook, voeg kip en groente toe en laat 15 minuten zachtjes koken.
> Serveer met de snee volkorenbrood.

Salade met kip en quinoa | 20 | quinoasalade kip
- 40 g quinoa | 40 | quinoa
- 100 g kipfilet | 100 | kipfilet rauw
- 75 g sla | 75 | sla
- 100 g cherrytomaten | 100 | tomaat
- 75 g komkommer | 75 | komkommer
- 10 ml olijfolie | 10 | olijfolie
- 1 el citroensap | 0 |
> Kook de quinoa 12 minuten en laat afkoelen.
> Bak de kipfilet in een droge koekenpan gaar en snijd in reepjes.
> Meng sla, tomaat, komkommer en quinoa, leg de kip erop en besprenkel met olie en citroensap.

Roggebrood met ei en tomaat | 10 | roggebrood ei
- 2 sneetjes roggebrood (80 g) | 80 | roggebrood
- 2 eieren | 100 | ei
- 1 tomaat (100 g) | 100 | tomaat
- 30 g rucola | 30 | rucola
- peper en zout naar smaak | 0 |
> Kook de eieren in 8 minuten hard, laat schrikken en snijd in plakjes.
> Beleg het roggebrood met rucola, tomaat en ei. Maak af met peper en zout.

Wrap met kalkoen en groente | 10 | wrap kalkoen
- 1 volkoren wrap (60 g) | 60 | wrap volkoren
- 75 g kalkoenfilet (vleeswaren) | 75 | Kalkoenfilet (vleeswaar)
- 30 g hummus | 30 | hummus
- 50 g sla | 50 | sla
- 75 g paprika | 75 | Paprika rode rauw
> Besmeer de wrap met hummus.
> Beleg met sla, reepjes paprika en kalkoen en rol strak op. Snijd schuin doormidden.

Bloemkoolrijst met garnalen | 20 | Kool bloem- rauwrijst garnalen
- 300 g bloemkool | 300 | Kool bloem- rauw
- 125 g garnalen | 125 | garnalen
- 100 g doperwten | 100 | doperwten
- 1 teen knoflook | 0 |
- 10 ml olijfolie | 10 | olijfolie
- 1 el ketjap | 15 | Ketjap zoet
> Rasp de bloemkool grof of hak hem fijn in een keukenmachine.
> Fruit de knoflook in de olie, voeg bloemkool en doperwten toe en bak 5 minuten.
> Voeg de garnalen en ketjap toe en verwarm nog 2 minuten.

# Diner
Kabeljauw met broccoli en krieltjes | 25 | kabeljauw broccoli
- 150 g kabeljauw | 150 | kabeljauw rauw
- 200 g broccoli | 200 | broccoli
- 150 g krieltjes | 150 | aardappelen
- 10 ml olijfolie | 10 | olijfolie
- 1 citroen (partje) | 0 |
- peper en zout naar smaak | 0 |
> Kook de krieltjes in 15 minuten gaar. Kook of stoom de broccoli de laatste 5 minuten mee.
> Bak de kabeljauw 3 tot 4 minuten per kant in de olie. Breng op smaak met peper, zout en citroen.

Kip uit de oven met geroosterde groenten | 35 | kip oven groenten
- 125 g kipfilet | 125 | kipfilet rauw
- 150 g courgette | 150 | courgette
- 150 g paprika | 150 | Paprika rode rauw
- 100 g rode ui | 100 | ui
- 125 g zoete aardappel | 125 | zoete aardappel
- 10 ml olijfolie | 10 | olijfolie
- 1 tl paprikapoeder | 0 |
> Verwarm de oven voor op 200 °C.
> Snijd groente en zoete aardappel in stukken, meng met olie en paprikapoeder en rooster 15 minuten.
> Leg de kipfilet erbij en rooster nog 18 tot 20 minuten, tot de kip gaar is.

Courgetti met kalkoengehaktballetjes | 30 | courgetti gehaktballetjes
- 125 g kalkoengehakt | 125 | kipgehakt
- 300 g courgette | 300 | courgette
- 200 g tomatenblokjes (blik) | 200 | tomaten uit blik
- 1 ui (100 g) | 100 | ui
- 1 teen knoflook | 0 |
- 5 ml olijfolie | 5 | olijfolie
- 10 g Parmezaanse kaas | 10 | parmezaanse kaas
- Italiaanse kruiden naar smaak | 0 |
> Draai kleine balletjes van het gehakt en bak ze rondom bruin in de olie.
> Voeg ui, knoflook en tomatenblokjes toe en laat 10 minuten zacht koken.
> Snijd de courgette in slierten en roerbak 2 minuten. Serveer met de saus en Parmezaanse kaas.

Groentecurry met kikkererwten | 30 | groentecurry kikkererwten
- 120 g kikkererwten (blik, uitgelekt) | 120 | kikkererwten gekookt
- 150 g bloemkool | 150 | Kool bloem- rauw
- 100 g spinazie | 100 | spinazie
- 1 ui (100 g) | 100 | ui
- 100 ml kokosmelk light | 100 | kokosmelk
- 100 g tomatenblokjes (blik) | 100 | tomaten uit blik
- 1 el currypasta | 0 |
- 40 g zilvervliesrijst | 40 | zilvervliesrijst
> Kook de rijst volgens de verpakking.
> Fruit de ui, voeg currypasta en bloemkool toe en bak 3 minuten.
> Voeg tomaat, kokosmelk en kikkererwten toe en laat 12 minuten zacht koken. Roer op het laatst de spinazie erdoor.

Spitskoolstamppot met mager gehakt | 30 | Kool spits- rauw stamppot
- 200 g aardappelen | 200 | aardappelen
- 200 g spitskool | 200 | Kool spits- rauw
- 100 g rundergehakt mager | 100 | rundergehakt mager
- 50 ml magere melk | 50 | melk mager
- nootmuskaat, peper en zout naar smaak | 0 |
> Kook de aardappelen in 20 minuten gaar. Kook de gesneden spitskool de laatste 5 minuten mee.
> Rul het gehakt in een koekenpan gaar en breng op smaak.
> Stamp aardappelen en spitskool met de melk en nootmuskaat en schep het gehakt erdoor.

# Snack
Komkommer met cottage cheese | 3 | komkommer cottage cheese
- 150 g komkommer | 150 | komkommer
- 75 g hüttenkäse | 75 | cottage cheese
- peper en bieslook naar smaak | 0 |
> Snijd de komkommer in plakken en schep de hüttenkäse erop. Maak af met peper en bieslook.

Skyr met kaneel | 2 | skyr kaneel
- 150 g skyr naturel | 150 | skyr
- kaneel naar smaak | 0 |
> Schep de skyr in een schaaltje en bestrooi met kaneel.

Appel met een paar walnoten | 2 | appel walnoten
- 1 appel (150 g) | 150 | appel
- 10 g walnoten | 10 | walnoten
> Snijd de appel in partjes en eet met de walnoten.

Ei met cherrytomaten | 10 | ei tomaatjes
- 1 ei | 50 | ei
- 100 g cherrytomaten | 100 | tomaat
- peper en zout naar smaak | 0 |
> Kook het ei in 8 minuten hard, laat schrikken en pel.
> Serveer met de cherrytomaten, peper en zout.

Edamame met zeezout | 6 | edamame
- 100 g edamame (diepvries, gepeld) | 100 | sojabonen
- snufje zeezout | 0 |
> Kook de edamame 4 minuten, giet af en bestrooi met een snufje zout.

@balans
# Ontbijt
Havermout met appel, walnoten en kaneel | 10 | havermout appel walnoten
- 50 g havermout | 50 | havermout
- 250 ml halfvolle melk | 250 | melk halfvol
- 1 appel (150 g) | 150 | appel
- 10 g walnoten | 10 | walnoten
- kaneel naar smaak | 0 |
> Breng de melk met de havermout aan de kook en laat 3 minuten zachtjes koken, al roerend.
> Schep de appelblokjes erdoor en maak af met walnoten en kaneel.

Volkoren boterhammen met ei en tomaat | 10 | boterham ei tomaat
- 2 sneetjes volkorenbrood (70 g) | 70 | volkorenbrood
- 2 eieren | 100 | ei
- 1 tomaat (100 g) | 100 | tomaat
- 5 g halvarine | 5 | halvarine
- peper en zout naar smaak | 0 |
> Kook de eieren in 8 minuten hard en snijd in plakjes.
> Besmeer het brood dun met halvarine en beleg met tomaat en ei.

Yoghurt met muesli en blauwe bessen | 5 | yoghurt muesli
- 200 g volle yoghurt | 200 | yoghurt vol
- 40 g muesli zonder toegevoegde suiker | 40 | muesli
- 100 g blauwe bessen | 100 | blauwe bessen
> Schep de yoghurt in een kom en verdeel de muesli en bessen erover.

Roggebrood met hüttenkäse en komkommer | 5 | roggebrood huttenkase
- 2 sneetjes roggebrood (80 g) | 80 | roggebrood
- 100 g hüttenkäse | 100 | cottage cheese
- 80 g komkommer | 80 | komkommer
- 1 kiwi (75 g) | 75 | kiwi
> Besmeer het roggebrood met hüttenkäse en beleg met komkommer.
> Eet de kiwi erbij.

Smoothie met banaan, spinazie en pindakaas | 5 | smoothie banaan spinazie
- 1 banaan (120 g) | 120 | banaan
- 150 g yoghurt halfvol | 150 | yoghurt halfvol
- 30 g spinazie | 30 | spinazie
- 20 g havermout | 20 | havermout
- 10 g pindakaas | 10 | pindakaas
- 100 ml halfvolle melk | 100 | melk halfvol
> Doe alles in een blender en mix tot een gladde smoothie.

# Lunch
Volkoren wrap met kip en hummus | 15 | wrap kip hummus
- 1 volkoren wrap (60 g) | 60 | wrap volkoren
- 100 g kipfilet | 100 | kipfilet rauw
- 30 g hummus | 30 | hummus
- 50 g sla | 50 | sla
- 75 g paprika | 75 | Paprika rode rauw
- 5 ml olijfolie | 5 | olijfolie
> Bak de kipfilet in reepjes gaar in de olie.
> Besmeer de wrap met hummus, beleg met sla, paprika en kip en rol op.

Linzensoep met volkorenbrood | 30 | linzensoep
- 60 g rode linzen (droog) | 60 | Linzen groene en bruine gedroogd
- 1 ui (100 g) | 100 | ui
- 1 wortel (100 g) | 100 | Wortel rauw gem
- 200 g tomatenblokjes (blik) | 200 | tomaten uit blik
- 400 ml water met 1/2 groentebouillontablet | 0 |
- 1 tl komijn | 0 |
- 1 snee volkorenbrood | 35 | volkorenbrood
- 5 ml olijfolie | 5 | olijfolie
> Fruit ui en wortel in de olie met de komijn.
> Voeg linzen, tomaat en bouillon toe en laat 20 minuten zachtjes koken. Pureer eventueel grof.
> Serveer met de snee volkorenbrood.

Salade met tonijn, ei en mais | 15 | salade tonijn ei
- 1 blikje tonijn in water (120 g) | 120 | tonijn in water
- 1 ei | 50 | ei
- 100 g sla | 100 | sla
- 100 g tomaat | 100 | tomaat
- 50 g mais | 50 | mais
- 10 ml olijfolie | 10 | olijfolie
- 1 pitabroodje (60 g) | 60 | Tarwebrood wit pita
> Kook het ei hard en snijd in partjes.
> Meng sla, tomaat en mais, verdeel de tonijn en het ei erover en besprenkel met olie.
> Eet het pitabroodje erbij.

Volkoren boterhammen met zalm en avocado | 10 | boterham zalm avocado
- 2 sneetjes volkorenbrood (70 g) | 70 | volkorenbrood
- 50 g gerookte zalm | 50 | zalm gerookt
- 1/2 avocado (70 g) | 70 | avocado
- 30 g rucola | 30 | rucola
- citroensap en peper naar smaak | 0 |
> Prak de avocado met citroensap en peper en besmeer het brood.
> Beleg met rucola en gerookte zalm.

Couscoussalade met kikkererwten en feta | 15 | couscous kikkererwten feta
- 50 g volkoren couscous | 50 | couscous
- 100 g kikkererwten (blik, uitgelekt) | 100 | kikkererwten gekookt
- 30 g feta | 30 | feta
- 75 g komkommer | 75 | komkommer
- 75 g cherrytomaten | 75 | tomaat
- 10 ml olijfolie | 10 | olijfolie
- verse munt of peterselie naar smaak | 0 |
> Giet kokend water over de couscous, dek af en laat 5 minuten wellen.
> Meng met kikkererwten, komkommer, tomaat en kruiden, verkruimel de feta erover en besprenkel met olie.

# Diner
Zalm met krieltjes en sperziebonen | 25 | zalm sperziebonen
- 125 g zalmfilet | 125 | zalm rauw
- 200 g krieltjes | 200 | aardappelen
- 200 g sperziebonen | 200 | sperziebonen
- 5 ml olijfolie | 5 | olijfolie
- citroen, peper en zout naar smaak | 0 |
> Kook de krieltjes in 15 minuten gaar en de sperziebonen in 8 minuten.
> Bak de zalm 3 tot 4 minuten per kant in de olie. Breng op smaak met citroen, peper en zout.

Volkorenpasta met kip, tomaat en spinazie | 25 | pasta kip spinazie
- 75 g volkorenpasta | 75 | volkorenpasta
- 100 g kipfilet | 100 | kipfilet rauw
- 200 g tomatenblokjes (blik) | 200 | tomaten uit blik
- 100 g spinazie | 100 | spinazie
- 1 ui (100 g) | 100 | ui
- 10 ml olijfolie | 10 | olijfolie
- 10 g Parmezaanse kaas | 10 | parmezaanse kaas
> Kook de pasta volgens de verpakking.
> Bak de kip in blokjes met de ui in de olie, voeg tomaat toe en laat 8 minuten zacht koken.
> Roer de spinazie erdoor tot hij slinkt, schep de pasta erdoor en bestrooi met Parmezaanse kaas.

Kip-groentewok met zilvervliesrijst | 25 | wok kip groente
- 100 g kipfilet | 100 | kipfilet rauw
- 60 g zilvervliesrijst | 60 | zilvervliesrijst
- 150 g broccoli | 150 | broccoli
- 100 g taugé | 100 | Tauge rauw
- 10 ml zonnebloemolie | 10 | zonnebloemolie
- 1 el sojasaus | 15 | sojasaus
- 1 teen knoflook en een stukje gember | 0 |
> Kook de rijst volgens de verpakking.
> Roerbak de kip in de hete olie bruin, voeg knoflook, gember en groente toe en wok 4 minuten.
> Blus af met sojasaus en serveer met de rijst.

Chili sin carne met bruine bonen | 30 | chili sin carne
- 150 g kidneybonen (blik, uitgelekt) | 150 | kidneybonen gekookt
- 1 ui (100 g) | 100 | ui
- 1 paprika (150 g) | 150 | Paprika rode rauw
- 200 g tomatenblokjes (blik) | 200 | tomaten uit blik
- 50 g mais | 50 | mais
- 50 g zilvervliesrijst | 50 | zilvervliesrijst
- 10 ml olijfolie | 10 | olijfolie
- 1 tl chilipoeder en komijn | 0 |
> Kook de rijst volgens de verpakking.
> Fruit ui en paprika in de olie met de kruiden. Voeg tomaat, bonen en mais toe en laat 15 minuten zacht koken.
> Serveer met de rijst.

Shakshuka met volkorenbrood | 25 | shakshuka
- 2 eieren | 100 | ei
- 1 ui (100 g) | 100 | ui
- 1 paprika (150 g) | 150 | Paprika rode rauw
- 400 g tomatenblokjes (blik) | 400 | tomaten uit blik
- 10 ml olijfolie | 10 | olijfolie
- 20 g feta | 20 | feta
- 2 sneetjes volkorenbrood (70 g) | 70 | volkorenbrood
- 1 tl komijn en paprikapoeder | 0 |
> Fruit ui en paprika in de olie met de kruiden, voeg tomaat toe en laat 10 minuten inkoken.
> Maak twee kuiltjes, breek er de eieren in, dek af en laat 6 tot 8 minuten garen.
> Verkruimel de feta erover en serveer met het brood.

# Snack
Appel met pindakaas | 2 | appel pindakaas
- 1 appel (150 g) | 150 | appel
- 15 g pindakaas | 15 | pindakaas
> Snijd de appel in partjes en dip in de pindakaas.

Handje noten met een mandarijn | 1 | noten mandarijn
- 20 g ongezouten gemengde noten | 20 | noten gemengd ongezouten
- 1 mandarijn (80 g) | 80 | mandarijn
> Pel de mandarijn en eet met de noten.

Kwark met frambozen | 3 | kwark frambozen
- 150 g magere kwark | 150 | kwark mager
- 75 g frambozen | 75 | frambozen
> Schep de kwark in een schaaltje en verdeel de frambozen erover.

Worteltjes met hummus | 3 | wortel hummus
- 125 g winterwortel | 125 | Wortel rauw gem
- 40 g hummus | 40 | hummus
> Snijd de wortel in staafjes en dip in de hummus.

Volkoren crackers met kaas en komkommer | 3 | crackers kaas
- 2 volkoren crackers (20 g) | 20 | knackebrod volkoren
- 20 g 30+ kaas | 20 | kaas 30+
- 50 g komkommer | 50 | komkommer
> Beleg de crackers met kaas en plakjes komkommer.

@eiwit
# Ontbijt
Omelet met kaas en volkorenbrood | 10 | omelet kaas
- 3 eieren | 150 | ei
- 20 g geraspte 30+ kaas | 20 | kaas 30+
- 50 g spinazie | 50 | spinazie
- 2 sneetjes volkorenbrood (70 g) | 70 | volkorenbrood
- 5 ml olijfolie | 5 | olijfolie
> Klop de eieren los, roer kaas en spinazie erdoor en bak op laag vuur in de olie tot de omelet gestold is.
> Serveer met het volkorenbrood.

Kwark met havermout en banaan | 5 | kwark havermout banaan
- 250 g magere kwark | 250 | kwark mager
- 40 g havermout | 40 | havermout
- 1 banaan (120 g) | 120 | banaan
- 10 g walnoten | 10 | walnoten
> Meng de kwark met de havermout.
> Snijd de banaan in plakjes en verdeel samen met de walnoten erover.

Eiwitpannenkoekjes met kwark en bessen | 15 | eiwitpannenkoekjes
- 50 g havermout | 50 | havermout
- 2 eieren | 100 | ei
- 100 g magere kwark | 100 | kwark mager
- 1/2 banaan (60 g) | 60 | banaan
- 5 ml zonnebloemolie | 5 | zonnebloemolie
- 75 g blauwe bessen | 75 | blauwe bessen
> Mix havermout, eieren, kwark en banaan tot een glad beslag.
> Bak er in de olie kleine pannenkoekjes van, 2 minuten per kant.
> Serveer met de blauwe bessen.

Skyr met muesli en noten | 5 | skyr muesli
- 250 g skyr naturel | 250 | skyr
- 40 g muesli zonder toegevoegde suiker | 40 | muesli
- 15 g amandelen | 15 | amandelen
- 100 g aardbeien | 100 | aardbeien
> Schep de skyr in een kom en verdeel de muesli, amandelen en aardbeien erover.

Volkorenbrood met kipfilet en ei | 10 | brood kipfilet ei
- 2 sneetjes volkorenbrood (70 g) | 70 | volkorenbrood
- 50 g kipfilet (vleeswaren) | 50 | Kipfilet (vleeswaar)
- 2 eieren | 100 | ei
- 1 tomaat (100 g) | 100 | tomaat
> Kook de eieren in 8 minuten hard.
> Beleg het brood met kipfilet, tomaat en plakjes ei.

# Lunch
Kip-rijstbowl met zwarte bonen | 25 | rijstbowl kip bonen
- 125 g kipfilet | 125 | kipfilet rauw
- 60 g zilvervliesrijst | 60 | zilvervliesrijst
- 80 g zwarte bonen (blik, uitgelekt) | 80 | zwarte bonen gekookt
- 50 g mais | 50 | mais
- 100 g paprika | 100 | Paprika rode rauw
- 1/2 avocado (70 g) | 70 | avocado
- limoen en paprikapoeder naar smaak | 0 |
> Kook de rijst. Bak de kip met paprikapoeder gaar en snijd in reepjes.
> Verdeel rijst, bonen, mais, paprika, avocado en kip over een kom en maak af met limoensap.

Pastasalade met tonijn | 20 | pastasalade tonijn
- 70 g volkorenpasta | 70 | volkorenpasta
- 1 blikje tonijn in water (120 g) | 120 | tonijn in water
- 100 g cherrytomaten | 100 | tomaat
- 50 g rucola | 50 | rucola
- 50 g doperwten | 50 | doperwten
- 10 ml olijfolie | 10 | olijfolie
> Kook de pasta en laat afkoelen. Kook de doperwten kort mee.
> Meng met tonijn, tomaat en rucola en besprenkel met olie.

Wrap met kalkoen, ei en hummus | 10 | wrap kalkoen ei
- 2 volkoren wraps (120 g) | 120 | wrap volkoren
- 100 g kalkoenfilet (vleeswaren) | 100 | Kalkoenfilet (vleeswaar)
- 1 ei | 50 | ei
- 40 g hummus | 40 | hummus
- 75 g sla | 75 | sla
> Kook het ei hard en snijd in plakjes.
> Besmeer de wraps met hummus, beleg met sla, kalkoen en ei en rol op.

Quinoasalade met zalm | 20 | quinoa zalm
- 50 g quinoa | 50 | quinoa
- 100 g gerookte zalm | 100 | zalm gerookt
- 100 g komkommer | 100 | komkommer
- 75 g edamame | 75 | sojabonen
- 10 ml olijfolie | 10 | olijfolie
- dille en citroen naar smaak | 0 |
> Kook de quinoa 12 minuten en laat afkoelen. Kook de edamame 4 minuten.
> Meng met komkommer, dille en olie en leg de zalm erop. Maak af met citroen.

Linzensalade met ei en feta | 15 | linzen ei feta
- 150 g linzen (blik, uitgelekt) | 150 | linzen gekookt
- 2 eieren | 100 | ei
- 30 g feta | 30 | feta
- 100 g paprika | 100 | Paprika rode rauw
- 50 g rode ui | 50 | ui
- 10 ml olijfolie | 10 | olijfolie
> Kook de eieren hard en snijd in partjes.
> Meng linzen, paprika en ui met de olie, verkruimel de feta erover en leg de eieren erop.

# Diner
Biefstuk met zoete aardappel en broccoli | 30 | biefstuk zoete aardappel
- 150 g biefstuk | 150 | biefstuk rauw
- 200 g zoete aardappel | 200 | zoete aardappel
- 200 g broccoli | 200 | broccoli
- 10 ml olijfolie | 10 | olijfolie
- peper en zout naar smaak | 0 |
> Snijd de zoete aardappel in partjes en rooster 25 minuten op 200 °C met de helft van de olie.
> Kook de broccoli 5 minuten. Bak de biefstuk in de rest van de olie 2 tot 3 minuten per kant.

Kip met volkorenpasta en pesto | 20 | kip pasta pesto
- 150 g kipfilet | 150 | kipfilet rauw
- 80 g volkorenpasta | 80 | volkorenpasta
- 20 g groene pesto | 20 | pesto
- 100 g cherrytomaten | 100 | tomaat
- 75 g spinazie | 75 | spinazie
> Kook de pasta volgens de verpakking.
> Bak de kip in blokjes gaar, voeg tomaat en spinazie toe tot die slinkt.
> Schep pasta en pesto erdoor.

Zalm met quinoa en spinazie | 25 | zalm quinoa
- 150 g zalmfilet | 150 | zalm rauw
- 60 g quinoa | 60 | quinoa
- 150 g spinazie | 150 | spinazie
- 100 g sperziebonen | 100 | sperziebonen
- 5 ml olijfolie | 5 | olijfolie
> Kook de quinoa 12 minuten en de sperziebonen 8 minuten.
> Bak de zalm 3 tot 4 minuten per kant. Laat de spinazie in dezelfde pan slinken en serveer alles samen.

Chili con carne met mager rundergehakt | 30 | chili con carne
- 125 g rundergehakt mager | 125 | rundergehakt mager
- 100 g kidneybonen (blik, uitgelekt) | 100 | kidneybonen gekookt
- 1 ui (100 g) | 100 | ui
- 1 paprika (150 g) | 150 | Paprika rode rauw
- 200 g tomatenblokjes (blik) | 200 | tomaten uit blik
- 60 g zilvervliesrijst | 60 | zilvervliesrijst
- 1 tl chilipoeder en komijn | 0 |
> Kook de rijst. Rul het gehakt bruin met ui, paprika en kruiden.
> Voeg tomaat en bonen toe en laat 15 minuten zacht koken. Serveer met de rijst.

Kalkoen met couscous en geroosterde groenten | 30 | kalkoen couscous
- 150 g kalkoenfilet | 150 | kalkoenfilet rauw
- 70 g volkoren couscous | 70 | couscous
- 150 g courgette | 150 | courgette
- 100 g paprika | 100 | Paprika rode rauw
- 10 ml olijfolie | 10 | olijfolie
- 1 tl ras el hanout of paprikapoeder | 0 |
> Rooster courgette en paprika 20 minuten op 200 °C met de helft van de olie.
> Bak de kalkoen met de kruiden in de rest van de olie gaar. Wel de couscous in kokend water.
> Schep alles samen.

# Snack
Kwark met nootjes | 2 | kwark noten
- 200 g magere kwark | 200 | kwark mager
- 15 g ongezouten noten | 15 | noten gemengd ongezouten
> Schep de kwark in een schaaltje en strooi de noten erover.

Kwarkshake met banaan | 3 | kwarkshake banaan
- 150 g magere kwark | 150 | kwark mager
- 200 ml halfvolle melk | 200 | melk halfvol
- 1 banaan (120 g) | 120 | banaan
> Mix alles in de blender tot een gladde shake.

Twee gekookte eieren | 10 | gekookte eieren
- 2 eieren | 100 | ei
- peper en zout naar smaak | 0 |
> Kook de eieren in 8 minuten hard, laat schrikken en pel ze.

Hüttenkäse met ananas | 2 | huttenkase ananas
- 150 g hüttenkäse | 150 | cottage cheese
- 100 g ananas | 100 | ananas
> Schep de hüttenkäse in een schaaltje met de stukjes ananas.

Edamame met sesam | 6 | edamame sesam
- 150 g edamame (diepvries, gepeld) | 150 | sojabonen
- 5 g sesamzaad | 5 | sesamzaad
> Kook de edamame 4 minuten, giet af en bestrooi met sesamzaad.

@sport
# Ontbijt
Havermout met banaan en honing | 10 | havermout banaan
- 70 g havermout | 70 | havermout
- 300 ml halfvolle melk | 300 | melk halfvol
- 1 banaan (120 g) | 120 | banaan
- 10 g honing | 10 | honing
> Breng de melk met de havermout aan de kook en laat 3 minuten zachtjes koken, al roerend.
> Leg de banaan in plakjes erop en besprenkel met honing.

Volkorenbrood met pindakaas en banaan | 5 | brood pindakaas banaan
- 3 sneetjes volkorenbrood (105 g) | 105 | volkorenbrood
- 20 g pindakaas | 20 | pindakaas
- 1 banaan (120 g) | 120 | banaan
- 250 ml halfvolle melk | 250 | melk halfvol
> Rooster het brood eventueel.
> Besmeer met pindakaas en beleg met plakjes banaan. Drink de melk erbij.

Overnight oats met yoghurt en fruit | 5 | overnight oats
- 60 g havermout | 60 | havermout
- 150 g yoghurt halfvol | 150 | yoghurt halfvol
- 100 ml halfvolle melk | 100 | melk halfvol
- 100 g aardbeien | 100 | aardbeien
- 10 g chiazaad | 10 | chiazaad
> Meng havermout, yoghurt, melk en chiazaad in een pot en zet een nacht in de koelkast.
> Schep 's ochtends de aardbeien erop.

Volkoren pannenkoeken met fruit | 20 | pannenkoeken fruit
- 75 g volkorenmeel | 75 | volkorenmeel
- 1 ei | 50 | ei
- 150 ml halfvolle melk | 150 | melk halfvol
- 5 ml zonnebloemolie | 5 | zonnebloemolie
- 100 g blauwe bessen | 100 | blauwe bessen
- 75 g yoghurt halfvol | 75 | yoghurt halfvol
> Klop meel, ei en melk tot een glad beslag.
> Bak er in de olie dunne pannenkoeken van.
> Serveer met yoghurt en blauwe bessen.

Muesli met melk en fruit | 3 | muesli melk
- 60 g muesli zonder toegevoegde suiker | 60 | muesli
- 250 ml halfvolle melk | 250 | melk halfvol
- 1 appel (150 g) | 150 | appel
> Schep de muesli in een kom, snijd de appel erboven en giet de melk erover.

# Lunch
Pastasalade met kip en pesto | 20 | pastasalade kip
- 90 g volkorenpasta | 90 | volkorenpasta
- 100 g kipfilet | 100 | kipfilet rauw
- 15 g groene pesto | 15 | pesto
- 100 g cherrytomaten | 100 | tomaat
- 50 g rucola | 50 | rucola
> Kook de pasta en laat afkoelen. Bak de kip in reepjes gaar.
> Meng pasta, kip, tomaat, rucola en pesto.

Zoete-aardappelbowl met kip | 30 | bowl zoete aardappel
- 250 g zoete aardappel | 250 | zoete aardappel
- 100 g kipfilet | 100 | kipfilet rauw
- 80 g kikkererwten (blik, uitgelekt) | 80 | kikkererwten gekookt
- 75 g spinazie | 75 | spinazie
- 10 ml olijfolie | 10 | olijfolie
- 1 tl paprikapoeder | 0 |
> Rooster blokjes zoete aardappel en kikkererwten 25 minuten op 200 °C met olie en paprikapoeder.
> Bak de kip gaar en verdeel alles over een kom met spinazie.

Volkoren broodjes met kalkoen en ei | 10 | broodjes kalkoen
- 2 bruine bollen (120 g) | 120 | Tarwebroodje bruin zacht
- 50 g kalkoenfilet (vleeswaren) | 50 | Kalkoenfilet (vleeswaar)
- 1 ei | 50 | ei
- 50 g sla | 50 | sla
- 1 tomaat (100 g) | 100 | tomaat
- 1 banaan (120 g) | 120 | banaan
> Kook het ei hard. Beleg de bollen met sla, tomaat, kalkoen en plakjes ei.
> Eet de banaan erbij.

Burrito bowl met rijst en bonen | 25 | burrito bowl
- 80 g zilvervliesrijst | 80 | zilvervliesrijst
- 100 g zwarte bonen (blik, uitgelekt) | 100 | zwarte bonen gekookt
- 75 g mais | 75 | mais
- 100 g paprika | 100 | Paprika rode rauw
- 50 g salsa of tomaat | 50 | tomaat
- 30 g geraspte 30+ kaas | 30 | kaas 30+
- limoen en komijn naar smaak | 0 |
> Kook de rijst. Verwarm bonen en mais met de komijn.
> Verdeel alles over een kom en maak af met kaas en limoensap.

Soep met kip en vermicelli | 20 | kippensoep vermicelli
- 70 g volkoren vermicelli | 70 | Pasta volkoren rauw
- 100 g kipfilet | 100 | kipfilet rauw
- 150 g paksoi | 150 | paksoi
- 100 g champignons | 100 | champignons
- 500 ml water met 1/2 kippenbouillontablet | 0 |
- 1 el sojasaus | 15 | sojasaus
- gember en lente-ui naar smaak | 0 |
> Breng de bouillon met gember aan de kook. Voeg de kip in reepjes toe en laat 6 minuten koken.
> Voeg vermicelli, paksoi en champignons toe en kook nog 4 minuten. Breng op smaak met sojasaus.

# Diner
Volkoren spaghetti bolognese | 30 | spaghetti bolognese
- 100 g volkorenspaghetti | 100 | volkorenpasta
- 100 g rundergehakt mager | 100 | rundergehakt mager
- 1 ui (100 g) | 100 | ui
- 1 wortel (100 g) | 100 | Wortel rauw gem
- 250 g tomatenblokjes (blik) | 250 | tomaten uit blik
- 10 g Parmezaanse kaas | 10 | parmezaanse kaas
- Italiaanse kruiden naar smaak | 0 |
> Kook de spaghetti volgens de verpakking.
> Rul het gehakt met ui en geraspte wortel, voeg tomaat en kruiden toe en laat 15 minuten zacht koken.
> Serveer met de Parmezaanse kaas.

Kip teriyaki met rijst en groente | 25 | kip teriyaki
- 125 g kipfilet | 125 | kipfilet rauw
- 90 g zilvervliesrijst | 90 | zilvervliesrijst
- 200 g broccoli | 200 | broccoli
- 100 g wortel | 100 | Wortel rauw gem
- 2 el sojasaus | 30 | sojasaus
- 10 g honing | 10 | honing
- 10 ml zonnebloemolie | 10 | zonnebloemolie
> Kook de rijst. Meng sojasaus en honing.
> Roerbak de kip in de olie bruin, voeg groente toe en wok 4 minuten. Giet de saus erover en laat even inkoken.

Zalm met aardappelpartjes en salade | 35 | zalm aardappelpartjes
- 125 g zalmfilet | 125 | zalm rauw
- 300 g aardappelen | 300 | aardappelen
- 100 g sla | 100 | sla
- 100 g tomaat | 100 | tomaat
- 10 ml olijfolie | 10 | olijfolie
> Snijd de aardappelen in partjes en rooster 30 minuten op 200 °C met de helft van de olie.
> Bak of rooster de zalm 12 minuten mee. Serveer met sla en tomaat met de rest van de olie.

Gnocchi met kip en spinazie | 20 | gnocchi kip
- 200 g gnocchi | 200 | gnocchi
- 100 g kipfilet | 100 | kipfilet rauw
- 150 g spinazie | 150 | spinazie
- 100 g cherrytomaten | 100 | tomaat
- 50 ml kookroom light | 50 | kookroom
- 10 g Parmezaanse kaas | 10 | parmezaanse kaas
> Bak de gnocchi 5 minuten goudbruin. Bak de kip in blokjes gaar.
> Voeg tomaat, spinazie en room toe en laat 2 minuten pruttelen. Bestrooi met Parmezaanse kaas.

Couscous met kikkererwten en kipgehakt | 25 | couscous kipgehakt
- 80 g volkoren couscous | 80 | couscous
- 100 g kipgehakt | 100 | kipgehakt
- 100 g kikkererwten (blik, uitgelekt) | 100 | kikkererwten gekookt
- 150 g courgette | 150 | courgette
- 1 ui (100 g) | 100 | ui
- 10 ml olijfolie | 10 | olijfolie
- 1 tl ras el hanout | 0 |
> Wel de couscous in kokend water.
> Bak gehakt, ui en courgette in de olie met de kruiden, voeg de kikkererwten toe en verwarm door.
> Schep de couscous erdoor.

# Snack
Banaan en rijstwafels met pindakaas | 3 | rijstwafels pindakaas
- 1 banaan (120 g) | 120 | banaan
- 2 rijstwafels (16 g) | 16 | Wafel rijst- naturel m (zee)zout
- 15 g pindakaas | 15 | pindakaas
> Besmeer de rijstwafels met pindakaas en eet de banaan erbij.

Krentenbol met kaas | 2 | krentenbol kaas
- 1 krentenbol (60 g) | 60 | krentenbol
- 20 g 30+ kaas | 20 | kaas 30+
> Snijd de krentenbol open en beleg met kaas.

Yoghurt met krokante muesli | 2 | yoghurt granola
- 200 g yoghurt halfvol | 200 | yoghurt halfvol
- 30 g krokante muesli (granola) | 30 | Muesli krokante m noten
> Schep de yoghurt in een schaaltje en strooi de krokante muesli erover.

Dadels met amandelen | 1 | dadels amandelen
- 40 g dadels | 40 | dadels gedroogd
- 15 g amandelen | 15 | amandelen
> Eet de dadels met de amandelen, bijvoorbeeld een uur voor je training.

Chocolademelk na het sporten | 1 | chocolademelk
- 300 ml magere chocolademelk | 300 | chocolademelk mager
> Schenk een groot glas koude chocolademelk in. Handig binnen een uur na je training.
"""

def parse(src):
    out, prof, meal, cur = {}, None, None, None
    for raw in src.splitlines():
        line = raw.strip()
        if not line: continue
        if line.startswith("@"):
            prof = line[1:]; out[prof] = {}; continue
        if line.startswith("# "):
            meal = line[2:]; out[prof][meal] = []; continue
        if line.startswith("- "):
            t, g, h = [x.strip() for x in line[2:].split("|")]
            cur["ing"].append([t, float(g), h]); continue
        if line.startswith("> "):
            cur["steps"].append(line[2:]); continue
        name, tijd, zoek = [x.strip() for x in line.split("|")]
        cur = {"name": name, "tijd": int(tijd), "zoek": zoek, "ing": [], "steps": []}
        out[prof][meal].append(cur)
    return out

data = parse(SRC)
for p, meals in data.items():
    for m, ds in meals.items():
        assert len(ds) == 5, (p, m, len(ds))
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "starter_dishes.json"), "w", encoding="utf-8") as f:
    json.dump({"v": 1, "profiles": data}, f, ensure_ascii=False, separators=(",", ":"))
print("ok", sum(len(ds) for meals in data.values() for ds in meals.values()), "gerechten")
