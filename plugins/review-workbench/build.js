'use strict';
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const inline = source => '(() => {\nconst module = { exports: {} };\n' + source + '\nreturn module.exports;\n})()';
function replace(source, needle, value) {
  if (!source.includes(needle)) throw new Error('Module import not found: ' + needle);
  return source.replace(needle, () => value);
}
let desk = replace(read('desk.js'), "require('./workflow')", inline(read('workflow.js')));
let source = replace(read('main.src.js'), "require('./data')", inline(read('data.js')));
source = replace(source, "require('./desk')", inline(desk));
fs.writeFileSync(path.join(__dirname, 'main.js'), '// Generated from local source modules. Run node build.js to rebuild.\n' + source);
