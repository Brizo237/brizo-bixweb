'use strict';
// Run once:  node setup.js   -> creates .env with a fresh random SESSION_SECRET.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const env = path.join(__dirname, '.env');
if (fs.existsSync(env)) {
  console.log('.env already exists, leaving it alone. Edit it to add your OAuth credentials.');
} else {
  const secret = crypto.randomBytes(48).toString('base64url');
  const text = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8').replace(/^SESSION_SECRET=.*$/m, 'SESSION_SECRET=' + secret);
  fs.writeFileSync(env, text, { mode: 0o600 });
  console.log('Created .env with a new SESSION_SECRET.\nNext: open .env, add the credentials for the providers you want, then run:  node server.js');
}
