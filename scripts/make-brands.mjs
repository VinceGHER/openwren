// Writes src/lib/brandIcons.ts: logos of well-known senders, taken from the
// Simple Icons set (CC0), each with the mail domains it may be shown for.
// Run with `node scripts/make-brands.mjs` after changing the list below.
//
// A logo is only ever shown for these exact domains (and their subdomains),
// never by sender name, so a look-alike sender cannot borrow one.
// Addresses that people use personally (gmail.com, icloud.com, proton.me, ...)
// are left out on purpose: those senders keep their initials.
import { writeFileSync } from "node:fs";
import * as icons from "simple-icons";

const list = `
google google.com youtube.com:youtube
youtube youtube.com
apple apple.com
facebook facebook.com facebookmail.com
instagram instagram.com
whatsapp whatsapp.com
meta meta.com
x x.com twitter.com
github github.com
gitlab gitlab.com
bitbucket bitbucket.org
atlassian atlassian.com atlassian.net
discord discord.com discordapp.com
zoom zoom.us zoom.com
dropbox dropbox.com dropboxmail.com
notion notion.so notion.com makenotion.com
figma figma.com
spotify spotify.com
netflix netflix.com
paypal paypal.com paypal.co.uk paypal.de paypal.fr paypal.nl paypal.it paypal.es
stripe stripe.com
wise wise.com
revolut revolut.com
klarna klarna.com
airbnb airbnb.com
bookingdotcom booking.com
uber uber.com
lyft lyft.com
tesla tesla.com
ebay ebay.com ebay.co.uk ebay.de ebay.fr ebay.it ebay.es ebay.nl
etsy etsy.com
shopify shopify.com
aliexpress aliexpress.com
alibabadotcom alibaba.com
zalando zalando.com zalando.de zalando.fr zalando.nl zalando.co.uk zalando.it zalando.es
ikea ikea.com
nike nike.com
adidas adidas.com
samsung samsung.com
sony sony.com
playstation playstation.com
steam steampowered.com
epicgames epicgames.com
twitch twitch.tv
reddit reddit.com redditmail.com
pinterest pinterest.com
snapchat snapchat.com
tiktok tiktok.com
telegram telegram.org
signal signal.org
medium medium.com
substack substack.com
wordpress wordpress.com
squarespace squarespace.com
wix wix.com
mailchimp mailchimp.com
hubspot hubspot.com
zendesk zendesk.com
intercom intercom.com
cloudflare cloudflare.com
digitalocean digitalocean.com
vercel vercel.com
netlify netlify.com
docker docker.com
npm npmjs.com
stackoverflow stackoverflow.com stackoverflow.email
intel intel.com
nvidia nvidia.com
amd amd.com
dell dell.com
hp hp.com
lenovo lenovo.com
asus asus.com
cisco cisco.com
redhat redhat.com
ubuntu ubuntu.com canonical.com
debian debian.org
mozilla mozilla.org mozilla.com
brave brave.com
duckduckgo duckduckgo.com
anthropic anthropic.com
huggingface huggingface.co
duolingo duolingo.com
coursera coursera.org
udemy udemy.com
khanacademy khanacademy.org
trello trello.com
asana asana.com
clickup clickup.com
linear linear.app
miro miro.com
airtable airtable.com
zapier zapier.com
typeform typeform.com
calendly calendly.com
xero xero.com
quickbooks quickbooks.com
intuit intuit.com
visa visa.com
mastercard mastercard.com
americanexpress americanexpress.com aexp.com
coinbase coinbase.com
binance binance.com
robinhood robinhood.com
n26 n26.com
bunq bunq.com
deutschebank db.com deutsche-bank.de
bankofamerica bankofamerica.com
chase chase.com
wellsfargo wellsfargo.com
hsbc hsbc.com hsbc.co.uk hsbc.fr
barclays barclays.com barclays.co.uk
dhl dhl.com dhl.de
fedex fedex.com
ups ups.com
usps usps.com
dpd dpd.com dpd.de dpd.co.uk dpd.fr
lufthansa lufthansa.com
ryanair ryanair.com
easyjet easyjet.com
klm klm.com
airfrance airfrance.com airfrance.fr
britishairways britishairways.com ba.com
emirates emirates.com
delta delta.com
americanairlines aa.com
unitedairlines united.com
tripadvisor tripadvisor.com
expedia expedia.com
deliveroo deliveroo.com deliveroo.co.uk deliveroo.fr
doordash doordash.com
justeat just-eat.com just-eat.co.uk justeat.com
mcdonalds mcdonalds.com
starbucks starbucks.com
cocacola coca-cola.com
hbo hbo.com
soundcloud soundcloud.com
deezer deezer.com
tidal tidal.com
audible audible.com
goodreads goodreads.com
imdb imdb.com
wikipedia wikipedia.org wikimedia.org
quora quora.com
glassdoor glassdoor.com
indeed indeed.com
upwork upwork.com
fiverr fiverr.com
patreon patreon.com
kickstarter kickstarter.com
gofundme gofundme.com
strava strava.com
fitbit fitbit.com
garmin garmin.com
peloton onepeloton.com
headspace headspace.com
bitwarden bitwarden.com
1password 1password.com
lastpass lastpass.com
nordvpn nordvpn.com
expressvpn expressvpn.com
mullvad mullvad.net
ovh ovh.com ovhcloud.com ovh.net
hetzner hetzner.com
scaleway scaleway.com
godaddy godaddy.com
namecheap namecheap.com
gandi gandi.net
letsencrypt letsencrypt.org
sentry sentry.io
datadog datadoghq.com
grafana grafana.com
newrelic newrelic.com
pagerduty pagerduty.com
circleci circleci.com
jetbrains jetbrains.com
postman postman.com
mongodb mongodb.com
snowflake snowflake.com
databricks databricks.com
unsplash unsplash.com
dribbble dribbble.com
behance behance.net
vimeo vimeo.com
bandcamp bandcamp.com
vodafone vodafone.com vodafone.de vodafone.co.uk vodafone.nl
orange orange.fr orange.com
verizon verizon.com
o2 o2.co.uk o2online.de
threema threema.ch
line line.me
webex webex.com
sncf sncf.com sncf-connect.com
carrefour carrefour.fr carrefour.com
auchan auchan.fr
fnac fnac.com
lidl lidl.com lidl.de lidl.fr lidl.co.uk lidl.nl
tesco tesco.com
target target.com
`;

