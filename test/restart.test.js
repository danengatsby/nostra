'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('backupul unei lucrări în curs se restaurează și se termină sub același ID', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const restore = path.join(root, 'restore');
  fs.mkdirSync(restore);
  fs.writeFileSync(path.join(root, '.env'), 'DEMO_MODE=1\n');
  const env = { ...process.env, NODE_ENV: 'test', DEMO_MODE: '1', DEMO_STEP_MS: '5000',
    DATA_DIR: path.join(root, 'data'), NOSTRA_APP_DIR: root, BACKUP_DIR: path.join(root, 'copies'),
    BACKUP_SSH_DEST: '', BACKUP_GPG_RECIPIENT: '' };
  const id = execFileSync(process.execPath, ['-e', `
    require('./lib/store').init();
    const req = {domain:'sport', region:'global', lang:'ro', horizon:'1m', question:'Recuperare'};
    const {id} = require('./lib/jobs').submit(req, '127.0.0.1');
    require('fs').writeSync(1, id);
    process.exit();
  `], { env, encoding: 'utf8' });
  execFileSync('sh', ['deploy/backup.sh'], { env });
  const [archive] = fs.readdirSync(env.BACKUP_DIR);
  execFileSync('tar', ['-xzf', path.join(env.BACKUP_DIR, archive), '-C', restore]);
  env.DATA_DIR = path.join(restore, 'data');
  env.DEMO_STEP_MS = '1';
  execFileSync(process.execPath, ['-e', `
    const jobs = require('./lib/jobs');
    require('./lib/store').init(); jobs.recover();
    jobs.get(process.argv[1]).bus.on('event', event => { if (event.type === 'error') process.exitCode = 1; });
  `, id], { env, timeout: 5000 });
  const saved = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, 'predictions', id + '.json')));
  assert.equal(saved.id, id);
  assert.equal(saved.request.question, 'Recuperare');
  assert.equal(execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./lib/operations').backlog().length))"], {env, encoding:'utf8'}), '0');
});
