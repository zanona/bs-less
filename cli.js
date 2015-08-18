#!/usr/bin/env node
/*jslint node:true*/
console.log('Welcome to BS-Less');
require('./').apply(null, process.argv.splice(2));
