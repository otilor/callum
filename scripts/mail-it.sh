#!/usr/bin/env bash
# Runs the email adapter integration test against a real local GreenMail SMTP + IMAP server.
# Needs Java, and network access the first time (to download the GreenMail jar).
set -euo pipefail

cd "$(dirname "$0")/.."

JAR=".cache/greenmail.jar"
LOG=".cache/greenmail.log"
URL="https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/2.1.3/greenmail-standalone-2.1.3.jar"
SMTP_PORT="${CALLUM_MAIL_SMTP_PORT:-3025}"
IMAP_PORT="${CALLUM_MAIL_IMAP_PORT:-3143}"

mkdir -p .cache
if [ ! -s "$JAR" ]; then
  echo "Downloading GreenMail 2.1.3"
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o "$JAR.part" "$URL"
  mv "$JAR.part" "$JAR"
fi

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if port_open "$SMTP_PORT" || port_open "$IMAP_PORT"; then
  echo "Port $SMTP_PORT or $IMAP_PORT is already in use. Stop that server first." >&2
  exit 1
fi

java \
  "-Dgreenmail.setup.test.smtp" "-Dgreenmail.setup.test.imap" \
  "-Dgreenmail.users=you:secret@yourcompany.test,kemi:secret@okopay.test" \
  "-Dgreenmail.users.login=email" \
  "-Dgreenmail.hostname=127.0.0.1" \
  -jar "$JAR" >"$LOG" 2>&1 &
GREENMAIL_PID=$!
trap 'kill "$GREENMAIL_PID" 2>/dev/null || true; wait "$GREENMAIL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  if port_open "$SMTP_PORT" && port_open "$IMAP_PORT"; then break; fi
  if ! kill -0 "$GREENMAIL_PID" 2>/dev/null; then
    echo "GreenMail stopped early. Log:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.3
done
if ! (port_open "$SMTP_PORT" && port_open "$IMAP_PORT"); then
  echo "GreenMail did not open ports $SMTP_PORT and $IMAP_PORT in time. Log:" >&2
  cat "$LOG" >&2
  exit 1
fi
echo "GreenMail is listening on SMTP $SMTP_PORT and IMAP $IMAP_PORT"

CALLUM_MAIL_IT=1 CALLUM_MAIL_SMTP_PORT="$SMTP_PORT" CALLUM_MAIL_IMAP_PORT="$IMAP_PORT" \
  npx vitest run src/server/channels/email.integration.test.ts "$@"
