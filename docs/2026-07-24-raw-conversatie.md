# Raw conversatie — ferry ontwerpsessie

**Datum:** 24 juli 2026
**Deelnemers:** Robbert & Claude
**Context:** doorloop van de SaaS-visie bovenop `ferry-walking-skeleton.md` (rev. 2). Exacte transcriptie; tool-acties van Claude staan tussen `[…]`.

---

**Robbert:**

/Users/robbertvermeulen/Downloads/ferry-walking-skeleton.md

Geef TLDR in max 4 zinnen.

**Claude:**

**TLDR:** Ferry is een CLI plus WordPress-plugin waarmee coding agents kunnen werken aan WordPress-sites zonder SSH-toegang: `ferry pull` kloont de site naar een lokale DDEV-omgeving met exacte productie-pariteit (PHP/MariaDB-versies, wp-config-constanten), en later brengt `ferry push` fixes veilig terug. Kernkeuzes: alles bulk lokaal spiegelen in plaats van elke operatie proxyen (latency), géén command-executie op productie (plugin is een domme, auditeerbare transportlaag), en een luchtdichte kloon (mails/HTTP/cron geblokkeerd, uploads via HTTP-fallback naar productie in plaats van downloaden). Terugschrijven is asymmetrisch: bestands-diffs en getypeerde DB-operaties gaan terug met drift-detectie, maar DB-content nooit. Status: ontwerp is vastgelegd (rev. 2, alle reviewpunten verwerkt); v0 is een read-only walking skeleton (`link` + `pull`, ~60–90s doorlooptijd) die nog gebouwd moet worden.

---

**Robbert:**

Wat is de propositie in max 20 woorden

**Claude:**

Geef coding agents volwaardige lokale toegang tot WordPress-sites zonder SSH: veilig klonen, debuggen op productie-pariteit, en fixes gecontroleerd terugpushen.

---

**Robbert:**

Zeg alleen "begrijp ik" als je het begrijpt, verder niks.

Mijn visie is: Als ik elke wordpress site zou kunnen bewerken met claude code, zou elk probleem minstens 10x zo snel worden opgelost. Direct op productie wijzigen is niet slim. Een staging maken die in sync blijft met productie voor snelle korte aanpassingen is momenteel te complex. Daar zit te veel frictie.

**Claude:**

begrijp ik

---

**Robbert:**

Zeg begrijp ik als je het begrijpt. Verder niks.

Mijn eind visie is:

Gebruiker maakt account aan in op agent-ferry.com.
Gebruiker maakt site aan.
Gebruiker installeert ferry plugin in site.
Gebruiker krijgt koppelcode.
Gebruiker koppelt in dashboard.
Gebruiker test connectie.
Gebruiker synced productie site binnen 2 min initieel op ddev omgeving op server.
- Geen media
- Hook voor het at runtime vervangen van domein.
- Met zelfde specs als productie in ddev.
- Met benaderbaar ddev domein.
- Met database.
- Met versie beheer systeem (git?)

Gebruiker opent site scherm. Start chat met ferry agent.
Ferry agent onderzoekt (zoals claude code)
Ferry agent komt terug met plan
Ferry agent maakt wijzigen aan code en database.
Ferry agent checkt of kan pushen naar productie zonder problemen.
Ferry agent slaat wijzigingen aan db en code als versie op.


----

2 dagen later:

Ferry agents pulled alleen veranderingen van database en code.
idem
idem

**Claude:**

begrijp ik

---

**Robbert:**

Reageer in max 30 woorden. Wat vind je hiervan?

**Claude:**

Sterk: de SaaS-laag maakt het skeleton-ontwerp toegankelijk voor niet-technische gebruikers. Grootste risico's: agent-op-server verschuift kosten en aansprakelijkheid naar jou, en "pushen zonder problemen" checken blijft het moeilijkste deel.

---

**Robbert:**

Reageer in max 50 woorden?

Wat is de ultieme aanpak voor het clonen van de hele site?

**Claude:**

