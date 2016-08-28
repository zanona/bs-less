#!/usr/bin/env node
console.log('Welcome to BS-Less');
const opts = {};

process.argv.forEach((opt) => {
  if (!opt.match(/^-+/)) return;
  const kv = opt.split('='),
        k = kv[0].replace(/-+/, '').trim(),
        v = kv[1].trim();
  opts[k] = v;
});

require('./')(process.argv.splice(2)[0], opts);
