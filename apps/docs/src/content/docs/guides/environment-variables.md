---
title: Environment variables
description: Configure the tsdmarc command with TSDMARC_* (or parsedmarc's PARSEDMARC_*) environment variables and Docker secrets.
---

Any [configuration option](../configuration/) can be set with an environment variable named `TSDMARC_{SECTION}_{KEY}` in upper case. This is especially useful in containers, where mounting a configuration file with secrets is awkward.

**Priority:** environment variables override the configuration file. An option set in either one also overrides the matching command-line argument (for example `TSDMARC_GENERAL_OUTPUT` wins over `--output`), as in parsedmarc. Command-line arguments apply to options that neither sets.

## `TSDMARC_*` and `PARSEDMARC_*`

To make migrating from parsedmarc painless, every variable is also accepted with parsedmarc's `PARSEDMARC_` prefix. When both are set for the same option, the `TSDMARC_` one wins.

| tsdmarc                      | parsedmarc (also accepted)      |
| ---------------------------- | ------------------------------- |
| `TSDMARC_IMAP_PASSWORD`      | `PARSEDMARC_IMAP_PASSWORD`      |
| `TSDMARC_CONFIG_FILE`        | `PARSEDMARC_CONFIG_FILE`        |
| `TSDMARC_DEBUG`              | `PARSEDMARC_DEBUG`, `DEBUG`     |
| `TSDMARC_IMAP_PASSWORD_FILE` | `PARSEDMARC_IMAP_PASSWORD_FILE` |

A bare `DEBUG` is also read by other Node.js tools (`DEBUG=*`, `DEBUG=express:*`), so tsdmarc only takes it when it is a boolean and otherwise logs a warning and ignores it; parsedmarc fails to start on such a value. `TSDMARC_DEBUG` and `PARSEDMARC_DEBUG` must be booleans.

## Examples

```sh
# IMAP credentials
export TSDMARC_IMAP_HOST=imap.example.com
export TSDMARC_IMAP_USER=dmarc@example.com
export TSDMARC_IMAP_PASSWORD=secret

# Elasticsearch
export TSDMARC_ELASTICSEARCH_HOSTS=http://localhost:9200
export TSDMARC_ELASTICSEARCH_SSL=false

# Splunk HEC (the section splunk_hec becomes SPLUNK_HEC)
export TSDMARC_SPLUNK_HEC_URL=https://splunk.example.com
export TSDMARC_SPLUNK_HEC_TOKEN=my-hec-token
export TSDMARC_SPLUNK_HEC_INDEX=email

# General settings
export TSDMARC_GENERAL_SAVE_AGGREGATE=true
export TSDMARC_GENERAL_DEBUG=true

# Grafana Loki
export TSDMARC_LOKI_URL=https://loki.example.com:3100
export TSDMARC_LOKI_USERNAME=tsdmarc
export TSDMARC_LOKI_PASSWORD_FILE=/run/secrets/loki_password

# tsdmarc-only options work the same way
export TSDMARC_GENERAL_CSV_FORMULA_ESCAPE=false
export TSDMARC_GENERAL_MAX_EMAIL_SIZE=104857600
export TSDMARC_GENERAL_JOB_TIMEOUT=600
export TSDMARC_GENERAL_MAX_LOOKUP_TIME_PER_REPORT=300
export TSDMARC_POSTGRESQL_SSLMODE=verify-full
export TSDMARC_S3_PREVENT_OVERWRITE=true
```

## Choosing the configuration file

```sh
export TSDMARC_CONFIG_FILE=/etc/tsdmarc.ini
tsdmarc
```

`-c/--config-file` takes precedence over the variable.

## Without a configuration file

When no configuration file is given (neither `-c` nor `TSDMARC_CONFIG_FILE`), the `TSDMARC_*` / `PARSEDMARC_*` variables alone configure tsdmarc:

```sh
export TSDMARC_GENERAL_SAVE_AGGREGATE=true
export TSDMARC_GENERAL_OFFLINE=true
export TSDMARC_ELASTICSEARCH_HOSTS=http://elasticsearch:9200
tsdmarc /path/to/reports/*
```

As with a configuration file, the results are then not printed (`silent` is implied) unless `TSDMARC_GENERAL_SILENT=false` is set.

## Docker Compose example

```yaml
services:
  tsdmarc:
    image: node:24-slim
    command: npx --yes --package @tsdmarc/cli tsdmarc
    environment:
      TSDMARC_IMAP_HOST: imap.example.com
      TSDMARC_IMAP_USER: dmarc@example.com
      TSDMARC_IMAP_PASSWORD: ${IMAP_PASSWORD}
      TSDMARC_MAILBOX_WATCH: 'true'
      TSDMARC_ELASTICSEARCH_HOSTS: http://elasticsearch:9200
      TSDMARC_GENERAL_SAVE_AGGREGATE: 'true'
      TSDMARC_GENERAL_SAVE_FAILURE: 'true'
```

## Secrets in files (`_FILE` suffix)

Any `TSDMARC_{SECTION}_{KEY}` variable can be read from a file by appending `_FILE` to its name. The file's contents, without trailing CR/LF characters, become the value. This is the convention of the official Postgres, MariaDB and Redis images, and plugs straight into Docker, Docker Compose and Kubernetes secrets, so credentials never appear in `environment:` blocks (readable through `docker inspect` and `/proc/<pid>/environ`).

```yaml
secrets:
  imap_password:
    file: ./secrets/imap_password.txt

services:
  tsdmarc:
    secrets:
      - imap_password
    environment:
      TSDMARC_IMAP_HOST: imap.example.com
      TSDMARC_IMAP_USER: dmarc@example.com
      TSDMARC_IMAP_PASSWORD_FILE: /run/secrets/imap_password
```

- If both the variable and its `_FILE` form are set, the `_FILE` form wins (within the same prefix; any `TSDMARC_` variable still wins over any `PARSEDMARC_` one).
- A missing, unreadable or non-UTF-8 file is a configuration error; tsdmarc never silently falls back to an empty value.
- `DEBUG`, `TSDMARC_DEBUG`, `PARSEDMARC_DEBUG` and the `*_CONFIG_FILE` variables have no `_FILE` form.
- Four options already end in `_file`: `[general] log_file`, `[msgraph] token_file`, `[gmail_api] credentials_file` and `[gmail_api] token_file`. Their variables (`TSDMARC_GMAIL_API_CREDENTIALS_FILE`, …) hold the path itself. To pass such a path through a secret, double the suffix: `TSDMARC_GMAIL_API_CREDENTIALS_FILE_FILE`.

## Section names

Sections with underscores keep them; the longest matching section name wins (`TSDMARC_SPLUNK_HEC_TOKEN` is `[splunk_hec] token`). Unrecognized variables are ignored (logged at debug level).

| Section         | Variable prefix          |
| --------------- | ------------------------ |
| `general`       | `TSDMARC_GENERAL_`       |
| `mailbox`       | `TSDMARC_MAILBOX_`       |
| `imap`          | `TSDMARC_IMAP_`          |
| `msgraph`       | `TSDMARC_MSGRAPH_`       |
| `gmail_api`     | `TSDMARC_GMAIL_API_`     |
| `maildir`       | `TSDMARC_MAILDIR_`       |
| `elasticsearch` | `TSDMARC_ELASTICSEARCH_` |
| `opensearch`    | `TSDMARC_OPENSEARCH_`    |
| `splunk_hec`    | `TSDMARC_SPLUNK_HEC_`    |
| `kafka`         | `TSDMARC_KAFKA_`         |
| `smtp`          | `TSDMARC_SMTP_`          |
| `s3`            | `TSDMARC_S3_`            |
| `postgresql`    | `TSDMARC_POSTGRESQL_`    |
| `syslog`        | `TSDMARC_SYSLOG_`        |
| `log_analytics` | `TSDMARC_LOG_ANALYTICS_` |
| `gelf`          | `TSDMARC_GELF_`          |
| `webhook`       | `TSDMARC_WEBHOOK_`       |
| `loki`          | `TSDMARC_LOKI_`          |

## Other variables

| Variable | Effect |
| --- | --- |
| `TZ` | Time zone of the local-time dates in the output (like parsedmarc) |
| `XDG_CACHE_HOME` | Base directory of the download cache (`$XDG_CACHE_HOME/tsdmarc`) |
| `NODE_USE_ENV_PROXY`, `HTTP(S)_PROXY`, `NO_PROXY` | HTTP proxy for downloads and DNS over HTTPS (Node.js) |
| `NODE_EXTRA_CA_CERTS` | Extra trusted CAs (instead of parsedmarc's `SSL_CERT_FILE`) |
| `PGHOST`, `PGPASSWORD`, `PGSSLMODE`, … | libpq defaults for the PostgreSQL output |
| AWS variables (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, …) | Default credentials and region for S3 and OpenSearch SigV4 |
