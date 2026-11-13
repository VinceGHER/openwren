#!/bin/sh
# Start (or restart) the local Dovecot test server and fill it with test mail.
# Ports on 127.0.0.1: 3143 IMAP, 3993 IMAPS (self-signed), 3025 SMTP (test sink).
# Any user can log in with the password "pass".
set -e
cd "$(dirname "$0")"
docker rm -f openwren-dovecot >/dev/null 2>&1 || true
docker run -d --name openwren-dovecot \
  -p 127.0.0.1:3143:143 -p 127.0.0.1:3993:993 -p 127.0.0.1:3110:110 -p 127.0.0.1:3587:587 \
  dovecot/dovecot:2.3-latest >/dev/null
sleep 2
docker exec -i openwren-dovecot sh -c '
  cat > /tmp/extra.conf
  sed -i "/separator = \//r /tmp/extra.conf" /etc/dovecot/dovecot.conf
  echo "disable_plaintext_auth = no" >> /etc/dovecot/dovecot.conf
  doveadm reload' < dovecot-extra.conf
sleep 2
python3 seed_mail.py "$@"
# SMTP test sink: delivers whatever is sent to it into the recipient's inbox.
if ! ss -ltn | grep -q ":3025 "; then
  nohup python3 smtp_sink.py >/dev/null 2>&1 &
fi
