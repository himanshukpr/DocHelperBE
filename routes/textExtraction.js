const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/upload');
const { extractText } = require('../controllers/textExtraction');

// Image to Text extraction route
router.post('/upload', upload.single('file'), extractText);

module.exports = router;