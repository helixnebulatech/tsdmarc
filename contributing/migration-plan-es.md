# Plan de migración: parsedmarc → tsdmarc

Aprobado por el usuario el 24/10/2026: port **1:1** de parsedmarc a TypeScript, repo propio, licencia **Apache-2.0**, publicable en npm como `tsdmarc` y `@tsdmarc/*`. Publicar (npm, GitHub) requiere confirmación del usuario y sus cuentas.

## Origen

- parsedmarc 11.2.1, commit `7bbc405c01a1c4c37811b2a3746e8881c00cda39` → `upstream/parsedmarc` (no versionado, en `.gitignore`). El port inicial fue de la 11.0.5 (commit `050fa9b0cac8ffc78f0c16d3c377d90e0829e604`), actualizado después a la 11.1.0 (commit `5a6cf2175f395a8f58f13bf004a9d81e21e4e0b9`).
- mailsuite 2.3.4, commit `3bd62831d137c9aa7884be33b83323ca3a1bd1de` → `upstream/mailsuite` (port inicial: 2.3.2, commit `b9a71d08093476b81f35066b471c672317d55bc4`; después 2.3.3, commit `4155f1f763065ea4f2e62fc0e86389ace4403ce0`). Solo se portan las partes que usa parsedmarc: `mailsuite.mailbox` (IMAP, Gmail, Microsoft Graph, Maildir) y `mailsuite.smtp.send_email`.
- No usar el nombre "parsedmarc" en los paquetes: la licencia Apache no da derechos de marca. Atribución en `NOTICE`.

## Tamaño

- Librería parsedmarc: ~15.000 líneas Python (`__init__.py` 3.800, `cli.py` 4.000, `utils.py` 1.500, `elastic.py` 1.460, `opensearch.py` 1.390, `postgres.py` 880, resto de salidas pequeñas).
- Tests: ~24.000 líneas, ~650 tests. Muestras: 35 ficheros en `samples/`.
- mailsuite (partes usadas): ~2.000 líneas.
- `resources/maps/*.py` son scripts de mantenimiento, fuera del alcance; sí se copian los datos (`base_reverse_dns_map.csv`, `known_unknown_base_reverse_dns.txt`, `psl_overrides.txt`, `ipinfo_lite.mmdb`).
- `dashboards/` (Grafana, OpenSearch, Splunk) se copian tal cual.

## Excepciones al 1:1

1. **Elasticsearch 9** (`@elastic/elasticsearch@9`). parsedmarc fija `elasticsearch>=8.18,<9`. Es la única excepción de funcionalidad.
2. **API en camelCase.** Las claves en snake_case solo aparecen en las salidas (ver Convenciones). El contenido de las salidas es el mismo que en parsedmarc.

## Estructura del repo (inspirada en el AI SDK de Vercel)

Monorepo con pnpm workspaces + Turborepo. Base generada con Better-T-Stack (Turborepo, Ultracite con oxlint + oxfmt, lefthook), quitando `zod` y `varlock`, que la plantilla añade y no se usan.

```
packages/
  tsdmarc/          núcleo: parseo, utils, DNS, GeoIP, CSV/JSON, Maildir, Splunk,
                    syslog, GELF, webhook, Loki, interfaces de buzón y de salida
  imap/             @tsdmarc/imap           imapflow
  gmail/            @tsdmarc/gmail          @googleapis/gmail + google-auth-library
  msgraph/          @tsdmarc/msgraph        fetch a la API REST + @azure/identity
  smtp/             @tsdmarc/smtp           nodemailer
  elasticsearch/    @tsdmarc/elasticsearch  @elastic/elasticsearch@9
  opensearch/       @tsdmarc/opensearch     @opensearch-project/opensearch
  postgres/         @tsdmarc/postgres       pg
  kafka/            @tsdmarc/kafka          @platformatic/kafka
  s3/               @tsdmarc/s3             @aws-sdk/client-s3 + credential-providers
  loganalytics/     @tsdmarc/loganalytics   @azure/monitor-ingestion + @azure/identity
  ipinfo-lite/      @tsdmarc/ipinfo-lite    solo la base ipinfo_lite.mmdb (25 MB)
  cli/              @tsdmarc/cli            comando `tsdmarc`; depende de todos
tools/              tsconfig y tsdown compartidos (privados)
examples/           uso desde Node, Bun y Deno
fixtures/           salidas de referencia generadas con parsedmarc (Python)
architecture/       cómo encajan los paquetes (para agentes y contribuidores)
samples/  dashboards/  docs/  .changeset/  .github/
```

