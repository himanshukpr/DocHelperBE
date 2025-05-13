// Modern URL handling without punycode
const { URL } = require('url'); 

const express = require('express');
const path = require('path');
const fsp = require('fs').promises;
const app = express();
const port = 8000;

// Import middleware
const { corsMiddleware } = require('./middleware/cors');
const { uploadDir } = require('./middleware/upload');

// Import routes
const healthRoutes = require('./routes/health');
const textExtractionRoutes = require('./routes/textExtraction');
const pdfOperationRoutes = require('./routes/pdfOperations');

// Import controllers for direct routes
const { downloadFile } = require('./controllers/pdfOperations');

// Use CORS middleware
app.use(corsMiddleware);

// Handle preflight requests
app.options('*', corsMiddleware);

// Serve static files from uploads directory with absolute path
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.pdf')) {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      res.set('Cache-Control', 'no-store');
    }
  },
  fallthrough: false // Don't continue to next middleware if file not found
}));

// Ensure uploads directory exists with absolute path
(async () => {
  try {
    await fsp.mkdir(uploadDir, { recursive: true });
  } catch (err) {
    console.error('Error creating uploads directory:', err);
  }
})();

app.use(express.json());

// Register routes
app.use('/health', healthRoutes);
app.use('/', textExtractionRoutes);
app.use('/api', pdfOperationRoutes);

// Add direct download route for backward compatibility
app.get('/download', downloadFile);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
}).on('error', (err) => {
  console.error('Server failed to start:', err);
});
