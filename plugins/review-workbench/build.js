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
const journey = replace(read('journey.js'), "require('./workflow')", inline(read('workflow.js')));
desk = replace(desk, "require('./journey')", inline(journey));
desk = replace(desk, "'__ZHIXING_HERO_DATA_URL__'", JSON.stringify('data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets/quest-world.png')).toString('base64')));
let source = replace(read('main.src.js'), "require('./data')", inline(read('data.js')));
source = replace(source, "require('./desk')", inline(desk));
fs.writeFileSync(path.join(__dirname, 'main.js'), '// Generated from local source modules. Run node build.js to rebuild.\n' + source);