- El núcleo define las interfaces de buzón y de salida; cada paquete `@tsdmarc/*` las implementa (como `@ai-sdk/provider`).
- Los recursos pequeños (`base_reverse_dns_map.csv`, `known_unknown_base_reverse_dns.txt`, `psl_overrides.txt`) van dentro de `tsdmarc`.
- GeoIP: si `@tsdmarc/ipinfo-lite` está instalado, se usa sin red; si no, el núcleo descarga la base la primera vez y la actualiza, como parsedmarc.
- Para publicar con el prefijo `@tsdmarc/` hay que crear la organización `tsdmarc` en npm (cuenta del usuario, al publicar).

## Empaquetado y compatibilidad

- Compilación con **tsdown** a `dist/` (`.js` + `.d.ts`), solo ESM, `sideEffects: false`, mapa `exports` con `types`. Igual que el AI SDK.
- Compatible con **Node ≥ 24**, Bun y Deno. Solo módulos `node:*` que existen en los tres.
- Comprobación de cada paquete con **publint** y **@arethetypeswrong/cli**.
- **`tsrs` en todos los checks y scripts** (type check, `package.json`, Turborepo, CI), nunca `tsc`. Los `.d.ts` los genera tsdown con oxc (`isolatedDeclarations`), sin `tsc`.

## Convenciones

- Funciones, tipos y propiedades del API en **camelCase** (`parseAggregateReportXml`, `report.policyPublished.domain`).
- Conversión a **snake_case** idéntica a Python en un único punto, al escribir las salidas: JSON, CSV, Elasticsearch, OpenSearch, Splunk, Kafka, S3, Postgres, Log Analytics, syslog, GELF y webhook. Un solo mapa de claves, cubierto por los tests contra `fixtures/`.
- Argumentos con nombre de Python → objeto de opciones.
- Funciones con red/DNS/disco → `async`.
- ESM, TypeScript estricto.
- Expresiones regulares: misma regla anti-backtracking que parsedmarc (ver `upstream/parsedmarc/AGENTS.md`), traducidas una a una (`(?P<name>)`, `\Z`, etc. no existen en JS).
- Variables de entorno: `TSDMARC_*`, aceptando también `PARSEDMARC_*` para facilitar la migración. Si están las dos, gana `TSDMARC_*`.
- El fichero de configuración INI es compatible con el de parsedmarc.

## Dependencias

| Python | TypeScript |
| --- | --- |
| xmltodict / lxml | parser propio: port de Expat + xmltodict y emulación de la recuperación de libxml2 (los mensajes de error de Expat forman parte de la salida de parsedmarc; fast-xml-parser no podía reproducirlos) |
| mail-parser | port de mail-parser 4.8.0 y del paquete `email` de Python (postal-mime no permitía igualar la salida) |
| zipfile / zlib | fflate + node:zlib (con límite de 100 MiB) |
| dnspython (DoH/DoT) | node:dns + dns-packet (DoH vía fetch, DoT vía tls) |
| maxminddb | maxmind |
| publicsuffixlist + overrides | tldts + capa propia para `psl_overrides.txt` |
| PyYAML | yaml |
| python-dateutil | parser de fechas propio (las cabeceras `Date` de emails son muy variadas) |
| ExpiringDict, ConfigParser, csv | implementaciones propias |
| argparse | commander |
| tqdm | barra de progreso propia en la CLI |
| httpx | fetch |
| elasticsearch / opensearch-py | @elastic/elasticsearch@9 / @opensearch-project/opensearch |
| kafka-python | @platformatic/kafka (kafkajs está abandonada desde 2023) |
| boto3 | @aws-sdk/client-s3, @aws-sdk/credential-providers |
| azure-monitor-ingestion | @azure/identity + @azure/monitor-ingestion |
| psycopg | pg |
| pygelf, SysLogHandler | implementación propia |
| IMAPClient | imapflow |
| Gmail API | @googleapis/gmail + google-auth-library |
| msgraph-sdk | fetch a la API REST de Graph + @azure/identity (el cliente oficial no se publica desde 2023 y el nuevo sigue en preview) |
| smtplib (mailsuite) | nodemailer |
| ProcessPoolExecutor | worker_threads |

