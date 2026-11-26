'use strict';

// Vercel: сюда попадает весь /api/* (динамический сегмент), и настоящий путь
// остаётся в req.url — никаких rewrite-подстановок не нужно.
const { handler } = require('../lib/app');

module.exports = async (req, res) => handler(req, res);
module.exports.config = { maxDuration: 60 };
