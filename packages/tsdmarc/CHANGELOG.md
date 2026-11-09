# tsdmarc

## 1.0.1

### Patch Changes

- 248151a: `VERSION` and `USER_AGENT` report the installed version: 1.0.0 shipped with `0.0.0`, so `tsdmarc --version`, the `User-Agent` sent to Splunk, Loki and Microsoft Graph, and the Kafka `clientId` all said `0.0.0`. The version now comes from `package.json` at build time.

## 1.0.0

### Major Changes

- a1c5fad: First release: a 1:1 TypeScript port of parsedmarc 11.2.1 and of the parts of mailsuite 2.3.4 it uses, for Node.js 24+, Bun and Deno.

### Patch Changes

- Updated dependencies [a1c5fad]
  - @tsdmarc/ipinfo-lite@1.0.0