## Detalles Python → JS que hay que respetar

- **Zona horaria:** `timestamp_to_datetime` usa la hora local de la máquina. Se replica; los tests se ejecutan con `TZ` fijo.
- **JSON:** igual en contenido, no byte a byte (no se replica el escape `\uXXXX` de `json.dumps`).
- **CSV:** como `csv.DictWriter` de Python: líneas `\r\n` y comillas solo cuando hacen falta.
- **Charsets** de emails antiguos (iso-2022-jp, gb2312…): `TextDecoder` se comporta distinto en Node, Bun y Deno; los tests de humo lo comprueban en los tres.
- **Autenticación de Microsoft Graph:** usuario + contraseña (`UsernamePasswordCredential`) se porta, pero marcado como obsoleto (no funciona con MFA y está obsoleto en `@azure/identity`).
- **Gmail:** el flujo que abre el navegador con un servidor local (`InstalledAppFlow`) no existe en Node; se implementa. El `token.json` es compatible con el de parsedmarc.

## Seguridad

- Límite de 100 MiB al descomprimir ZIP/GZIP.
- XML sin procesar entidades (sin XXE ni "billion laughs"); los informes agregados con DOCTYPE se rechazan, como en parsedmarc 11.1.0.
- Límite de tamaño para emails.
- Timeouts en todas las conexiones de red.
- Verificación TLS activada por defecto.
- Nunca escribir secretos en los logs.

## Tests

- **Vitest** (como el AI SDK), ejecutado en Node 24 y 26.
- Tests de humo del código compilado (`dist/`) en Bun y Deno.
- Mismo criterio que parsedmarc: mocks solo en la frontera con SDKs externos y comprobar lo que se envía. Sin tests de integración con contenedores.
- **Fixtures de referencia:** la versión portada de parsedmarc (11.2.1, con mailsuite 2.3.4) instalada en un venv (Python 3.14 local) genera la salida JSON y CSV de las 35 muestras; los tests comparan contra ella. Un script en `tools/` las regenera.

## CI y publicación (réplica de vercel/ai)

- **Gestor de paquetes: pnpm**, como Vercel. changesets no soporta Bun: publicaría con `npm publish` sin reescribir `workspace:*`. Bun se sigue probando como runtime.
- **`ci.yml`** (push a `main` y PR):
  - Lint y formato con `ultracite check`.
  - Type check con `tsrs`.
  - Compilación de paquetes, con `dist/` guardado como artifact y reutilizado en los tests.
  - publint + attw.
  - Matriz de tests en Node 24 y 26. En los PR, solo Node 24 si no tocan `src/` ni tests.
  - Tests de humo en Bun y Deno.
  - Job final "todos los jobs requeridos pasaron" para la protección de la rama.
