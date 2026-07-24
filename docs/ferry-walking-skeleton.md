# ferry — walking skeleton

**Status:** ontwerp vastgelegd na review, v0 nog niet gebouwd
**Datum:** 23 juli 2026 (rev. 2 — reviewpunten verwerkt)
**Naam:** `ferry` — werknaam. Staat overal als los commando; één find-replace als je wisselt.

Dit document bevat alle beslissingen die genomen zijn, inclusief de redenering
erachter en de expliciet verworpen alternatieven. Doel: een volgende sessie kan
hier koud mee verder zonder discussies over te doen.

---

## 1. Wat we bouwen

Een CLI plus WordPress-plugin waarmee coding agents kunnen werken aan een
WordPress-site die **geen SSH-toegang** heeft.

**Beginpunt (v0):** `ferry pull` haalt een complete WordPress-site lokaal binnen
in een DDEV-omgeving die dezelfde serverinstellingen draait als productie, en
geeft je een werkende URL.

**Einddoel:** `ferry push` brengt een fix terug naar de live site — zonder iets
kapot te maken en zonder data te overschrijven die in de tussentijd op productie
is veranderd.

**Waarom:** SSH is geen standaard bij WordPress-hosting en wordt zelfs waar het
bestaat weinig gebruikt. Zonder shell kan een agent niet grepen, niet lezen, geen
wp-cli draaien. Mét die toegang zijn problemen dramatisch sneller opgelost.

---

## 2. Kernbeslissingen (vastgelegd, niet heropenen)

### 2.1 Mirror-first, niet proxy-first

Het knelpunt is **latency, niet capability**. Een agent-sessie doet honderden
kleine operaties (grep, read, edit, read). Over een HTTP-bridge is dat 200–400ms
per call; bij 500 calls zijn dat minuten aan pure round-trips. Erger: de agent
gaat zuiniger zoeken omdat elke stap duur voelt, en juist dat brede zoeken maakt
hem effectief.

Dus: niet elke operatie proxyen. Eén keer bulk ophalen, lokaal werken op volle
snelheid (~1ms), diffs terugduwen.

### 2.2 Twee vlakken

| Vlak | Richting | Volume | Gebruik |
|---|---|---|---|
| Control plane | lokaal → productie | laag, latency-tolerant | info, logs, losse rij ophalen, getypeerde writes |
| Data plane | productie → lokaal | bulk | files en database naar de kloon |

### 2.3 Géén command-executie op productie

**Belangrijkste veiligheidsbeslissing.** De plugin voert geen willekeurige
commando's uit. Geen `exec()`, geen wp-cli in-process, geen eval-constructies.

Gevolgen:
- De plugin is geen backdoor maar een domme transportlaag.
- Elke schrijfactie is één van een kleine, gesloten set getypeerde operaties.
- Auditeerbaar en te reviewen — cruciaal om dit op klantsites te mogen zetten.

wp-cli verdwijnt niet, maar verhuist: hij draait **lokaal in DDEV**, native en
volwaardig, tegen de kloon.

### 2.4 Lokale omgeving = DDEV

Overwogen en verworpen:

| Alternatief | Waarom niet |
|---|---|
| FrankenPHP | PHP-versie zit vast in de binary; nog losse MySQL nodig |
| Laravel Herd | zwakker per-site versiebeheer; MySQL achter Pro |
| Lando | biedt niets boven DDEV |
| wp-env | te beperkt, zwakke HTTPS- en DB-import-story |
| Local by Flywheel | GUI-first, onvoldoende scriptbaar |

Doorslaggevend: versie-pariteit met productie (§2.5). DDEV doet dat declaratief.
Bonus: `*.ddev.site` heeft wildcard-DNS naar 127.0.0.1 met geldig certificaat —
"bereikbaar via een link" is daarmee gratis opgelost.

Praktisch op macOS: Mutagen aan laten staan, anders is bestands-IO in Docker traag.

### 2.5 Pariteit met de productieserver

Dit is geen detail maar de kern van bruikbaarheid: draai je lokaal PHP 8.3 tegen
een productie op 7.4, dan zie je fatals die daar niet bestaan en mis je fatals die
er wél zijn. `/info` levert daarom alles wat de omgeving bepaalt, en `ferry`
vertaalt dat naar DDEV-config.

Wat we overnemen:

| Uit `/info` | Naar DDEV | Waarom |
|---|---|---|
| PHP major.minor | `php_version` | syntax, deprecations, fatals |
| MySQL vs **MariaDB** + versie | `database.type` / `version` | collations, JSON-functies, index-gedrag verschillen echt |
| Actieve PHP-extensies | `webimage_extra_packages` | `imagick` vs `gd` verandert media-gedrag |
| Webserver (nginx/apache) | `webserver_type` | rewrites en `.htaccess`-afhandeling |
| `memory_limit`, `max_execution_time`, `post_max_size`, `upload_max_filesize`, `max_input_vars` | `web_environment` / php-ini overlay | reproduceert limieten waar bugs juist ontstaan |
| **Alle user-defined wp-config-constanten** (denylist: salts, `DB_*`) | `wp-config` in de kloon | zie hieronder |

