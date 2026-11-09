---
'tsdmarc': patch
---

`VERSION` and `USER_AGENT` report the installed version: 1.0.0 shipped with `0.0.0`, so `tsdmarc --version`, the `User-Agent` sent to Splunk, Loki and Microsoft Graph, and the Kafka `clientId` all said `0.0.0`. The version now comes from `package.json` at build time.
