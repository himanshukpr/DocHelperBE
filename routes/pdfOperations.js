const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/upload');
const { 
  listMergedPDFs, 
  mergePDFs, 
  splitPDF, 
  downloadFile,
  compressPDF,
  imageToPDF,
  pdfToImage,
  protectPDF,
  unprotectPDF // Add the unprotect function
} = require('../controllers/pdfOperations');

// List merged PDFs route
router.get('/merged-pdfs', listMergedPDFs);

// PDF Merge route
router.post('/merge-pdfs', upload.array('pdfs'), mergePDFs);

// PDF Split route
router.post('/split-pdf', upload.single('pdf'), splitPDF);

// PDF Compression route
router.post('/compress-pdf', upload.single('pdf'), compressPDF);

// Image to PDF route
router.post('/image-to-pdf', upload.array('images'), imageToPDF);

// PDF to Image route
router.post('/pdf-to-image', upload.single('pdf'), pdfToImage);

// Protect PDF route
router.post('/protect-pdf', upload.single('pdf'), protectPDF);

// Unprotect PDF route
router.post('/unprotect-pdf', upload.single('pdf'), unprotectPDF);

// PDF Download route
router.get('/download', downloadFile);

module.exports = router;