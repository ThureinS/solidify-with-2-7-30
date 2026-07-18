const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const itemsRoutes = require('./routes/items.routes');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '64kb' }));

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/v1/items', itemsRoutes);

// 404 for any route we haven't defined
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
});

// Always last: formats every error into the single standard shape
app.use(errorHandler);

module.exports = app;