- **`release.yml`**:
  - `changesets/action` abre el PR "Version Packages"; al hacer merge, se compilan y empaquetan los paquetes y se publican los tarballs con `npm publish` (no con `changeset publish`). El script `ci:release` de `package.json` ya no lo usa ningún workflow.
  - Trusted publishing por OIDC (`id-token: write`, sin `NPM_TOKEN`) y `"provenance": true` en `publishConfig`.
  - Versiones _snapshot_ con `workflow_dispatch` y la etiqueta `snapshot`.
  - Commits firmados (`commitMode: github-api`), `concurrency` sin cancelar y sin ejecutarse en forks.
  - Entorno protegido `Release` (como Better Auth, añadido el 28/10/2026): cuatro jobs en la publicación normal. "Version Packages PR" sin entorno (crea el PR y lanza `ci.yml` y `verify-changesets.yml` sobre él); "Build tarballs" sin entorno ni token, cuando ya no quedan changesets (compila, empaqueta con `pnpm pack` lo que aún no está en npm y guarda los tarballs como artifact, con un `manifest.json` y sus SHA-256); "Publish to npm" en el entorno `Release`, con solo `contents: read` e `id-token: write`, que solo descarga `.github/scripts` y publica esos tarballs con npm (`--ignore-scripts`, sin instalar ni ejecutar nada del workspace; salta lo que ya está en npm, así que se puede relanzar); "GitHub Releases" fuera del entorno (etiquetas, notas del CHANGELOG y provenance adjunto, también tras una publicación parcial). Los snapshots siguen el mismo esquema ("Build snapshot tarballs" sin entorno y "Snapshot Release" en él). El entorno solo admite la rama `main`; los revisores obligatorios se añaden cuando el repo sea público (en privado el plan gratuito no los permite). En npm, el trusted publisher de cada paquete debe indicar el entorno `Release`.
- **`lint-workflows.yml`:** actionlint y zizmor en cada cambio de workflows.
- **`verify-changesets.yml`:** un PR que toque `packages/*` debe incluir un changeset.
- **Dependabot:** semanal, actualizaciones agrupadas por tipo y 3 días de espera (`cooldown`).
- **Seguridad de los workflows:**
  - Actions fijadas por SHA con el comentario de la versión.
  - `persist-credentials: false`.
  - Permisos `contents: read` por defecto y ampliados solo por job.
- **Versiones:** changesets con versiones independientes por paquete (`fixed: []`), `access: public` y `updateInternalDependencies: patch`.
- No se copian las partes propias de Vercel: Slack, backports, sincronización de modelos, docs site, tests de bundlers, RSC, Windows y caché remota de Turborepo.
- Se configura cuando el usuario decida publicar.

## Seguimiento de parsedmarc

- El commit portado queda en `NOTICE` y en este plan.
- Para cada versión nueva de parsedmarc o mailsuite se porta el diff entre commits y se regeneran los fixtures.

## Orden de trabajo

1. Crear la base del monorepo (Better-T-Stack + estructura de arriba + pnpm), mover lo ya hecho y hacer el **primer commit**.
2. Contratos comunes, antes de lanzar agentes:
   - `types.ts` en camelCase.
   - Conversor a snake_case.
   - `errors.ts`.
   - `log.ts`: mini-logging al estilo Python, necesario para syslog/GELF y para capturar logs en tests.
   - Interfaces de buzón y de salida.
3. Generar los fixtures de referencia con parsedmarc (Python).
4. Agentes en paralelo, cada uno en su worktree:
   1. `utils` + `config`
   2. Núcleo de parseo: agregados, SMTP TLS, extracción, CSV
   3. Núcleo de parseo: informes de fallo, emails, `parseReportFile`, buzones, `watchInbox`, salida
   4. `@tsdmarc/imap`, `gmail`, `msgraph`, Maildir y `@tsdmarc/smtp`
   5. `@tsdmarc/elasticsearch` y `@tsdmarc/opensearch`
   6. `@tsdmarc/postgres`, `kafka`, `s3`, `loganalytics` y, en el núcleo, Splunk, syslog, GELF y webhook
   7. `@tsdmarc/cli`: configuración INI/variables de entorno y paralelismo (al final)
5. `architecture/`, `examples/`, CI.

## Estado actual