**wp-config-constanten: alles, niet een handjevol.** Plugins gedragen zich op
tientallen constanten: `WP_ENVIRONMENT_TYPE`, `WP_CACHE`, `SCRIPT_DEBUG`,
`WP_MEMORY_LIMIT`, `WP_CONTENT_DIR`, multisite-vlaggen, plugin-specifieke
API-modes. Omdat we `wp-config.php` lokaal opnieuw genereren (§4.4), verliezen we
alles wat we niet expliciet meenemen. Dus: `/info` dumpt álle user-defined
constanten via `get_defined_constants(true)['user']`, gefilterd door een
denylist (salts/keys, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`). De kloon
krijgt de rest ongewijzigd, waarna de overlay (§2.6) gericht overschrijft wat
lokaal anders móet zijn.

MariaDB-versus-MySQL is de meest onderschatte: veel shared hosts draaien MariaDB
terwijl je lokaal standaard MySQL krijgt.

### 2.6 Environment overlay, geen search-replace

De klassieke migratie-aanpak (domein overal in de DB vervangen) is destructief,
breekt op geserialiseerde data, en maakt latere hash-vergelijking waardeloos.

In plaats daarvan blijft de DB **byte-identiek** en gebeuren overrides at runtime
via een mu-plugin in de kloon:

```php
add_filter('pre_option_siteurl', fn() => 'https://klant.ddev.site');
add_filter('pre_option_home',    fn() => 'https://klant.ddev.site');
```

`pre_option_{$option}` werkt voor élke option. Gevolg: elk optieverschil dat je
daarna ziet is *jouw* wijziging, geen migratieruis.

**Drop-ins neutraliseren — v0-werk, geen optimalisatie.** `object-cache.php` van
een Redis- of Memcached-plugin komt mee in de pull en fatalt onmiddellijk lokaal:
er draait geen Redis in de DDEV-container. `advanced-cache.php` van
caching-plugins wijst naar paden die lokaal niet bestaan. Dit is dé klassieke
reden waarom naïeve klonen wit blijven — zonder deze stap haal je de definition
of done (§4.7) op een flink deel van de sites simpelweg niet.

De overlay-stap inspecteert `wp-content/` op de bekende drop-ins
(`object-cache.php`, `advanced-cache.php`, `db.php`, `sunrise.php`) en
neutraliseert ze: hernoemen naar `<naam>.php.ferry-disabled` (blijft zichtbaar
voor de agent, git registreert het als rename) en `WP_CACHE` op `false` in de
gegenereerde wp-config. De originelen blijven in de kloon staan — het zijn
tenslotte code-artefacten die je misschien juist wilt debuggen.

### 2.7 Containment harness — de kloon is standaard luchtdicht

Een kloon van een webshop die naar buiten mag praten kan echte mails sturen,
echte betaalcalls doen en via cron echte jobs afvuren. Dus: alles dicht,
expliciete allowlist per site.

```php
add_filter('pre_http_request', 'ferry_harness_intercept', 1, 3);
add_filter('pre_wp_mail', '__return_false');
define('DISABLE_WP_CRON', true);
```

Dit lost meteen domeingekoppelde plugins op. Een plugin die zijn licentieserver
belt en "domein onbekend" krijgt, deactiveert zichzelf of zeurt — precies het
gedragsverschil dat debuggen onbetrouwbaar maakt. Oplossing: intercepteer die
call en geef een **gestubde geldige respons**. De plugin gedraagt zich als op
productie, zonder dat er een pakket de deur uitgaat.

Per framework schrijf je die stub één keer. EDD Software Licensing, Freemius en
WooCommerce.com dekken het gros.

### 2.8 Uploads: niet downloaden, terugvallen op productie

`wp-content/uploads` is meestal 90–95% van de bytes en er zit vrijwel nooit
debugwerk in. Niet meenemen.

**Niet oplossen in WordPress** (`upload_url_path`, `wp_get_attachment_url`
filteren) — dat raakt alleen nieuw gegenereerde URL's. De meeste media-URL's
zitten hardcoded in `post_content`, in srcset-attributen, in CSS-backgrounds en
in page builder-JSON. Die glippen er allemaal doorheen.

**Wel oplossen op HTTP-niveau.** Eén regel in de webserverconfig vangt alles:

```nginx
location ~ ^/wp-content/uploads/(.*)$ {
    try_files $uri @ferry_origin;
}
location @ferry_origin {
    return 302 https://klant.nl/wp-content/uploads/$1;
}
```

Nul WordPress-wijzigingen, nul DB-mutaties. Bestaat het lokaal → lokaal serveren.
Bestaat het niet → productie. Werkt meteen ook voor bestanden die je later wél
selectief binnenhaalt.

Botst niet met de harness: die blokkeert server-side `wp_http` en mail; dit is de
*browser* die een statisch bestand ophaalt van de site van je eigen klant.

**Waar het stil faalt** — alles wat de bestanden van schijf leest, plus één
browser-geval:
- `getimagesize()`, `wp_get_image_editor()`, thumbnail-generatie
- `file_exists()`-checks op attachments (veel plugins doen dit)
- EXIF- en metadata-uitlezing
- WooCommerce digitale producten: `filesize()` en de download-handler
- **Cross-origin fonts.** Elementor custom fonts en veel thema's zetten
  woff-bestanden in uploads; via de 302 laden die cross-origin, en zonder
  `Access-Control-Allow-Origin` op productie weigert de browser ze *stil*.
  Visueel debuggen wordt dan misleidend zonder dat er ergens een error staat.
  Mitigatie: fonts (`woff`, `woff2`, `ttf`, `otf`, `eot`) standaard opnemen in
  de v0.2-materialisatie, of tot die tijd meenemen in `ferry fetch-uploads`.

Debug je iets rond media of downloads, dan is deze aanpak juist verkeerd. Daarom
een ontsnappingsluik: `ferry fetch-uploads 2026/07/` of `--all`.

Verder: hotlink-protectie of referrer-checks op productie geven 403's, en een
site achter HTTP-auth werkt niet met een redirect (dan proxyen met credentials).

Bijvoordeel: je hebt klantbestanden — facturen, identiteitsdocumenten bij
sommige plugins — niet op je laptop staan.

*v0.2:* vervang de kale 302 door een PHP-fallback die het bestand ophaalt, **naar
schijf schrijft** en dan serveert. Dan materialiseert alleen wat je bekijkt, en
vanaf dat moment werkt `file_exists()` er ook voor.

### 2.9 State-eigendom: drie categorieën

Divergentie is alleen een probleem als je een replica onderhoudt. Dat doen we
niet — we debuggen code. Deel state in naar eigenaar:

| Categorie | Voorbeelden | Regel |
|---|---|---|
| **Business state** | orders, klanten, posts, comments, sessies, voorraad | productie bezit; wij hebben een read-only foto. Drift is irrelevant. |
| **Code state** | actieve plugins, schema, option-keys waar je aan werkt | wij bezitten tijdens de sessie; dit gaat terug |
| **Environment state** | siteurl, licentiesleutels, API-keys, webhooks, mail | moet verschillen; nooit syncen, in geen enkele richting |

Dat er tijdens je sessie order #4711 binnenkomt is geen probleem — die data gaat
toch nooit terug. Een verouderde foto is prima om code mee te lezen.

### 2.10 Terugschrijven is asymmetrisch

| Laag | Regel |
|---|---|
| Bestanden | diff pushen, atomair, met backup en rollback-token |
| DB-structuur en opties | getypeerde operaties: `set_option`, `delete_option`, `set_postmeta`, `schema_migrate` |
| DB-content | **nooit terugduwen** |

Is de fix "zet deze optie om", dan push je niet de rij maar de operatie. Live data
blijft onaangeraakt.

### 2.11 Drift-detectie: twee checks

**Bestanden.** Vóór de push opnieuw het manifest ophalen en de hashes vergelijken
van precies de bestanden die je gaat overschrijven, tegen het snapshot-moment.
Afwijking → stop, meld conflict.

**Read-set (optimistic concurrency).** Log tijdens de sessie in de kloon welke
option-keys, postmeta en rijen daadwerkelijk *gelezen* zijn (hook op het
`option`-filter en `get_post_meta`). Meestal tientallen keys. Vóór de push
controleer je alleen die op productie. Afwijking → concrete melding:
*"`woocommerce_tax_based_on` is gewijzigd sinds je snapshot — je fix ging uit van
de oude waarde."*

Alle andere drift negeer je bewust. Dat is ontwerp, geen tekortkoming.

### 2.12 Verse data zonder verse kopie

Heb je actuele data nodig ("die order van vanochtend toont verkeerde BTW"), dan
pull je niet de DB opnieuw. Je stelt één gerichte vraag via het control plane:
haal order 4711 en zijn meta op, injecteer in de kloon. Sub-seconde.

Je hebt geen verse *replica* nodig maar een vers *antwoord op één vraag*.

### 2.13 Git als substraat van de mirror

Elke pull is een commit op branch `production`; werk gebeurt op een aparte
branch. Gratis: diffs (dus weet je exact wat terug moet), rollback,
conflictdetectie. En Claude Code is thuis in git.

### 2.14 Snelheid: verstuur niet wat je kunt reconstrueren

Van een typische WP-install van ~60MB is ~45MB core en ~12MB wp.org-plugins —
overal identiek. Slechts ~3MB is echt uniek.

Manifest geeft hash per bestand; vergelijk met officiële checksums
(`api.wordpress.org/core/checksums/1.0/?version=X&locale=Y`; voor plugins
eenmalig uit de zip berekenen). Matches komen van wp.org of uit een lokale
content-addressable cache. Alleen mismatches gaan over de bridge.

Twee bijvangsten:
- Je ziet meteen **welke core- of pluginbestanden aangepast of gehackt zijn**.
- Na tien klantsites heb je vrijwel elke plugin lokaal.

### 2.15 Snelheid: Merkle-tree voor wijzigingsdetectie

`inotify` kan niet op shared hosting, dus je moet vragen. Een volledig manifest
elke paar seconden is te zwaar. Plugin houdt een hash per directory bij, omhoog
gecombineerd tot één root-hash.

Poll alleen die root: ~200 bytes, ~150ms. Gelijk → klaar. Afwijkend → daal alleen
af in de takken waarvan de hash veranderde. Eén gewijzigd bestand in een boom van
10.000 vind je in drie requests.

Aanvullend: change journal via WP-hooks (`upgrader_process_complete`,
`updated_option`, `save_post`) voor alles wat via WP zelf gebeurt. De Merkle-poll
is het vangnet voor wijzigingen daarbuiten (SFTP).

### 2.16 Snelheid: DB-refresh via blok-vingerafdrukken

Per tabel opdelen in blokken van 10k rijen, goedkope vingerafdruk opvragen:

```sql
SELECT COUNT(*), MAX(id), SUM(CRC32(CONCAT_WS('|', id, post_modified, post_status)))
FROM wp_posts WHERE id BETWEEN ? AND ?
```

Milliseconden op een geïndexeerde kolom. Alleen afwijkende blokken ophalen →
refresh in 2–4 seconden.

Eerlijk: een volle WooCommerce-DB van 400MB krijg je bij de **eerste** pull niet
in seconden. Wel: agressief snoeien (revisions, transients, `wc_session`, Action
Scheduler-logs — vaak de helft van de bytes) plus een lite/full-modus.

### 2.17 Warm standby

Draai de eerste clone 's nachts voor alle geregistreerde sites. Dan is "site
openen" nooit een cold start maar altijd een delta.

### 2.18 croc en tunnels — verworpen

[croc](https://github.com/schollz/croc) moet als proces draaien aan beide kanten.
Op een host zonder shell kun je het niet starten, laat staan levend houden.

Het diepere argument: in het geval dát binaries via cron draaibaar zijn, kun je
net zo goed `chisel`/`frp` plus `dropbear` in userspace draaien en heb je een
*echte* SSH-verbinding met native wp-cli. croc vereist dezelfde capability maar
levert minder. Er is geen scenario waarin croc de beste keuze is.

Wat we er wél uit meenemen:
- **PAKE voor pairing** (croc leidt een sterke sleutel af uit een kort
  code-phrase, zonder dat er iets raadbaars over de lijn gaat). Beter dan onze
  pairing-code als die ooit in een log of screenshot belandt. Nadeel: externe
  PHP-library in de plugin. Genoteerd als bekende upgrade, geen v0-werk.
- **De UX-lat.** `ferry link` moet net zo simpel voelen: twee commando's, geen
  config-bestand.

Niet overneembaar: croc comprimeert met zstd; `ext-zstd` zit zelden op shared
hosting, dus wij zitten aan deflate vast.

### 2.19 Multisite: hard weigeren tot expliciet ondersteund

`/info` geeft de multisite-vlag al terug. In plaats van half-werkend gedrag:
`ferry link` weigert multisite-installs met een duidelijke melding. Eén
if-statement, scheelt een complete supportcategorie. Ondersteuning is een
bewuste latere beslissing (subdomein-mapping, `sunrise.php`, per-site tabellen —
elk een eigen probleemgebied), geen graduele feature.

---

## 3. Transport

Beperkingen die alles bepalen: geen shell (dus geen `tar`- of `gzip`-binary),
`max_execution_time` vaak 30s, `memory_limit` rond 128M, `post_max_size` vaak
8–64M, en een WAF die meekijkt in request bodies.

### 3.1 Exclusies zijn overleven, geen optimalisatie

"Alles behalve uploads" is niet houdbaar, ook niet in v0. Eén site met
UpdraftPlus- of All-in-One-backups in `wp-content` en je trekt gigabytes aan
zips binnen — inclusief complete DB-dumps, wat het privacy-argument van §2.8
direct ondergraaft. De doorlooptijdschatting van §4.8 klopt anders alleen op
demo-sites.

v0 sluit daarom een hardcoded lijst van bekende rommeldirectories uit:

```
wp-content/uploads/            (§2.8)
wp-content/cache/
wp-content/updraft/
wp-content/ai1wm-backups/
wp-content/backups*/ 
wp-content/wp-rocket-config/ + cache/wp-rocket/
wp-content/ewww/ (backups)
wp-content/debug.log, error_log (wel via control plane opvraagbaar)
wp-content/upgrade/, upgrade-temp-backup/
```

Plus `wp-config.php` — zie §4.4. De lijst is een constante in de plugin, geen
configuratie; uitbreidbaar per release. Een configureerbaar exclusiemechanisme
blijft v0.1-werk.

### 3.2 Download: de CLI plant, de plugin is dom

Niet één grote tar streamen — dan heb je geen hervatbaarheid, geen parallellisme
en een memory-risico. In plaats daarvan **bin-packing aan de clientkant**: de CLI
heeft het manifest met paden én sizes, verdeelt in batches van ~8MB en vraagt die
op. Server blijft dom, client doet het slimme werk.

**Formaat: zelfgeschreven tar plus incrementele deflate.** `ZipArchive` schrijft
naar een tempfile en leest die terug; `PharData` is op veel hosts geblokkeerd.
Tar schrijven is triviaal (512-byte headers, gepadde blokken, nul extensies) en
met `deflate_add()` blijft geheugengebruik vlak. Ongeveer zestig regels PHP.

Bestanden die al gecomprimeerd zijn (jpg, png, zip, woff) sla je over bij het
comprimeren — scheelt CPU op een host die je vaak throttlet.

### 3.3 Timeouts zijn een normaal antwoord, geen fout

De plugin houdt zijn eigen looptijd bij en stopt met toevoegen zodra hij op ~70%
van `max_execution_time` zit. De tar wordt netjes afgesloten en de headers
vertellen waar hij gebleven is:

```
X-Complete: 0
X-Next-Index: 17
```

De CLI vraagt de rest gewoon opnieuw op. Daarmee bedien je ook hosts met een
`max_execution_time` van 10 seconden.

Dit patroon geldt voor **elk endpoint dat over een collectie itereert** — ook
`/manifest` (§4.4). Een tree-walk over 30.000 bestanden op een gethrottlede host
haalt de time-out net zo goed als een file-batch.

### 3.4 Parallellisme en grote bestanden

Vier tot zes gelijktijdige requests. Meer botst met de limiet op gelijktijdige
PHP-processen per account en maakt het juist trager; terugschakelen bij 429/503.

**Security-plugins zijn hierbij een reële tegenstander, geen edge case.**
Wordfence en vergelijkbare plugins rate-limiten of blokkeren exact dit patroon:
parallelle requests op een onbekende REST-namespace. De 429-backoff vangt een
deel; voor de rest is het een onboarding-realiteit dat de ferry-namespace op
sommige sites in de firewall van de site zelf ge-allowlist moet worden. Dit
hoort in de installatie-instructies en in de foutmeldingen van de CLI ("kreeg
403 van /manifest — draait er een security-plugin?").

Losse bestanden groter dan de batchgrootte via byte-ranges:
`?path=X&offset=0&length=4194304`.

Elke batch bevat per bestand een hash zodat de CLI kan verifiëren — dat vult
meteen het `hash`-veld dat je later voor de Merkle-tree nodig hebt.

### 3.5 Database-export

**Keyset-paginatie, geen `OFFSET`.** `WHERE id > ? ORDER BY id LIMIT 1000` blijft
constant snel; `OFFSET 400000` wordt kwadratisch traag op een grote
`wp_postmeta`. Voor de zeldzame plugintabel zonder bruikbare primary key val je
terug op `OFFSET`.

**Bytebudget, geen rijbudget.** `LIMIT 1000` is een rijlimiet en zegt niets over
bytes. Postmeta-waardes zijn routinematig honderden KB tot enkele MB —
`_elementor_data`, page builder-JSON, geserialiseerde option-blobs. Duizend van
die rijen in één batch blaast door de 128M `memory_limit` aan de plugin-kant.
Daarom adaptief: lees rij voor rij, tel `LENGTH()` op tijdens het streamen, en
sluit de batch bij ~4MB output — ongeacht het aantal rijen. `X-Last-Key` wijst
naar de laatst geëmitteerde rij, dus het hervatmodel verandert niet. De
rijlimiet blijft bestaan als bovengrens voor tabellen met kleine rijen.

**Hex-literals voor waardes.** Emit elke waarde als `0x4a6f...` in plaats van een
quoted string. Dat elimineert de hele categorie encoding-bugs rond emoji,
`utf8mb4` en geserialiseerde data in één klap. Iets grotere output, maar dit is
de bug die dit soort tools het vaakst sloopt.

**Consistentie: wees eerlijk — ook tegen onszelf.** Elk HTTP-request is een
nieuwe DB-connectie, dus je kunt geen transactie over requests heen vasthouden —
een volledig consistente snapshot zoals `mysqldump --single-transaction` is
onmogelijk. Wat je wél doet: bij aanvang de max-ID per tabel vastleggen en
alleen rijen tot die grens lezen. Dat voorkomt dat *nieuwe* rijen halverwege de
export binnensijpelen. Het voorkomt **niet** dat bestaande rijen die je laat in
de export leest, inmiddels ge-update zijn — een order die tijdens de pull van
status wisselt, komt binnen in zijn nieuwe staat naast oudere tabellen in hun
oude staat. Referentiële consistentie tussen tabellen heb je dus niet, en
row-level consistentie binnen late tabellen ook niet. Voor debuggen is dat
prima; het staat hier zodat niemand er een garantie in leest die er niet is.

Schema per tabel via `SHOW CREATE TABLE`. Streamend wegschrijven, gzip per chunk.

### 3.6 Upload (v1.0, maar nu al vastleggen)

Beperkingen draaien om: grootte is geen probleem (diffs zijn kilobytes), maar:

**De WAF is de echte vijand.** mod_security flagt een POST-body met PHP-code
vrijwel gegarandeerd. Dus base64-encoden. 33% meer bytes, op een diff van 4KB
irrelevant.

**Twee fases, transactioneel.** Alle bestanden gaan eerst naar
`wp-content/uploads/.ferry-staging/<txid>/`. De CLI verifieert daar de hashes.
Pas dan doet een aparte `commit`-call de swap: huidige bestanden naar
`.ferry-backup/<txid>/`, nieuwe erin, via `rename()` — atomair op hetzelfde
filesystem. Klapt de upload halverwege, dan is er nog niets toegepast. Rollback
is de renames omkeren.

De DB-kant volgt hetzelfde patroon: getypeerde operaties gaan als lijst mee, oude
waarden worden gelogd vóór toepassing, en `commit` voert ze pas uit nadat de
bestanden gestaged en geverifieerd zijn.

---

## 4. Walking skeleton (v0)

### 4.1 Scope

Volledig **read-only**. Geen schrijf-endpoints, geen push, geen drift-checks. Dat
maakt de plugin triviaal te reviewen en makkelijk geïnstalleerd te krijgen — een
voordeel dat je later kwijt bent.

Wél in v0 (rev. 2): de hardcoded exclusielijst (§3.1), drop-in-neutralisatie
(§2.6), het bytebudget in de DB-export (§3.5), hervatbaar manifest (§3.3), de
multisite-weigering (§2.19) en de lokale admin-gebruiker (§4.6). Dit zijn geen
features maar voorwaarden om de definition of done überhaupt te halen op echte
sites.

```
ferry link <url> --code=XXXX
ferry pull
→ site draait lokaal in DDEV op productie-pariteit, bereikbaar via
  https://klant.ddev.site
```

### 4.2 Projectstructuur

```
ferry-plugin/               ferry-cli/
  ferry.php                   bin/ferry
  src/Auth.php                src/client.ts      ← signed HTTP
  src/Routes.php              src/resolve.ts     ← NAAD
  src/Manifest.php            src/transfer.ts
  src/Db.php                  src/db.ts          ← NAAD
  src/Tar.php                 src/env/ddev.ts    ← NAAD
  src/Excludes.php            src/profile.ts     ← NAAD
                              src/overlay.ts     ← NAAD (incl. drop-ins)
                              src/pull.ts
```

### 4.3 De naden

Elk kost nu vrijwel niets, maar bespaart later een herschrijving.

| Naad | v0 doet | Later |
|---|---|---|
| `resolve()` | `return manifest.map(f => f.path)` | hash-diff + provenance (§2.14) |
| `db.pull()` | alle tabellen, keyset + bytebudget | blok-vingerafdrukken (§2.16) |
| `env/ddev` | DDEV | andere runtimes, remote sandbox |
| `profile` | leesbaar JSON op schijf | centraal opgeslagen in SaaS |
| `snapshot` | platte bestandslijst | Merkle-root + DB-vingerafdrukken |
| `overlay` | siteurl + harness + drop-ins + uploads-fallback + admin-user | volledige env-config per site |
| `excludes` | hardcoded constante | configureerbaar, per-site profiel |

De belangrijkste is `resolve()`. In v0 is dat één regel — maar door hem nú als
aparte functie te hebben, is provenance later één functie vervangen in plaats van
je transferlaag openbreken.

### 4.4 Endpoint-contracten

Versienummer in het pad is niet-onderhandelbaar: dat is je enige
ontsnappingsroute als er ergens een plugin draait die je niet meer kunt updaten.

```
GET /wp-json/ferry/v1/info
→ {
    wp: "6.8",
    php: { version: "8.1.27", extensions: ["gd","imagick","..."],
           ini: { memory_limit: "256M", max_execution_time: 30,
                  post_max_size: "64M", upload_max_filesize: "64M",
                  max_input_vars: 3000 } },
    db:  { server: "mariadb", version: "10.6.16", charset: "utf8mb4",
           collation: "utf8mb4_unicode_520_ci", bytes: 52428800 },
    server: "nginx",
    constants: { WP_DEBUG: false, WP_CACHE: true,
                 WP_ENVIRONMENT_TYPE: "production", "...": "alle user-defined,
                 minus denylist (salts, DB_*)" },
    multisite: false,
    prefix: "wp_",
    abspath: "/home/u/public_html",
    siteurl: "https://klant.nl"
  }

GET /wp-json/ferry/v1/manifest?after=<index>
→ { files: [ { path: "wp-content/themes/x/style.css", size: 4821, hash: null } ] }
  headers: X-Complete, X-Next-Index   ← zelfde hervatpatroon als /files (§3.3)
  (uploads en exclusielijst §3.1 uitgesloten; wp-config.php uitgesloten, zie onder)

POST /wp-json/ferry/v1/files
    { paths: [ "...", "..." ] }
→ tar.gz stream
  headers: X-Complete, X-Next-Index

GET /wp-json/ferry/v1/db/tables
→ { tables: [ { name: "wp_posts", rows: 4210, bytes: 8200000, pk: "ID" } ] }

GET /wp-json/ferry/v1/db?table=wp_posts&after=0&limit=1000
→ gzipped SQL (batch sluit bij ~4MB output, zie §3.5)
  headers: X-Complete, X-Last-Key
```

`hash` mag in v0 `null` zijn — het veld staat er alleen zodat de vorm klopt als je
het straks gaat vullen.

**`wp-config.php` gaat nooit over de bridge.** De CLI genereert hem toch lokaal
(uit `/info.constants` plus DDEV-credentials), dus meesturen levert niets op en
zet DB-credentials en salts van de klant standaard op je laptop. Uitsluiten
verkleint meteen wat een gelekte token waard is — de goedkoopste mitigatie van
het security-risico in §7. `/files` weigert het pad ook bij expliciete opvraag.

### 4.5 Auth (minimaal maar echt)

1. Plugin genereert bij activatie een secret en toont een pairing-code met korte
   geldigheid.
2. `ferry link` wisselt die in; de private kant blijft lokaal.
3. Elke request: header `X-Signature` met HMAC-SHA256 over
   `methode + pad + body + timestamp`, plus een timestamp van maximaal 60
   seconden oud.
4. Zonder geldige koppeling weigert elk endpoint. Geen default-open toestand.

**Klokdrift:** shared hosts lopen soms minuten uit de pas. De CLI gebruikt
daarom niet de lokale klok, maar berekent een offset uit de `Date`-header van de
eerste response en signeert met servertijd. Houdt het 60s-venster werkbaar
zonder het op te rekken.

**Vastgelegd voor later:** HMAC + timestamp betekent dat een onderschept request
60 seconden herspeelbaar is. Voor read-only v0 acceptabel. **Vóór het eerste
schrijf-endpoint bestaat, moet er een nonce-check bij** (server onthoudt
gebruikte nonces binnen het tijdvenster). Dit staat hier expliciet zodat het
niet vergeten wordt op het moment dat het ertoe doet.

### 4.6 De pull-flow

```ts
const info     = await client.info()                 // weigert bij multisite (§2.19)
const env      = await ddev.provision(info)          // async, loopt door
const manifest = await client.manifest()             // hervatbaar (§3.3)
const paths    = resolve(manifest)                   // NAAD: v0 = alles minus excludes
await transfer.fetch(paths, env.docroot)
await db.pull(info, env)                             // NAAD: v0 = alle tabellen
await env.ready                                      // join
await db.import(env)
await overlay.write(env, profile)                    // NAAD: siteurl, harness,
                                                     //   drop-ins, uploads-fallback
await env.createAdmin()                              // ddev wp user create ferry-admin
console.log(env.url, env.adminUrl, env.adminCreds)
```

`await env.ready` op één regel is waar de DDEV-opstart (10–15s) gratis achter het
transport verdwijnt.

**`createAdmin` is geen detail.** "Werkende admin" uit de definition of done
vereist inloggen, en de wachtwoorden van de klant heb je niet (en wil je niet).
Na de import maakt de CLI via `ddev wp user create` een lokale
administrator-gebruiker aan met een gegenereerd wachtwoord en print de
credentials. Bestaat alleen in de kloon; gaat vanzelfsprekend nooit terug.

### 4.7 Definition of done

`ferry link` en `ferry pull` draaien op een echte klantsite, en de kloon opent in
de browser met werkende admin (via de lokaal aangemaakte gebruiker), werkende
permalinks, zichtbare content en zichtbare afbeeldingen (via de
uploads-fallback) — op dezelfde PHP- en DB-versie als productie, zonder dat er
één mail is verstuurd, en zonder fatal door een meegekomen drop-in.

### 4.8 Verwachte doorlooptijd v0

Gemiddelde site, DB ~50MB, exclusielijst actief, zonder provenance, uploads
uitgesloten:

| Stap | Tijd |
|---|---|
| DDEV start | verstopt achter transport |
| Bestanden (~60MB) | 20–40s |
| DB-dump (PHP) | 15–25s |
| Import | 10–20s |
| **Totaal** | **~60–90s** |

Met core-provenance erbij (eerste optimalisatie): ~45–70s.

*Kanttekening:* deze getallen gelden dankzij §3.1. Zonder exclusielijst is dit de
schatting voor demo-sites, niet voor klantsites met jaren aan backup- en
cache-aanslibsel.

### 4.9 Bewust nog niet in v0

Geen git, geen cache, geen Merkle, geen sessies, geen *configureerbare*
exclusies (de hardcoded lijst is er wél), geen provenance, geen enkel
schrijf-endpoint, geen licentie-stubs, geen read-set, geen nonce in auth
(read-only), geen multisite (hard geweigerd, §2.19).

---

## 5. Weg naar het einddoel

Volgorde is ongeveer de aanbevolen bouwvolgorde.

**v0.1 — snelheid**
- Core-provenance via wp.org checksums + lokale cache
- Rapport "afwijkende core-bestanden"
- DB-exclusies (revisions, transients, sessions, Action Scheduler) + lite/full
- Configureerbare bestands-exclusies (bovenop de hardcoded lijst van §3.1)
- Parallelle, hervatbare chunk-transfer afmaken

**v0.2 — bruikbaarheid voor de agent**
- Git-init; pull = commit op `production`
- Automatisch geplaatste `CLAUDE.md` met de spelregels
- Plugin-provenance + content-addressable cache over alle sites
- Licentie-stubs (EDD, Freemius, WooCommerce.com)
- Uploads-fallback die materialiseert in plaats van redirect; fonts standaard
  materialiseren (§2.8, CORS)
- `ferry fetch-uploads`

**v0.3 — incrementeel**
- Merkle-tree in de plugin (incrementeel, persistent buiten `wp_options`)
- Change journal via WP-hooks
- DB blok-vingerafdrukken
- `ferry refresh`

**v1.0 — terugsyncen (het einddoel)**
- Nonce-check in auth (voorwaarde, zie §4.5)
- Sessieconcept met snapshot-punt en verlopend token
- Read-set logging
- Getypeerde DB-operaties
- Change-classificatie (weigert DB-content hard)
- Dry-run met diff, `php -l` gate
- Drift-check bestanden + read-set
- Staging, verificatie, atomaire swap, backup, rollback-token
- Smoke test met automatische rollback
- Audit-log aan beide kanten
- Gerichte live-fetch van losse rijen

**Later — agency-schaal en SaaS**
- Site-register, nachtelijke warm-sync, gedeelde cache
- Kill switch, IP-allowlist, rate limiting, scopes
- PAKE-pairing (§2.18)
- Multisite-ondersteuning (heroverwegen; tot dan §2.19)
- SaaS-dashboard: de CLI blijft de engine, het dashboard is een schil.
  **Enige architectuureis die nú al geldt:** CLI-state in een leesbaar
  bestandsformaat per site, niet in een lokale database — dan is de SaaS-versie
  dezelfde structuur centraal opslaan.

---

## 6. Acceptatiecriterium voor het geheel

> Laat een agent een bug oplossen in een WooCommerce-site die tijdens de sessie
> gewoon orders ontvangt. Push de fix. Toon achteraf aan dat geen enkele order,
> klant of ingekomen wijziging is aangeraakt of verdwenen.

---

## 7. Grootste risico's

| Risico | Waarom |
|---|---|
| `db.pull` correctheid | keyset-paginatie moet kloppen, bytebudget moet werken (§3.5), geen kapotte encoding op emoji en `utf8mb4`. **Dit is waar dit soort tools in de praktijk stukloopt.** |
| Security-plugins op de site zelf | Wordfence e.d. blokkeren parallelle requests op onbekende REST-routes; deels onboarding-probleem, deels UX-probleem (herkenbare foutmeldingen, §3.4) |
| Merkle-onderhoud | moet incrementeel, anders vertraagt de plugin de site zelf |
| Read-set granulariteit | fijnmazig genoeg om nuttig te zijn, grof genoeg om goedkoop te blijven |
| Uploads-fallback | faalt stil bij alles wat van schijf leest, en bij cross-origin fonts (§2.8) |
| Exclusielijst-onderhoud | elke gemiste backup-plugin-directory is een 5GB-pull bij een klant; lijst moet per release meegroeien |
| Security | ook zonder command-executie is een schrijf-endpoint een aanvalsoppervlak; één gelekte token raakt een klantsite. Mitigaties nu al: wp-config nooit over de bridge (§4.4), nonce vóór v1.0 (§4.5) |

---

## 8. Openstaande vragen

- Read-set: hoe grofmazig, en waar opslaan zonder de kloon te vertragen?
- Licentie-stubs: per framework of per plugin? Hoe onderhouden?
- Sites met `wp-content` buiten `ABSPATH` of afwijkende `WP_CONTENT_DIR`
- Betrouwbare plugin-versiedetectie voor provenance (`readme.txt` is niet altijd
  accuraat)
- Hoe ver ga je in het repliceren van php.ini — alles overnemen kan lokaal
  onwerkbaar traag of beperkt worden
- Constanten-denylist (§2.5): is salts + `DB_*` afdoende, of zijn er hosts die
  secrets in andere constanten stoppen (API-keys van hostingpanelen)? Mogelijk
  aanvullend patroon-filter (`*_KEY`, `*_SECRET`, `*_TOKEN`) met opt-in.

*Opgelost sinds rev. 1:* multisite (hard weigeren, §2.19), wp-config-constanten
(alles minus denylist, §2.5).

---

## 9. Concurrentie-realiteit

WP Migrate (Delicious Brains) doet de pull naar lokaal al jaren. Het onderscheid
zit niet in het syncen zelf, maar in:

1. snelheid van incrementele refresh,
2. het agent-vriendelijke oppervlak,
3. veilig terugschrijven met drift-detectie — dat doet niemand goed.

---

## 10. Verwerkte reviewpunten (rev. 2)

Voor traceerbaarheid — wat er sinds rev. 1 is gewijzigd en waar:

| Punt | Waar verwerkt |
|---|---|
| Drop-ins (object-cache, advanced-cache) fatalen lokaal | §2.6 — neutralisatie in overlay, v0-scope |
| Exclusielijst is overleven, niet v0.1-luxe | §3.1 nieuw; §4.1, §4.8, §7 |
| Postmeta-rijgrootte blaast memory_limit op | §3.5 — bytebudget ~4MB per batch |
| `/manifest` niet hervatbaar | §3.3, §4.4 — zelfde X-Complete-patroon |
| Werkende admin vergt lokale gebruiker | §4.6 `createAdmin`, §4.7 |
| wp-config-constanten: 4 is te weinig | §2.5 — alle user-defined minus denylist |
| `wp-config.php` niet over de bridge | §4.4 |
| Replay-window + klokdrift in auth | §4.5 — servertijd-offset nu, nonce vóór v1.0 |
| Cross-origin fonts falen stil | §2.8, §2.16→v0.2-plan |
| Multisite hard weigeren | §2.19 nieuw |
| Consistentie-claim te sterk geformuleerd | §3.5 — expliciet wat wél/niet gegarandeerd is |
| Wordfence/security-plugins als tegenstander | §3.4, §7 |
