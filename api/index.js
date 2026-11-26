'use strict';

// Точка входа для Vercel: все запросы /api/* и /auth/* попадают сюда (см. vercel.json).
const { handler } = require('../lib/app');

module.exports = async (req, res) => handler(req, res);
module.exports.config = { maxDuration: 60 };
