import Database from 'better-sqlite3';
const db = new Database('./data/cc-ledger.db', { readonly: true });
const rows = db
  .prepare(`select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name`)
  .all();
const bad = [];
for (const { name } of rows) {
  const fks = db.prepare(`pragma foreign_key_list("${name}")`).all();
  for (const fk of fks) {
    if (fk.table === 'ledgers' && String(fk.on_delete).toLowerCase() !== 'cascade') {
      bad.push(`${name}.${fk.from} -> ledgers.${fk.to} (on delete ${fk.on_delete})`);
    }
  }
}
console.log('引用 ledgers 但未级联的外键:', bad.length ? '\n  ' + bad.join('\n  ') : '无');
console.log('foreign_keys pragma:', db.pragma('foreign_keys', { simple: true }));
