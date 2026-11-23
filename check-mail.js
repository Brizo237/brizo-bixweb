'use strict';
// Run:  node check-mail.js you@gmail.com
// Sends ONE test email through Brevo using the settings in .env and tells you, in plain words, what to fix if it fails.
const path = require('path'), fs = require('fs');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { console.log('No .env file found. Run: node setup.js'); process.exit(1); }
const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM, to = process.argv[2];
if (!key) { console.log('X BREVO_API_KEY is empty in .env'); process.exit(1); }
if (!from) { console.log('X MAIL_FROM is empty in .env (use the sender address you verified in Brevo)'); process.exit(1); }
if (!to) { console.log('Usage: node check-mail.js your-own-email@example.com'); process.exit(1); }
(async () => {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: process.env.MAIL_FROM_NAME || 'BixTech Academy', email: from }, to: [{ email: to }], subject: 'BixTech mail test', textContent: 'If you can read this, Brevo is set up correctly.' }) }).catch((e) => { console.log('X Could not reach Brevo (no internet?):', e.message); process.exit(1); });
  const body = await r.text();
  if (r.ok) return console.log('OK  Sent. Check the inbox (and spam) of ' + to + '. Students will now get their 6-digit codes.');
  console.log('X Brevo answered ' + r.status + ': ' + body.slice(0, 300));
  if (r.status === 401) console.log(/ip/i.test(body) ? 'FIX: Brevo blocked this computer\'s IP. Brevo > Security > Authorised IPs > turn blocking off (or add this IP).' : 'FIX: the API key is wrong. Brevo > SMTP & API > API Keys > create a new v3 key and paste it in .env.');
  else if (r.status === 400 || r.status === 403) console.log('FIX: MAIL_FROM must be a VERIFIED sender. Brevo > Senders, Domains & Dedicated IPs > Senders > Add, then click the link in the email Brevo sends.');
  process.exit(1);
})();