Manifest met hashes ophalen, core en wp.org-plugins lokaal reconstrueren via officiële checksums (content-addressable cache), alleen de ~3MB unieke bestanden over de lijn. Uploads en backups uitsluiten, DB via keyset-paginatie met bytebudget. Daarna nooit meer vol clonen: Merkle-tree en blok-vingerafdrukken voor delta's. Eerste pull ~60s, refresh in seconden.

---

**Robbert:**

Reageer met ja of nee + toeliching max 20 woorden.

Is dit clonen via plugin haalbaar voor elke wordpress site?

**Claude:**

Nee. Multisite, agressieve security-plugins/WAF's, extreme hostlimieten en afwijkende structuren vallen af. Wel haalbaar voor ruwweg 90% van standaard sites.

---

**Robbert:**

Is 90% genoeg om mee te starten? Reageer ja of nee + 20 woorden toeliching

**Claude:**

Ja. 90% dekt vrijwel alle doelgroep-sites; de rest weiger je expliciet met duidelijke foutmelding, net als multisite. Edge cases los je later op.

---

**Robbert:**

Leg uit hoe het clonen werkt in max 50 woorden alsog ik een niet technisch persoon ben.

**Claude:**

De plugin maakt een lijst van alle bestanden op je site. Standaardbestanden (WordPress zelf, bekende plugins) halen we gratis ergens anders vandaan — alleen jouw unieke bestanden en database komen van je site, in kleine pakketjes. Media blijft staan; die tonen we rechtstreeks vanaf je site. Resultaat: werkende kopie binnen twee minuten.

---

**Robbert:**

Max 50 woorden. Hoe werkt het downloaden van de unieke bestanden?

**Claude:**

De CLI verdeelt de unieke bestanden in pakketjes van ~8MB en vraagt die op via vier tot zes parallelle verzoeken. De plugin pakt ze in en stopt netjes vóór de servertijdslimiet; het volgende verzoek gaat verder waar het bleef. Elke download wordt via een hash gecontroleerd op juistheid.

---

**Robbert:**

Over welk protocol downloaden we? Max 30 woorden

**Claude:**

Gewoon HTTPS, via de WordPress REST API (`/wp-json/ferry/v1/files`). Werkt op elke host zonder shell-toegang; geen FTP of SSH nodig. Ondertekende requests met HMAC-signature voor beveiliging.

---

**Robbert:**

Is er een doorgeteste library op github die we zouden kunnen gebruiken hiervoor aan de download kant. Dus aan de saas server kant.

**Claude:**

Nee — het protocol (batches, hervat-headers, HMAC) is eigen werk, dus geen kant-en-klare library. Wel doorgeteste bouwstenen om het mee te maken (Node/TypeScript-kant):

- **undici** of **got** — HTTP met retries en streams
- **p-queue** / **p-limit** — parallellisme met backoff (4–6 gelijktijdig)
- **tar-stream** of **node-tar** — de tar-batches uitpakken
- **zlib** en **crypto** (ingebouwd) — gunzip en hash-verificatie

De eigen code is dan alleen de dunne orkestratielaag: batches plannen, headers lezen, hervatten. Dat is precies het deel dat je zelf wílt bezitten.

---

**Robbert:**

En aan de plugin kant, welke bouwstenen daar? Max 30 woorden antwoord

**Claude:**

Vrijwel alles native PHP: WP REST API (routes), `deflate_add()` (compressie), `hash()` (verificatie), `$wpdb` (export), `hash_hmac()` (auth). Alleen de tar-writer is eigen code, ~60 regels. Geen externe dependencies.

---

**Robbert:**

Wat voor cijfer zou je dit geven als je deze visie moest beoordelen op of het interessant is voor de wordpress wereld of er al genoeg oplossingen zijn. Geef cijfer en toelichting max 30 woorden

**Claude:**

**8.** Klonen bestaat al (WP Migrate, InstaWP, BlogVault), maar agent-native debuggen plus veilig terugpushen met drift-detectie doet niemand. Timing is perfect; uitvoering en distributie bepalen het succes.

---

**Robbert:**

