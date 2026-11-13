#!/usr/bin/env python3
"""Fill the local Dovecot test server with mail, including messages several years old.

Usage: python3 tests/seed_mail.py [--examples] [host] [port] [user] [password] [bulk_count]

--examples also adds mail that shows the safety features: phishing, a forged
sender, a look-alike address, trackers, unsubscribe and a disguised program.
The automated tests expect the mailbox without them.
"""
import imaplib
import sys
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid

examples = "--examples" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
host = args[0] if len(args) > 0 else "127.0.0.1"
port = int(args[1]) if len(args) > 1 else 3143
user = args[2] if len(args) > 2 else "katy@work.test"
password = args[3] if len(args) > 3 else "pass"
bulk = int(args[4]) if len(args) > 4 else 300

# What a real mail server writes on every message it accepts: the result of its sender checks.
SERVER = "mail.work.test"
PASSED = f"{SERVER}; spf=pass; dkim=pass; dmarc=pass"

now = datetime.now(timezone.utc)
imap = imaplib.IMAP4(host, port)
imap.login(user, password)


def add(folder, when, sender, subject, text, html=None, attachment=None, headers=None, seen=True, checks=PASSED):
    msg = EmailMessage()
    msg["Authentication-Results"] = checks
    msg["From"] = sender
    msg["To"] = f"Katy Reid <{user}>"
    msg["Subject"] = subject
    msg["Date"] = format_datetime(when)
    msg["Message-ID"] = make_msgid(domain="openwren.test")
    for key, value in (headers or {}).items():
        msg[key] = value
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    if attachment:
        name, data = attachment
        msg.add_attachment(data, maintype="application", subtype="pdf", filename=name)
    flags = "(\\Seen)" if seen else None
    stamp = imaplib.Time2Internaldate(time.mktime(when.astimezone().timetuple()))
    status, detail = imap.append(folder, flags, stamp, msg.as_bytes())
    assert status == "OK", detail


def days(n, hour=9, minute=0):
    return (now - timedelta(days=n)).replace(hour=hour, minute=minute, second=0, microsecond=0)


for folder in ("INBOX", "Sent", "Archive"):
    count = int(imap.select(folder)[1][0])
    if count:
        imap.store("1:*", "+FLAGS", "\\Deleted")
        imap.expunge()

add("INBOX", now - timedelta(minutes=30), "Laurence Gilbertson <laurence@contoso.example>",
    "September expense reports", "Hello,\n\nPlease see the updated instructions for expense reports.\n\nLaurence", seen=False)
add("INBOX", now - timedelta(hours=2), "Mona Kane <mona@contoso.example>", "Event announcement content",
    "Hi team,\n\nHere's the draft of the announcement for next week's event.\n\nThanks,\nMona",
    html="<html><body><p>Hi team,</p><p>Here's the <b>draft</b> of the announcement for next week's event. "
         "See <a href=\"https://example.com/event\">the event page</a>.</p>"
         "<img src=\"https://example.com/tracker.png\" width=\"1\" height=\"1\">"
         "<script>alert('should never run')</script><p>Thanks,<br>Mona</p></body></html>",
    attachment=("announcement-draft.pdf", b"%PDF-1.4 test attachment"))
add("INBOX", days(1, 15, 55), "Elvia Atkins <elvia@contoso.example>", "Project tracker design doc",
    "The project tracker is comprehensive and user-friendly.\n\nElvia")
add("INBOX", days(1, 7, 5), "Trainline Deals <deals@news.trainline.example>", "Autumn fares from 19 euros",
    "Book early and save on trips this autumn.", headers={"List-Unsubscribe": "<mailto:unsub@news.trainline.example>"}, seen=False)
add("INBOX", days(3), "=?utf-8?b?U8O4cmVuIMOYc3RlcmfDpXJk?= <soren@nordicprint.example>",
    "Tilbud på tryk – økonomi", "Kære Katy,\n\nHer er tilbuddet på trykopgaven. Smørrebrød på fredag?\n\nSøren")
add("INBOX", days(420), "Nordic Print <billing@nordicprint.example>", "Invoice 2025-0914",
    "Hello Katy,\n\nAttached is your invoice for the September print order. Payment is due within 30 days.",
    attachment=("invoice-0914.pdf", b"%PDF-1.4 invoice"))
add("INBOX", days(1100), "Nordic Print <billing@nordicprint.example>", "Invoice 2023-1102",
    "Hello Katy,\n\nAttached is your invoice for the November print order. Reference zebra-quartz.",
    attachment=("invoice-1102.pdf", b"%PDF-1.4 invoice"))
add("Archive", days(620), "Hosting Support <support@hosting.example>", "Your yearly invoice",
    "Your hosting plan was renewed for another year. The invoice is attached.")
