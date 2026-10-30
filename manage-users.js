// Gestión de usuarios:  node manage-users.js add|passwd <usuario>  ·  remove <usuario>  ·  list
// Para uso sin teclado interactivo: PODCAST_PASSWORD=... node manage-users.js add <usuario>
const auth = require('./lib/auth');

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.on('data', (d) => (buf += d)).on('end', () => resolve(buf.split(/\r?\n/)[0]));
      return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let pw = '';
    stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(pw); }
        if (c === '\x03') process.exit(130);
        if (c === '\x7f' || c === '\b') pw = pw.slice(0, -1); else pw += c;
      }
    });
  });
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const users = auth.loadUsers();
  if (cmd === 'list') return console.log(Object.keys(users).join('\n') || '(sin usuarios)');
  if (!name || !/^[\w.-]{1,64}$/.test(name)) {
    console.error('Uso: node manage-users.js add|passwd|remove <usuario>   |   list');
    process.exit(1);
  }
  if (cmd === 'remove') {
    if (!users[name]) { console.error('No existe ese usuario.'); process.exit(1); }
    delete users[name]; auth.saveUsers(users);
    return console.log(`Usuario "${name}" eliminado.`);
  }
  if (cmd !== 'add' && cmd !== 'passwd') { console.error('Comando desconocido.'); process.exit(1); }
  const pw = process.env.PODCAST_PASSWORD ?? (await askHidden('Contraseña (mín. 10 caracteres): '));
  if (pw.length < 10) { console.error('La contraseña debe tener al menos 10 caracteres.'); process.exit(1); }
  auth.setPassword(name, pw);
  console.log(`Usuario "${name}" guardado. Las sesiones anteriores de ese usuario quedan cerradas.`);
}
main();
