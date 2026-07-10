const WebSocket = require('ws');

const ws = new WebSocket('wss://storage.lootops.me/terminal?token=fake');

ws.on('open', function open() {
  console.log('Connected to wss://server.lootops.me/terminal!');
  process.exit(0);
});

ws.on('error', function error(err) {
  console.error('WebSocket Error:', err.message);
  process.exit(1);
});

ws.on('unexpected-response', function(req, res) {
  console.error('Unexpected response:', res.statusCode);
  process.exit(1);
});
