const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const authRoutes = require('./routes/auth.routes');
const itemsRoutes = require('./routes/items.routes');
const adminRoutes = require('./routes/admin.routes');
const exportRoutes = require('./routes/export.routes');
const { errorHandler } = require('./middleware/errorHandler');

const openapiDocument = yaml.load(fs.readFileSync(path.join(__dirname, '../openapi.yaml'), 'utf8'));

const app = express();

app.use(morgan('dev'));
app.use(express.json({ limit: '64kb' }));

// Swagger UI renders inline <script>/<style> tags that helmet's default
// Content-Security-Policy would block. Mounted before the global helmet()
// below so this route only ever gets the relaxed instance -- once helmet()
// has already set the strict CSP header for a request, a second helmet
// call further down the chain can't un-set it.
app.use('/api/v1/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openapiDocument));

app.use(helmet());

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/items', itemsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/export', exportRoutes);

// 404 for any route we haven't defined
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
});

// Always last: formats every error into the single standard shape
app.use(errorHandler);

module.exports = app;