Wees eerlijk. Is dit iets wat de wordpress wereld nodig heeft. Ja of nee. Max 30 woorden toeliching

**Claude:**

**Ja.** Miljoenen sites op shared hosting zonder fatsoenlijke debug-route; agencies verzuipen in onderhoud. Maar: de eindgebruiker weet dit niet — je verkoopt aan developers en agencies, niet aan sitebezitters.

---

**Robbert:**

Op een schaal van 0-100. Hoe zeker ben je over onze pull mechaniek voor 90% van de sites. max 30 woorden toelichting

**Claude:**

**70.** Ontwerp is doordacht, maar ongetest op echte hosts. Grootste onzekerheden: WAF's/security-plugins die requests blokkeren en db-export-encoding. Pas na tien echte klantsites weet je het echt.

---

**Robbert:**

Hoe krijgen we dit naar 90, zonder te kunnen testen? Is er een andere weg waar het via kan? Max 50 woorden toelichting.

**Claude:**

Leen bewezen kennis: Duplicator, UpdraftPlus en All-in-One WP Migration zijn open source en hebben deze exacte problemen (timeouts, encoding, WAF's) al jaren opgelost. Bestudeer hun code én hun supportforums — dat is een gratis catalogus van edge cases per host. Plus: hun changelogs tonen welke bugs écht voorkomen.

---

**Robbert:**

Laten we eerst uitgaan van 70 om vaart te houden. Later dit onderzoeken.

Nu het versie beheer. Leg uit in max 50 woorden hoe je dit aan gaat pakken.

**Claude:**

Elke kloon wordt een git-repo op de server. Elke pull is een commit op branch `production`; de agent werkt op een eigen branch. Diff tussen die twee toont exact wat naar productie moet. Rollback, historie en conflictdetectie krijg je gratis, en agents zijn al thuis in git.

*[maakt taak aan: "Pull-mechaniek valideren via bestaande migratieplugins"]*

---

**Robbert:**

Tot welk niveau zit dit in de repo? Vanaf gehele wp folder?

**Claude:**

Vanaf de gehele WP-root (docroot), dus inclusief core. Reden: de diff moet exact tonen wat terug moet naar productie, óók een gehackt of gepatcht core-bestand. Lokaal gegenereerde zaken (`wp-config.php`, `.ddev/`, uploads-map, drop-in-renames als je die wilt uitsluiten) gaan in `.gitignore` — die verschillen mogen nooit als pushbare wijziging verschijnen.

---

**Robbert:**

Wat als onderliggende folders .git hebben? Max 20 woorden toelichitng

**Claude:**

Hernoemen naar `.git.ferry-disabled` bij de pull — anders behandelt git ze als submodule en verdwijnen die bestanden uit je diff.

---

**Robbert:**

van 0-100. Hoe overtuigd ben je van git voor de gehele wp root?

**Claude:**

**90.** Bewezen techniek, agents kennen het, diffs/rollback gratis. Resterende 10: binaire bestanden diffen slecht, en de database valt erbuiten — die heeft eigen versionering nodig (getypeerde operaties loggen).

---

**Robbert:**

Oke. 90 kan ik mee leven als v0.

Hoe zie je het bijhouden van database wijzigingen voor je? Max 50 woorden

**Claude:**

Niet diffen maar loggen: een mu-plugin in de kloon hookt op `updated_option`, `save_post`, postmeta-wijzigingen en schrijft elke wijziging als getypeerde operatie (oud + nieuw) naar een journal-bestand. Dat journal committet mee in git naast de code. Push = journal afspelen op productie; rollback = omgekeerd afspelen.

---

**Robbert:**

Hoe zie je dit voor je met custom db tabellen? Max 50 woorden toelichten.

**Claude:**

Daar falen WP-hooks — plugins schrijven direct via `$wpdb`. Oplossing in de kloon: het `query`-filter van `$wpdb` logt alle INSERT/UPDATE/DELETE op niet-core-tabellen in het journal. Schemawijzigingen (`CREATE`/`ALTER`) idem, als `schema_migrate`-operatie. Riskanter dan opties/postmeta — dus bij push expliciet tonen en laten bevestigen.

---

**Robbert:**

Is dit de allerbeste manier om dit te doen? Of bestaat er in de hele development wereld nog een betere manier? Max 50 woorden toelichting.

**Claude:**

Ja, er is een betere: de MySQL row-based binlog. Jij beheert de database in DDEV — zet binlog aan en je krijgt élke wijziging met voor/na-waardes, ongeacht hoe die geschreven werd (ook buiten `$wpdb` om). Betrouwbaarder dan PHP-hooks; CDC-tools als Debezium bewijzen dit patroon al jaren. Journal genereer je daaruit.

---

**Robbert:**

Kijk dat moet ik horen. Dit houden we vast.

Zijn er op voorgaande punten ook nog een betere oplossing uit de hele development wereld te vinden? max 50 woorden toelichting.

**Claude:**

Grotendeels zit je al op best practice (Merkle = git/ZFS, read-set = optimistic locking uit databases, uploads-fallback = pull-through cache uit Docker-registries). Eén echte upgrade: content-defined chunking (FastCDC, zoals restic/borg) in plaats van hele-bestand-hashes — dedupliceert over alle klantsites heen en maakt refreshes van grote bestanden goedkoper. Genoteerd voor later.

---

**Robbert:**

Schrijf nu op welke beslissingen we tot nu toe genomen hebben. Max 50 woorden. Puntsgewijs.

**Claude:**

- SaaS-visie: klonen draait op onze server in DDEV, agent-chat per site
- 90% sitedekking is genoeg; rest hard weigeren
- Pull-zekerheid 70 accepteren, later valideren via bestaande migratieplugins
- Git over de hele WP-root; geneste `.git` hernoemen
- DB-wijzigingen via MySQL row-based binlog, niet PHP-hooks
- FastCDC-chunking genoteerd voor later

---

**Robbert:**

Schrijf nu de stack op van de punten die we tot nu toe hebben besproken in max 70 woorden. Punstgewijs.

**Claude:**

- **Plugin (site):** native PHP — WP REST API, `deflate_add()`, `hash_hmac()`, `$wpdb`, eigen tar-writer
- **Transport:** HTTPS/REST, HMAC-signed, hervatbare ~8MB-batches
- **SaaS-server:** Node/TypeScript — undici/got, p-queue, tar-stream, zlib, crypto
- **Kloonomgeving:** DDEV per site, productie-pariteit, op onze server
- **Versiebeheer:** git over hele WP-root
- **DB-tracking:** MySQL row-based binlog in DDEV
- **Uploads:** 302-fallback naar productie
- **Later:** FastCDC-cache

---

**Robbert:**

Welke deel van deze volledige mechaniek hebben we nog niet besproken? Max 30 woorden. Puntsgewijs

**Claude:**

- Push-mechaniek: staging, atomaire swap, rollback
- Drift-detectie vóór push
- De agent zelf: Claude Code-integratie, sandboxing, kosten
- Multi-tenant serverinfra en isolatie
- Containment harness / licentie-stubs
- Pairing-flow en dashboard

---

**Robbert:**

Push mechaniek. Hoe zie je dit voor je. Houd weer in gedachte alle development kennis van de wereld. Max 50 woorden toelichting.

**Claude:**

Twee-fase-commit, zoals Capistrano/blue-green deploys: diffs eerst naar stagingmap, hashes verifiëren, drift-check (bestandshashes + read-set), dan atomaire `rename()`-swap met backup. Daarna DB-journal afspelen als getypeerde operaties. Afsluiten met smoke test — faalt die, automatische rollback. Dit ís de wereldstandaard, vertaald naar shared hosting zonder shell.

---

**Robbert:**

Akkoord. Nu drift detectie. Weer met alle development kennis van de wereld. Max 50 woorden.

**Claude:**

Git-drie-wegen-model: snapshot-commit is de merge-base, productie-nu is "theirs", jouw branch "ours". Bestanden: hash-vergelijk alleen wat je overschrijft (compare-and-swap, zoals HTTP If-Match). Database: read-set-controle — check alleen keys die de fix daadwerkelijk las (optimistic concurrency, zoals Postgres' serializable snapshot isolation). Alle overige drift bewust negeren.

---

**Robbert:**

Hoe betrouwbaar schat je dit systeem in 0-100? Max 30 woorden toelichting

**Claude:**

**75.** Bestandskant is degelijk (90+). DB-kant zwakker: read-set mist directe `$wpdb`-reads, en tussen check en commit zit een race-window (TOCTOU). Acceptabel voor code-fixes, niet voor data-operaties.

---

**Robbert:**

Hoe zou je dat voor data naar 95 kunnen krijgen? Je hebt alle development kennis van de hele wereld.

**Claude:**

Verplaats de check ín de write-transactie op productie. De commit-call doet één DB-transactie: `SELECT ... FOR UPDATE` op alle read-set-rijen, verwachte oude waardes verifiëren (compare-and-swap), getypeerde operaties toepassen, commit. Mismatch → rollback, niets toegepast. Het race-window verdwijnt volledig — dit is hoe etcd en DynamoDB conditional writes werken.

Plus: laat de agent zijn aannames expliciet declareren ("deze fix veronderstelt optie X = Y") in plaats van alleen impliciete read-set-logging. Expliciete precondities vangen wat logging mist.

---

**Robbert:**

Leg uit zodat ik het beter begrijp. Max 80 woorden.

**Claude:**

Nu doe je twee losse stappen: eerst kijken ("is er niets veranderd?"), dan schrijven. Tussen die twee stappen kan productie nét iets wijzigen — dat is het gat.

De oplossing: kijken en schrijven in één ondeelbare stap. De plugin zet de betreffende rijen heel even op slot, controleert of ze nog de waarde hebben die jouw fix verwachtte, en past pas dán de wijziging toe. Klopt iets niet, dan gebeurt er helemaal niets en krijg je een melding. Alles of niets — geen gat meer.

---

**Robbert:**

Klinkt als een perfecte oplossing. Door naar de agent zelf.

Als je elk soort agent SDK techiek mocht gebruiken. Welk kies je als beste optie voor hier. Max 50 woorden toelichting.

**Claude:**

Claude Agent SDK. Je kloon is een bestandssysteem met git, wp-cli en een shell — exact de omgeving waarvoor Claude Code getraind en geoptimaliseerd is (grep, read, edit, bash). Je krijgt de agent-loop, sessies, subagents en permissiemodel gratis; jouw ferry-commando's koppel je aan als MCP-tools of custom tools.

---

**Robbert:**

Akkoord. Nu Multi-tenant serverinfra en isolatie. Jouw visie met alle development kennis van de wereld in je achterhoofd. Max 50 woorden.

**Claude:**

Klantcode is untrusted code — Docker alleen is te zwak. Firecracker microVM's per site (zoals Fly.io en E2B doen): harde isolatie, starten in ~1s, pauzeren als niemand werkt — je betaalt alleen actieve sessies. Egress standaard dicht op netwerkniveau, dat versterkt meteen je containment harness. DDEV draait ongewijzigd bínnen de VM.

---

**Robbert:**

Ok klinkt goed. Daarmee beslissen we gelijk om fly.io te gebruiken? Kan dat ook voor lokaal development eerst? Ja of nee. Max 30 woorden.

**Claude:**

Nee. Firecracker is de techniek, Fly.io één van de aanbieders — die keuze kan later. Lokaal ontwikkel je gewoon met DDEV zonder VM-isolatie; isolatie is pas nodig bij echte klanten.

---

**Robbert:**

Ok noteer. Dan nog Containment harness / licentie-stubs. Jouw visie met alle development kennis van de wereld. Max 50 woorden.

**Claude:**

*[schrijft alle beslissingen naar het projectgeheugen]*

Genoteerd in het projectgeheugen (alle beslissingen tot nu toe staan er in).

**Harness/stubs:** verdediging in lagen. PHP-filters voor gedrag, netwerk-egress (VM) als garantie. De stubs: een transparante proxy op VM-niveau — WireMock/VCR-patroon — waar álle uitgaand verkeer doorheen moet. Bekende licentie-endpoints (EDD, Freemius, WooCommerce.com) krijgen declaratieve stub-fixtures; de rest wordt geblokkeerd én gelogd. Die log toont precies welke stub je hierna moet schrijven.

---

**Robbert:**

Leg uit zodat ik het beter begrijp. Max 80 woorden.

**Claude:**

De kloon mag niet écht naar buiten bellen — anders verstuurt hij echte mails of betaalverzoeken. Dus: alles dicht, op twee niveaus. In WordPress zelf (filters) én op netwerkniveau (de VM laat niets uit).

Maar sommige plugins bellen hun licentieserver en schakelen zichzelf uit als dat mislukt. Daarvoor zet je een nep-antwoordapparaat tussen: elke uitgaande oproep komt daar aan. Herkent hij een licentiecheck, dan antwoordt hij "licentie geldig" — de plugin werkt normaal. Al het andere blokkeert hij en schrijft hij op, zodat jij weet welk nep-antwoord je nog moet toevoegen.

---

**Robbert:**

Slim. Mee eens.

Hoe ga je om met database wijzigingen aan productie kant tussen meerdere pull sessies door? Max 50 woorden.

**Claude:**

Productie is eigenaar van die data — jouw kloon is een foto, drift is geen probleem. Bij een nieuwe sessie: refresh via blok-vingerafdrukken (per 10k rijen een goedkope checksum opvragen, alleen afwijkende blokken opnieuw ophalen — seconden). Tussendoor actuele data nodig? Eén gerichte rij via het control plane injecteren.

---

**Robbert:**

Is dit met alle kennis van de development wereld bij elkaar de nummer 1 oplossing voor dit? Of is er nog een betere?

**Claude:**

Nee, de absolute nummer 1 is binlog-CDC (zoals Debezium) — exact, realtime, incrementeel. Maar die vereist replicatierechten op de productiedatabase, en die heb je op shared hosting niet. Binnen jouw beperking (PHP-plugin, geen shell) zijn blok-vingerafdrukken wél de top — pt-table-checksum van Percona, dé industriestandaard voor MySQL-vergelijking, gebruikt exact deze techniek. Plus WP-hook-journal als goedkope eerste signalering.

Dus: theoretisch tweede, praktisch eerste.

---

**Robbert:**

Oke akkoord. Dan als laatste Pairing-flow en dashboard.

Vertel me hoe je dit aanpakt. Alle kennis van development wereld tot je beschikking. Max 50 woorden.

**Claude:**

Pairing via het device-flow-patroon (zoals tv-apps en `gh auth login`): plugin toont korte code, gebruiker plakt die in het dashboard, server en plugin wisselen sleutels uit — code is kort geldig, eenmalig. Later PAKE als upgrade. Dashboard: dunne schil boven de engine; agent-sessies live streamen via SSE, alle state in leesbare bestanden per site.

---

**Robbert:**

Wat is PAKE en waarom later? Max 50 woorden

**Claude:**

PAKE = Password-Authenticated Key Exchange: beide kanten leiden uit een korte code een sterke sleutel af, zonder dat er iets afluisterbaars over de lijn gaat. Zelfs als iemand de code ziet (log, screenshot), heeft hij niets. Later omdat het een externe PHP-library in de plugin vergt — device-flow met korte geldigheid is voor v0 veilig genoeg.

---

**Robbert:**

Waarom niet nu direct?

**Claude:**

Drie redenen. De winst is marginaal: de code is eenmalig, kort geldig en gaat al over HTTPS — PAKE beschermt vooral tegen een gelekte screenshot in dat ene minuutje. De kosten zijn reëel: een externe crypto-library maakt de plugin lastiger te reviewen, en "geen dependencies, triviaal auditeerbaar" is juist je troef om op klantsites te mogen draaien. En het is later goedkoop in te bouwen: pairing is één geïsoleerde naad, geen herschrijving.

Nu bouwen = vertraging kopen voor risico dat er nog niet is.

---

**Robbert:**

Oke akkoord. Hebben we zo alles besproken? Max 50 woorden toelichting

**Claude:**

De mechaniek is rond, ja. Nog niet besproken, maar wel wezenlijk: agent-tokenkosten en pricing (wie betaalt de Claude-rekening?), goedkeurings-UX vóór een push (wat ziet de gebruiker?), audit-log en monitoring, en onboarding/distributie. Dat zijn product- en businessvragen, geen mechaniek — prima voor een volgende sessie.

Beslissingen staan genoteerd in het projectgeheugen.

---

**Robbert:**

Claude rekening betalen wij.

Goedkeuring UX laten we nu bespreken. Omschrijf je visie in max 80 woorden.

**Claude:**

Het GitHub-PR-patroon, vertaald voor niet-technische gebruikers. De agent presenteert één wijzigingskaart: bovenaan in gewone taal wat er verandert en waarom, daaronder uitklapbaar de technische diff en DB-operaties (oud → nieuw). Plus: drift-check-status en wat de smoke test gaat controleren. Eén knop "Push naar productie".

Tijdens de push: live voortgang. Erna: resultaat van de smoke test en een rollback-knop die zichtbaar blijft — ongedaan maken is één klik, geen supportticket. Niets gaat ooit automatisch naar productie zonder die ene menselijke klik.

---

**Robbert:**

Leg uit: De agent presenteert één wijzigingskaart: "bovenaan" <-

**Claude:**

De kaart is één scherm met lagen, van begrijpelijk naar technisch:

```
┌─────────────────────────────────────────────┐
│ ✅ BTW-berekening gerepareerd               │
│                                             │
│ "De verkeerde BTW op bestellingen kwam     │
│  door een verkeerde instelling plus een    │
│  bug in het thema. Ik heb beide hersteld." │
│                                             │
│ ▸ 2 bestanden gewijzigd        (uitklap)   │
│ ▸ 1 instelling: oud → nieuw    (uitklap)   │
│                                             │
│ Drift-check: ✅ productie ongewijzigd       │
│ Na push test ik: checkout, orderoverzicht  │
│                                             │
│         [ Push naar productie ]             │
└─────────────────────────────────────────────┘
```

"Bovenaan" = de samenvatting in gewone taal, geschreven door de agent. Dat is wat een site-eigenaar leest en waarop hij beslist. De uitklapbare delen eronder zijn voor wie het wél wil zien (developer, agency). Zo dient één kaart beide doelgroepen zonder iemand af te schrikken.

---

**Robbert:**

En is dit in een chat interface of buiten de chat interface?

**Claude:**

Allebei, met de chat als plek van handeling. De kaart verschijnt inline in de chat op het moment dat de agent klaar is — daar beslis je, midden in de context van het gesprek. Maar de kaart is een zelfstandig object dat óók buiten de chat leeft: het sitescherm heeft een tabblad "Wijzigingen" met alle kaarten en hun status (concept, gepusht, teruggerold).

Zelfde model als GitHub: de discussie gebeurt in het gesprek, maar de PR heeft zijn eigen pagina. Belangrijk voor later: je kunt een kaart dan ook delen ("keur jij dit even goed?") zonder iemand de hele chat te laten lezen.

---

**Robbert:**

Ok akkoord.

**Claude:**

*[werkt projectgeheugen bij met alle beslissingen sinds de vorige notitie]*

Genoteerd. Alle beslissingen van deze sessie staan nu in het projectgeheugen: van pull-mechaniek en binlog tot harness-proxy, pairing via device-flow en de wijzigingskaart-UX.

Daarmee is de volledige mechaniek plus goedkeurings-UX doorgesproken. Open voor een volgende sessie: pricing richting eindgebruiker, audit-log/monitoring, en onboarding/distributie.

---

**Robbert:**

Maak eerst een doc aan met EXACT onze raw conversatie.