const out = [];
const missing = [];
for (const line of list.trim().split("\n")) {
  const [slug, ...domains] = line.trim().split(/\s+/).map((d) => d.split(":")[0]);
  const icon = icons[`si${slug[0].toUpperCase()}${slug.slice(1)}`];
  if (!icon) missing.push(slug);
  else out.push({ title: icon.title, hex: icon.hex, path: icon.path, domains });
}
// One domain, one logo: the first brand listed wins.
const seen = new Set();
for (const brand of out) brand.domains = brand.domains.filter((d) => !seen.has(d) && seen.add(d));

writeFileSync(
  new URL("../src/lib/brandIcons.ts", import.meta.url),
  `// Generated by scripts/make-brands.mjs from the Simple Icons set (CC0 1.0). Do not edit by hand.
// The logos are trademarks of their owners and are shown only to identify the sender.

export interface Brand {
  title: string;
  /** Brand colour, without the #. */
  hex: string;
  /** SVG path on a 24 by 24 grid. */
  path: string;
  /** Mail domains this logo may be shown for; subdomains are included. */
  domains: string[];
}

export const brands: Brand[] = ${JSON.stringify(out, null, 1)};
`,
);
console.log(`${out.length} brands written` + (missing.length ? `; not in Simple Icons: ${missing.join(", ")}` : ""));
