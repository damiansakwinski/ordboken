# Ordboken

Ordkort for norsk gloseøving. Hele appen er `index.html` — én fil, ingen bygg,
åpne den i en nettleser.

## Podkast

`tools/build-podcast.mjs` lager en lyttepodkast av de samme ordene: for hvert ord
leses alle formene opp, så en liten historie der ordet går igjen fire–fem ganger i
ulike former, så den engelske oversettelsen.

Det skjer i tre steg:

| Steg | Hva | Ut |
|---|---|---|
| 0 | Claude skriver en historie per ord | `stories.json` (i git) |
| 1 | Azure leser den inn | `.cache/clips/` |
| 2 | ffmpeg syr klippene til episoder | `episodes/` |

Bare `stories.json` ligger i git. Lyd regenereres når som helst, og
historiene er det eneste som er verdt å ta vare på og rette i for hånd.

### Oppsett

```sh
npm install
```

Fyll så inn `.env` (den ligger klar med kommentarer). Claude kjøres på **Amazon
Bedrock**, samme oppsett som `animalhotels-browser`: standard AWS-legitimasjonskjede
og en EU-inferensprofil i `eu-central-1`. La AWS-nøklene stå tomme hvis du bruker
en profil i `~/.aws` eller en instansrolle.

`ffmpeg` og `ffprobe` må finnes på PATH (`brew install ffmpeg`).

> Merk: `~/.aws/config` har `region = waw`, som ikke er en ekte AWS-region. Derfor
> setter `.env` `AWS_REGION=eu-central-1` eksplisitt — uten det feiler alt mot
> AWS med en forvirrende endepunktfeil.

#### Modellen

Standard er `eu.anthropic.claude-opus-4-6-v1`. Ifølge notatene i
`animalhotels-browser` er det den sterkeste profilen som faktisk er skrudd på på
kontoen — Opus 4.7/4.8/5 og Sonnet 5 svarer **403** til de er aktivert for hele
kontoen fra Bedrock-konsollen. Får du 403, er det som regel det som mangler, ikke
legitimasjonen. Bytt profil med `BEDROCK_MODEL_ID` i `.env`.

### Bruk

```sh
node tools/build-podcast.mjs --dry --limit=5      # se promptene, ingen API-kall
node tools/build-podcast.mjs --stories-only --limit=20
node tools/build-podcast.mjs --print              # les historiene du har
node tools/build-podcast.mjs                      # hele løpet
```

Kjør `--help` for alle flagg. De nyttigste: `--only=<søk>` for ett ord om gangen,
`--deck=<søk>` for én kortstokk, `--pause=<ms>` for tenkepausen før engelsk,
`--fake-audio` for å teste sammensyingen uten å bruke Azure-kvote, og
`--list-voices` for å se hvilke stemmer regionen din faktisk har.

### Taletempo

`--rate=<pct>` setter tempoet for alt. `--story-rate=<pct>` overstyrer det for
selve historien og faller tilbake til `--rate` hvis den ikke settes. Delingen er
der fordi de løsrevne formene («skifte ut, skifter ut, skiftet ut …») tåler et
høyere tempo enn sammenhengende prosa, som er den delen du faktisk skal forstå:

```sh
node tools/build-podcast.mjs --deck=distrikts --rate=-8% --story-rate=-13%
```

Merk at tempoet inngår i hashen til lydklippene, men ikke i hashen til
historiene. Endrer du tempo, leses alt inn på nytt — historiene skrives ikke om.

### Ett spor per ord

`--per-word` legger klippene i `ord/<kortstokk>/NNN ord.mp3` i stedet for å sy
dem til episoder. Nummeret foran holder rekkefølgen i avspillere.

```sh
node tools/build-podcast.mjs --deck=distrikts --rate=-8% --story-rate=-13% --per-word
```

### Inn i appen

```sh
node tools/build-podcast.mjs --sync-app
```

Skriver historiene fra `stories.json` og stiene til klippene i `ord/` inn i den
merkede blokka i `index.html`. Kortene får da en **Historie**-knapp som legger
teksten over baksiden, og en **Spill**-knapp for de ordene som har lyd. Blokka er
generert — rett i `stories.json` og kjør kommandoen på nytt i stedet for å
redigere `index.html` for hånd.

`ord/` ligger i git, så lyden følger med på GitHub Pages. Det er rundt 25 MB, og
git kaster aldri gamle versjoner: leser du alt inn på nytt med et annet tempo,
legger du på 25 MB til som blir liggende i historikken for alltid.

### Når du legger til nye ord

Legg dem i `words`-arrayet i `index.html` som før, og kjør bygget igjen. Ordene
hashes på innhold, så bare de nye skrives og leses inn — resten står urørt.

### Å rette en historie

Rett teksten i `stories.json` og sett `"locked": true` på den. Låste historier
røres aldri igjen, heller ikke om prompten endres. Historier som ikke kom gjennom
den automatiske sjekken står med `needsReview` og hoppes over i lydsteget til de
er fikset.

> Historiene er maskinskrevet norsk, og du kommer til å høre hver av dem mange
> ganger. Les gjennom de første tjue før du genererer resten.

### Hva det koster

Lyden ligger innenfor Azures gratisnivå på 500 000 tegn i måneden for ett fullt
løp. Men et *helt* nytt lydløp samme måned sprenger gratisnivået — juster pauser
og taletempo med `--only` på noen få ord før du kjører alt.

Historiene er 429 kall på rundt tusen tokens inn og tre hundre ut. På Bedrock
faktureres det per token på den profilen du peker på. Merk at prompt-caching
ikke slår inn her: Opus 4.6 krever 4096 tokens før noe caches, og systemprompten
er under en fjerdedel av det, så hvert kall betaler for hele prompten. Kjør
`--limit=20` først og se hva det faktisk ble, før du slipper løs alle 429.
