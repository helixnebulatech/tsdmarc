---
title: DavMail (Exchange via OWA/EWS)
description: Read reports from an Exchange mailbox that only allows OWA/EWS, using DavMail as a local IMAP gateway.
---

:::tip
For Microsoft 365, use the [Microsoft Graph mailbox](../../guides/mailboxes/#microsoft-graph-microsoft-365) instead: it needs no gateway.
:::

Some organizations allow neither IMAP nor the Microsoft Graph API, only Exchange Web Services (EWS) / Outlook Web Access (OWA). In that case, set up [DavMail](https://davmail.sourceforge.net/) as a local EWS/OWA-to-IMAP gateway. It can even work where [modern authentication / MFA](https://davmail.sourceforge.net/faq.html) is required.

## Installing DavMail

Download the latest `davmail-<version>.zip` from [SourceForge](https://sourceforge.net/projects/davmail/files/), extract it (for example to `/opt/davmail`) and install Java:

```sh
sudo apt-get install default-jre-headless
```

Create `davmail.properties`:

```properties
# DavMail settings, see http://davmail.sourceforge.net/ for documentation

#############################################################
# Basic settings

# Server or workstation mode
davmail.server=true

# connection mode auto, EWS or WebDav
davmail.enableEws=auto

# base Exchange OWA or EWS url
davmail.url=https://outlook.office365.com/EWS/Exchange.asmx

# Listener ports
davmail.imapPort=1143

#############################################################
# Network settings

# Network proxy settings
davmail.enableProxy=false
davmail.useSystemProxies=false
davmail.proxyHost=
davmail.proxyPort=
davmail.proxyUser=
davmail.proxyPassword=

# proxy exclude list
davmail.noProxyFor=

# block remote connection to DavMail
davmail.allowRemote=false

# bind server sockets to the loopback address
davmail.bindAddress=127.0.0.1

# disable SSL for specified listeners
davmail.ssl.nosecureimap=true

# Send keepalive character during large folder and messages download
davmail.enableKeepalive=true

# Message count limit on folder retrieval
davmail.folderSizeLimit=0

#############################################################
# IMAP settings

# Delete messages immediately on IMAP STORE \Deleted flag
davmail.imapAutoExpunge=true

# Enable IDLE support, set polling delay in minutes
davmail.imapIdleDelay=1

# Always reply to IMAP RFC822.SIZE requests with Exchange approximate
# message size for performance reasons
davmail.imapAlwaysApproxMsgSize=true

# Client connection timeout in seconds - default 300, 0 to disable
davmail.clientSoTimeout=0

#############################################################
```

## Running DavMail as a systemd service

Create a system user and protect the configuration file:

```sh
sudo useradd davmail -r -s /bin/false
sudo chown root:davmail /opt/davmail/davmail.properties
sudo chmod u=rw,g=r,o= /opt/davmail/davmail.properties
```

Create `/etc/systemd/system/davmail.service`:

```ini
[Unit]
Description=DavMail gateway service
Documentation=https://sourceforge.net/projects/davmail/
Wants=network-online.target
After=syslog.target network.target

[Service]
ExecStart=/opt/davmail/davmail /opt/davmail/davmail.properties
User=davmail
Group=davmail
Restart=always
RestartSec=5m

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now davmail.service
```

Restart it after every DavMail upgrade (`sudo systemctl restart davmail`), and check its logs with `journalctl -u davmail.service -r`.

## Configuring tsdmarc for DavMail

DavMail listens without TLS on the loopback interface (`127.0.0.1`). tsdmarc, like parsedmarc 11.2.1, refuses to send a password over a connection that wasn't upgraded with STARTTLS, so allow it explicitly for this local gateway with `starttls = False`:

```ini
[imap]
host = 127.0.0.1
port = 1143
ssl = False
starttls = False
user = dmarc@example.com
password = ...

[mailbox]
watch = True
```

:::caution
The DavMail configuration above runs its IMAP listener without TLS (`davmail.ssl.nosecureimap=true`). Only set `starttls = False` when DavMail listens on the loopback address only (`davmail.bindAddress` set to the loopback address and `davmail.allowRemote=false`, as above). A warning is logged at startup whenever it is set with `ssl = False`.
:::

---

Adapted from [parsedmarc's documentation](https://domainaware.github.io/parsedmarc/davmail.html) (Apache-2.0).
