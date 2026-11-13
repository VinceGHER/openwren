#!/usr/bin/env python3
"""A tiny SMTP server for tests. It accepts any sign-in and delivers each
message into the recipient's INBOX on the local Dovecot test server, so a
message sent by OpenWren arrives like real mail.

Usage: python3 tests/smtp_sink.py [smtp_port] [imap_port]
"""
import asyncio
import imaplib
import sys

SMTP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3025
IMAP_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 3143


def deliver(recipient, data):
    imap = imaplib.IMAP4("127.0.0.1", IMAP_PORT)
    imap.login(recipient, "pass")
    imap.append("INBOX", None, None, data)
    imap.logout()


async def handle(reader, writer):
    async def say(line):
        writer.write(line.encode() + b"\r\n")
        await writer.drain()

    recipients = []
    await say("220 openwren test sink")
    while True:
        raw = await reader.readline()
        if not raw:
            break
        line = raw.decode(errors="replace").strip()
        verb = line.split(" ")[0].upper()
        if verb in ("EHLO", "HELO"):
            writer.write(b"250-localhost\r\n250-AUTH PLAIN LOGIN XOAUTH2\r\n250 8BITMIME\r\n")
            await writer.drain()
        elif verb == "AUTH":
            parts = line.split(" ")
            if parts[1].upper() == "LOGIN" and len(parts) == 2:
                await say("334 VXNlcm5hbWU6")
                await reader.readline()
                await say("334 UGFzc3dvcmQ6")
                await reader.readline()
            elif len(parts) == 2:
                await say("334 ")
                await reader.readline()
            await say("235 2.7.0 accepted")
        elif verb == "MAIL":
            recipients = []
            await say("250 ok")
        elif verb == "RCPT":
            address = line.split(":", 1)[1].strip().strip("<>")
            if address.startswith("reject"):
                await say("550 no such user")
            else:
                recipients.append(address)
                await say("250 ok")
        elif verb == "DATA":
            await say("354 go ahead")
            lines = []
            while True:
                part = await reader.readline()
                if part in (b".\r\n", b".\n", b""):
                    break
                lines.append(part[1:] if part.startswith(b"..") else part)
            data = b"".join(lines)
            for recipient in recipients:
                try:
                    await asyncio.to_thread(deliver, recipient, data)
                except Exception as error:  # delivery problems must not kill the sink
                    print("delivery failed:", recipient, error, flush=True)
            await say("250 queued")
        elif verb == "QUIT":
            await say("221 bye")
            break
        elif verb in ("RSET", "NOOP"):
            await say("250 ok")
        else:
            await say("502 not implemented")
    writer.close()


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", SMTP_PORT)
    async with server:
        await server.serve_forever()


asyncio.run(main())
