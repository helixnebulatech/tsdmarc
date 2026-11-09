---
title: Running as a service
description: Run tsdmarc in watch mode under systemd, reload its configuration with SIGHUP and stop it cleanly.
---

In watch mode (`[mailbox] watch = True`), tsdmarc keeps running and processes reports as they arrive. Run it under a service manager such as systemd.

This assumes tsdmarc was installed in `/opt/tsdmarc` under a `tsdmarc` system user, as shown in [Installation](../../getting-started/installation/#the-command-line-tool).

## systemd

Protect the configuration file:

```sh
sudo chown root:tsdmarc /etc/tsdmarc.ini
sudo chmod u=rw,g=r,o= /etc/tsdmarc.ini
```

Create `/etc/systemd/system/tsdmarc.service`:

```ini title="/etc/systemd/system/tsdmarc.service"
[Unit]
Description=tsdmarc mailbox watcher
Wants=network-online.target
After=network.target network-online.target elasticsearch.service

[Service]
ExecStart=/opt/tsdmarc/node_modules/.bin/tsdmarc -c /etc/tsdmarc.ini
ExecReload=/bin/kill -HUP $MAINPID
KillSignal=SIGTERM
TimeoutStopSec=60
User=tsdmarc
Group=tsdmarc
Restart=always
RestartSec=5m

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tsdmarc.service
```

Run `daemon-reload` again whenever you edit the unit file, and restart the service after every upgrade of tsdmarc:

```sh
sudo systemctl restart tsdmarc
```

Check its status and logs (newest first):

```sh
systemctl status tsdmarc
journalctl -u tsdmarc.service -r
```

After a crash, systemd restarts the service after 5 minutes (`RestartSec`).

## Stopping

On `SIGTERM` or `SIGINT` (`systemctl stop`, Ctrl-C), tsdmarc finishes the current batch, flushes its outputs, closes every connection and exits. A waiting watch (IMAP IDLE or the pause between checks) is interrupted right away. Keep `TimeoutStopSec` comfortably above the time a batch takes, or systemd will kill tsdmarc mid-batch. In the foreground, a second Ctrl-C quits immediately, skipping the flush.

## Reloading the configuration

Send `SIGHUP` (or `systemctl reload tsdmarc`, with the `ExecReload` line above) to reload the configuration file without restarting. The reload happens after the current batch has been processed and saved. These settings are reloaded:

- all outputs (Elasticsearch, OpenSearch, Kafka, S3, Splunk, PostgreSQL, syslog, GELF, webhooks, Log Analytics);
- the multi-tenant `index_prefix_domain_map` (the YAML file is re-read);
- DNS and IP data settings (`nameservers`, `dns_timeout`, `ip_db_path`, `ipinfo_url`, `offline`, …), which also refreshes the IP database, reverse DNS map and PSL overrides;
- processing options (`strip_attachment_payloads`, `batch_size`, `check_timeout`, …);
- log level and log file (`debug`, `verbose`, `warnings`, `silent`, `log_file`).

Mailbox connection settings (IMAP host and credentials, Microsoft Graph, Gmail API, Maildir path) are **not** reloaded; changing them needs a restart.

On a successful reload, the new output clients are created first, and the ones they replace are closed once the new configuration is live.

If the new configuration has an error (a missing setting, an output that can't be reached such as a PostgreSQL server, Kafka broker or TCP/TLS syslog server, an unsupported OpenSearch `auth_type`, an unreadable reverse DNS map, a `log_file` that can't be opened, a non-numeric `batch_size`, …), the **whole reload is aborted**: clients built for it are closed again, and the previous configuration stays fully active. A typo in one section doesn't take down a working setup. Elasticsearch and OpenSearch are the exception to "can't be reached": their clients connect lazily, so an unreachable cluster shows up on the first save instead.

## One-shot runs

Without `watch`, tsdmarc processes the mailbox once and exits, which suits a systemd timer or cron. Note that the `max_unsaved_retries` counters live in memory, so in one-shot runs unsaved messages are simply retried on every run; set `max_unsaved_retries = 0` to move them to `Archive/Unsaved` on the first failure instead.