add("Sent", days(360), f"Katy Reid <{user}>", "Re: corrected invoice", "Thanks, the corrected invoice looks right now.")

# Bulk filler spread over about four years, to exercise paging and old-mail search.
for i in range(bulk):
    add("INBOX", days(10 + i * 5, 8 + i % 9, i % 60), f"Newsletter {i % 7} <news{i % 7}@lists.example>",
        f"Weekly digest number {i}", f"This is filler message {i} for testing.",
        headers={"List-Unsubscribe": "<mailto:unsub@lists.example>"})

if examples:
    recent = lambda minutes: now - timedelta(minutes=minutes)
    failed = f"{SERVER}; spf=fail; dkim=fail; dmarc=fail"

    # 1. Classic phishing: a company name on a stranger's address, failed checks, a link that lies.
    add("INBOX", recent(3), "PayPal Security <alerts@paypal-account-check.example>", "Example 1: your account is limited",
        "We noticed unusual activity. Confirm your details at www.paypal.com to restore access.",
        html="<p>We noticed unusual activity on your account.</p>"
             "<p>Confirm your details at <a href=\"https://paypal-account-check.example/login\">www.paypal.com</a> to restore access.</p>",
        checks=failed, seen=False)

    # 2. Forged sender: the real company's address, but the mail server could not confirm it. No logo.
    add("INBOX", recent(5), "PayPal <service@paypal.com>", "Example 2: forged sender address",
        "This message claims to come from service@paypal.com, but the sender checks failed.\n\n"
        "OpenWren warns and shows no PayPal logo.", checks=failed, seen=False)

    # 3. Look-alike address: the first letter is a Cyrillic one. The checks pass, because the
    #    attacker really owns that look-alike name.
    add("INBOX", recent(7), "Apple <no-reply@xn--pple-43d.com>", "Example 3: look-alike address",
        "Your Apple ID was used to sign in on a new device. Review it at https://xn--pple-43d.com/id",
        html="<p>Your Apple ID was used to sign in on a new device.</p>"
             "<p><a href=\"https://xn--pple-43d.com/id\">Review this sign-in</a></p>", seen=False)

    # 4. The sender's name shows a different address than the real one.
    add("INBOX", recent(9), "\"support@netflix.com\" <billing@nf-payments.example>", "Example 4: name shows another address",
        "Your last payment was declined. Update your card to keep watching.", seen=False)

    # 5. Only the link is wrong: it shows one site and leads to another.
    add("INBOX", recent(11), "IT Helpdesk <helpdesk@contoso.example>", "Example 5: link leads somewhere else",
        "Your password expires today. Renew it at portal.work.test",
        html="<p>Your password expires today.</p>"
             "<p>Renew it at <a href=\"https://login.portal-work.example/reset\">portal.work.test</a></p>", seen=False)

    # 6. A program disguised as a document. Opening it is refused; it can only be saved.
    add("INBOX", recent(13), "Accounts <accounts@supplier.example>", "Example 6: program disguised as a PDF",
        "Please find the invoice attached.", attachment=("invoice.pdf.exe", b"MZ not a real program"), seen=False)

    # 7. Genuine, confirmed senders: these get their company logo.
    add("INBOX", recent(15), "GitHub <notifications@github.com>", "Example 7: genuine sender with logo",
        "A new sign-in to your account was detected.\n\nThis message passed the sender checks, so the GitHub logo is shown.")

    # 8. A mailing with trackers and an unsubscribe address (shown under Other).
    add("INBOX", recent(17), "Spotify <no-reply@spotify.com>", "Example 8: trackers and unsubscribe",
        "Your top songs this week are ready.",
        html="<p>Your top songs this week are ready.</p>"
             "<p><a href=\"https://open.spotify.com/playlist/37i9?utm_source=email&utm_campaign=weekly&fbclid=abc\">Open your playlist</a></p>"
             "<img src=\"https://tracking.mailer.example/open?id=42\" width=\"1\" height=\"1\">"
             "<img src=\"https://pixel.mailer.example/p.gif\" style=\"display:none\">",
        headers={"List-Unsubscribe": f"<mailto:unsubscribe@work.test?subject=unsubscribe>"})

    # 9. A mailing whose one-click unsubscribe address points into a private network. The request is refused.
    add("INBOX", recent(19), "Corner Shop News <news@cornershop.example>", "Example 9: unsubscribe address that is refused",
        "This week's offers. The unsubscribe address of this message points to a device on a home network.",
        headers={"List-Unsubscribe": "<https://192.168.1.1/unsubscribe?u=katy>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"})

imap.select("INBOX")
print("INBOX now holds", imap.search(None, "ALL")[1][0].split().__len__(), "messages")
imap.logout()
