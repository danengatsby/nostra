#!/usr/bin/env node
'use strict';
// Creează sau schimbă contul de administrare (pagina de statistici /admin).
//
//   npm run admin-cont                    întreabă utilizatorul și parola (parola nu apare pe ecran)
//   npm run admin-cont -- --generate      generează o parolă puternică și o afișează o singură dată
//   opțional: --user <nume>   --env <fișier .env>
//
// În .env se scriu ADMIN_USER și ADMIN_PASSWORD_HASH (amprenta scrypt, nu parola); vechea ADMIN_PASSWORD în clar
// se șterge. Sesiunile deschise cu parola veche se închid. După rulare: sudo systemctl restart nostra

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { hashPassword } = require('../lib/adminauth');

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const envFile = path.resolve(option('--env') || path.join(__dirname, '..', '.env'));
const USER_RE = /^[a-z0-9._-]{3,40}$/;

function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // fără caractere ușor de confundat
  const chars = Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/** Scrie ADMIN_USER și ADMIN_PASSWORD_HASH, șterge ADMIN_PASSWORD; restul fișierului rămâne neschimbat. */
function saveAccount(file, user, hash) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const kept = lines.filter((l) => !/^\s*(ADMIN_USER|ADMIN_PASSWORD_HASH|ADMIN_PASSWORD)\s*=/.test(l));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  kept.push(`ADMIN_USER=${user}`, `ADMIN_PASSWORD_HASH=${hash}`, '');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, kept.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function main() {
  let user = (option('--user') || (args.includes('--generate') ? 'admin' : await ask('Utilizator [admin]: ')) || 'admin').trim().toLowerCase();
  if (!USER_RE.test(user)) throw new Error('Utilizatorul poate avea 3–40 de caractere: litere mici, cifre, punct, minus sau _.');
  let password;
  if (args.includes('--generate')) {
    password = generatePassword();
  } else {
    password = await ask('Parola nouă (cel puțin 10 caractere): ', true);
    if (password.length < 10) throw new Error('Parola trebuie să aibă cel puțin 10 caractere.');
    if (password.length > 200) throw new Error('Parola poate avea cel mult 200 de caractere.');
    if ((await ask('Repetă parola: ', true)) !== password) throw new Error('Parolele nu coincid.');
  }
  saveAccount(envFile, user, hashPassword(password));
  console.log(`Contul de administrare „${user}” a fost salvat în ${envFile}.`);
  if (args.includes('--generate')) console.log(`Parola (afișată o singură dată, păstreaz-o): ${password}`);
  console.log('Pentru a-l activa: sudo systemctl restart nostra');
}

main().catch((e) => {
  console.error(`Eroare: ${e.message}`);
  process.exit(1);
});