- Port terminado (en `main`):
  - Monorepo, CI, tests de humo (Node 24 y 26, Bun, Deno), publint/attw, fixtures de referencia y contratos del núcleo.
  - Utilidades: fechas (dateutil), CSV, DNS (dnspython, con dns-packet), dominios/PSL, información de IP (maxminddb), parser XML (Expat + xmltodict), parseo de emails (port del paquete `email` de Python y de mail-parser), ZIP/zlib/bzip2/LZMA/Zstandard.
  - Informes: agregados, de fallo y SMTP TLS; `extractReport`, `parseReportEmail`, `parseReportFile`, mbox y parseo en paralelo (`worker_threads`).
  - Buzones: Maildir, IMAP, Gmail, Microsoft Graph; `getDmarcReportsFromMailbox`/`watchInbox`; SMTP (`sendEmail`, `emailResults`).
  - Salidas: ficheros JSON/CSV, Elasticsearch, OpenSearch, Postgres, Kafka, S3, Log Analytics, Splunk, syslog, GELF, webhook y Grafana Loki. Los enteros mayores que 2^53 se escriben exactos en todas, como parsedmarc.
  - CLI `tsdmarc`: configuración INI y variables de entorno, modo watch, recarga con SIGHUP y paralelismo.
  - Correcciones de la revisión final integradas; todos los paquetes tienen tests (sin `passWithNoTests`).
- Actualizado a parsedmarc 11.1.0 y mailsuite 2.3.3: rechazo de DOCTYPE en informes agregados (también en la recuperación con lxml, que ahora serializa solo el elemento raíz), `parseReportEmail()` solo lanza `ParserError`, errores de contenido al leer un mensaje del buzón lo marcan como inválido, nombres de fichero de 100 bytes UTF-8, `sanitizeForLog()`, escape de fórmulas en CSV, Maildir sin re-serializar mensajes, opción `starttls` en IMAP/SMTP y base IPinfo Lite nueva. Fixtures regenerados.
- Auditoría de seguridad (noviembre de 2026): 125 hallazgos corregidos. Añade límites de parseo y de trabajo por informe (`ParserConfig` y claves INI nuevas), evita que un informe corte un lote o se dé por guardado sin estarlo, y `release.yml` publica tarballs ya compilados desde el entorno `Release`. Lo que se aparta de parsedmarc está en `architecture/README.md`.
- Actualizado a parsedmarc 11.2.1 y mailsuite 2.3.4 (noviembre de 2026): salida Grafana Loki (`[loki]`, en el núcleo) con su dashboard, data streams en Elasticsearch/OpenSearch (`use_data_streams`, `@timestamp` en todos los documentos), STARTTLS obligatorio antes de enviar credenciales en IMAP/SMTP salvo `starttls = False` (se elimina `allow_plaintext_auth`, propia de tsdmarc), claves y metadatos de S3 saneados y terminados en hash (y los informes de fallo se guardan en S3), credenciales de URLs enmascaradas en los logs (`redactUrlCredentials()`), pre-flight DNS que muestra el error real del resolver, y dedup de agregados por emisor, Report-ID y dominio. Fixtures regenerados.
- Segunda auditoría, hecha en paralelo sobre el commit inicial (noviembre de 2026): sus 35 hallazgos, revisados contra `main`, con las correcciones que faltaban portadas (tiempo de búsquedas por informe `max_lookup_time_per_report`, límite de lectura en IMAP, reanudación de agregados a medio guardar en Elasticsearch/OpenSearch, `@azure/identity` `^4.14.1` sin override de msal-node, entre otras).
- Desviaciones que quedan, documentadas en `architecture/README.md` («Differences from parsedmarc»).
- Fuera de alcance: `resources/maps/*.py` y `test_maps.py`.
- Repo privado en GitHub (`helixnebulatech/tsdmarc`), con commits firmados por SSH desde aquí. Nada publicado en npm.
- Decisiones de publicación (28/10/2026): el repo público será `helixnebulatech/tsdmarc` (enlaces, `repository` y la condición de `release.yml` ya apuntan ahí); primera versión `1.0.0` para los 13 paquetes (changeset `initial-release`); documentación en inglés con Astro Starlight (`apps/docs`), publicada en GitHub Pages más adelante; contacto del código de conducta por el formulario privado de GitHub.
