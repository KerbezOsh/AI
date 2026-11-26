'use strict';

// Локальный запуск того же приложения, что и на Vercel: node server.js
const http = require('http');
const { handler } = require('./lib/app');

const PORT = Number(process.env.PORT || 7331);
const server = http.createServer((req, res) => handler(req, res));

server.listen(PORT, '127.0.0.1', () => {
  console.log('photonnAI запущен: http://127.0.0.1:' + PORT + '  (остановить: Ctrl+C)');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('Порт ' + PORT + ' занят. Запусти с другим портом: set PORT=7332 && node server.js');
  else console.error(e.message);
  process.exit(1);
});
