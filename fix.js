const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf-8');
content = content.replace(/\\`/g, '`');
content = content.replace(/\\\$/g, '$');
fs.writeFileSync('server.js', content, 'utf-8');
console.log('Fixed escaped backticks in server.js');
