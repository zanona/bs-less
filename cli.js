#!/usr/bin/env node
console.log('Welcome to BS-Less');
require('./').apply(null, process.argv.splice(2));
