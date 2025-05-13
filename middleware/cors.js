const cors = require('cors');

// CORS configuration middleware
const corsMiddleware = cors({
  origin: 'http://localhost:5173',
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});

module.exports = {
  corsMiddleware
};