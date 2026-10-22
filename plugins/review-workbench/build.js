'use strict';
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'main.src.js'), 'utf8');
const data = fs.readFileSync(path.join(__dirname, 'data.js'), 'utf8');
const needle = "const { parseNote, summarize, filterRecords, scanMarkdown } = require('./data');";
if (!source.includes(needle)) throw new Error('Data import not found; refusing to overwrite plugin entry.');
const bundled = source.replace(needle, () => 'const { parseNote, summarize, filterRecords, scanMarkdown } = (() => {\nconst module = { exports: {} };\n' + data + '\nreturn module.exports;\n})();');
fs.writeFileSync(path.join(__dirname, 'main.js'), '// Generated from main.src.js + data.js. Run node build.js to rebuild.\n' + bundled);
